'use strict';

// Safe Git worktree management for AI implementation and review agents.
//
// Every command is read-only by default except create and remove, and both of
// those refuse anything the tool does not recognise as its own. The ownership
// marker is an accident guard rather than an authenticator: it lives inside the
// directory it describes and holds no secret, so the guards that actually bound
// a removal are Git registration, cleanliness, branch reachability, and the
// non-forced git worktree remove. See ADR-011. This module never
// launches an AI client, never deletes a foreign or dirty directory, never
// force-removes a worktree, and never deletes a branch.

const path = require('node:path');
const core = require('./automation-core.cjs');
const doctor = require('./doctor.cjs');

const {
  AutomationError, EXIT_OK, EXIT_VALIDATION, EXIT_BLOCKED, EXIT_USAGE, EXIT_INTERNAL,
  SAFE_NAME, FULL_SHA, OWNER_MARKER
} = core;

const WORKTREE_PARENT = '.worktrees';
const ROLES = Object.freeze(['claude', 'codex', 'review']);
const IMPLEMENTATION_ROLES = Object.freeze(['claude', 'codex']);
const RUNTIME_OPERATIONS = Object.freeze(['database-reset', 'runtime-smoke', 'smoke-provisioning']);

const USAGE = [
  'Usage: node scripts/dev/agent-worktree.cjs <command> [options]',
  '',
  'Commands:',
  '  create    Create an owned worktree for an agent role.',
  '  list      List owned and foreign worktrees of this repository.',
  '  inspect   Report one worktree in detail.',
  '  remove    Remove an owned, clean worktree. Never deletes a branch.',
  '  prune     Inspect stale Git worktree metadata and prune it when safe.',
  '',
  'Options:',
  '  --name <name>     Logical worktree name (claude, codex, review, or a safe custom name).',
  '  --role <role>     claude | codex | review. Defaults to --name when it is a known role.',
  '  --branch <branch> feature/, fix/, or docs/ branch for an implementation worktree.',
  '  --ref <ref>       Commit-ish for a detached review worktree.',
  '  --read-only       Documented convention for review worktrees. Not OS-enforced.',
  '  --create-branch   Allow creating the branch when it does not exist yet.',
  '  --parent <path>   Advanced: absolute worktree parent outside the repository.',
  '                    Defaults to <repository-parent>/.worktrees/<repository-name>.',
  '  --json            Emit the versioned JSON result only.',
  '  --help, -h        Show this help.',
  '',
  'Worktree management never launches an AI client, never deletes a branch,',
  'never force-removes a worktree, and never deletes untracked or foreign files.'
].join('\n');

function parseArgs(argv) {
  const input = Array.from(argv || []);
  if (!input.length) throw core.usageError('COMMAND_REQUIRED', 'A command is required.');
  if (input[0] === '--help' || input[0] === '-h') {
    return Object.freeze({ help: true, command: null, json: false });
  }
  const command = String(input.shift()).toLowerCase();
  if (!['create', 'list', 'inspect', 'remove', 'prune'].includes(command)) {
    throw core.usageError('COMMAND_INVALID', `Unknown command ${core.quoteUntrusted(command)}.`);
  }
  const options = {
    help: false, command, json: false, readOnly: false, createBranch: false,
    name: null, role: null, branch: null, ref: null, parent: null
  };
  while (input.length) {
    const argument = String(input.shift());
    if (argument === '--json') options.json = true;
    else if (argument === '--read-only') options.readOnly = true;
    else if (argument === '--create-branch') options.createBranch = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (['--name', '--role', '--branch', '--ref', '--parent'].includes(argument)) {
      if (!input.length) throw core.usageError('OPTION_VALUE_REQUIRED', `Option ${argument} requires a value.`);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = String(input.shift());
    } else throw core.usageError('OPTION_INVALID', `Unknown option ${core.quoteUntrusted(argument)}.`);
  }
  if (options.branch && options.ref) {
    throw core.usageError('REF_CONFLICT', '--branch and --ref are mutually exclusive.');
  }
  return Object.freeze(options);
}

function resolveName(options) {
  const name = String(options.name || '').trim();
  if (!name) throw core.usageError('NAME_REQUIRED', '--name is required.');
  if (!SAFE_NAME.test(name)) {
    throw core.usageError('NAME_INVALID', 'Worktree names must match ^[a-z0-9][a-z0-9_-]{0,39}$.');
  }
  return name;
}

function resolveRole(options, name) {
  const role = String(options.role || (ROLES.includes(name) ? name : '')).trim();
  if (!role) throw core.usageError('ROLE_REQUIRED', `--role is required for a custom name; expected one of ${ROLES.join(', ')}.`);
  if (!ROLES.includes(role)) throw core.usageError('ROLE_INVALID', `Unknown role ${core.quoteUntrusted(role)}.`);
  return role;
}

/* ==================== location ==================== */

// Worktrees live beside the repository, never inside it, so the primary working
// tree can never see them as untracked content.
function resolveWorktreeParent(deps, repositoryRoot, override) {
  // Validate the caller's raw text first. path.resolve would silently collapse
  // "..", so checking only the resolved form would never see a traversal.
  if (override !== null && override !== undefined) {
    core.assertNoTraversal(override, 'WORKTREE_PARENT_UNSAFE');
    core.assertOrdinaryAbsolutePath(override, 'WORKTREE_PARENT_UNSAFE', deps.platform);
  }
  const parent = override
    ? path.resolve(override)
    : path.join(path.dirname(repositoryRoot), WORKTREE_PARENT, path.basename(repositoryRoot));
  core.assertOrdinaryAbsolutePath(parent, 'WORKTREE_PARENT_UNSAFE', deps.platform);
  core.assertNoTraversal(parent, 'WORKTREE_PARENT_UNSAFE');
  if (core.pathIsInside(repositoryRoot, parent)) {
    throw new AutomationError('WORKTREE_PARENT_INSIDE_REPOSITORY',
      'Refusing a worktree parent inside the primary working tree.', EXIT_BLOCKED);
  }
  return parent;
}

function resolveWorktreePath(deps, parent, name) {
  const target = path.join(parent, name);
  core.assertNoTraversal(target, 'WORKTREE_PATH_UNSAFE');
  if (!core.pathIsInside(parent, target)) {
    throw new AutomationError('WORKTREE_PATH_ESCAPE', 'Worktree path escapes its parent directory.', EXIT_BLOCKED);
  }
  return target;
}

// The shared runtime lock is held for the whole repository family, so it lives
// beside the worktree parent rather than inside any single worktree. Every
// command must derive it from the same resolved parent: a family root computed
// one way by create and another way by remove would make a live lock invisible
// to the command that has to refuse because of it.
function familyRoot(deps, worktreeParent) {
  const parent = path.dirname(path.resolve(worktreeParent));
  try {
    return core.canonicalDirectory(deps, parent, 'WORKTREE_FAMILY_UNSAFE');
  } catch {
    // The family root does not exist yet, which simply means no lock can be
    // held there. The resolved path is the right answer for reporting.
    return parent;
  }
}

/* ==================== repository context ==================== */

function resolveRepository(deps) {
  const root = core.gitText(deps, ['rev-parse', '--show-toplevel'], 'REPOSITORY_UNAVAILABLE', { cwd: deps.repositoryRoot });
  const resolved = core.canonicalDirectory(deps, path.resolve(root), 'REPOSITORY_UNAVAILABLE');
  let metadata;
  try {
    metadata = JSON.parse(deps.fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'));
  } catch {
    throw new AutomationError('REPOSITORY_IDENTITY_INVALID', 'Repository package.json is missing or invalid.', EXIT_BLOCKED);
  }
  if (!metadata || metadata.name !== doctor.PACKAGE_NAME) {
    throw new AutomationError('REPOSITORY_IDENTITY_INVALID', `Expected package ${core.quoteUntrusted(doctor.PACKAGE_NAME)}.`, EXIT_BLOCKED);
  }
  return Object.freeze({ root: resolved, identity: core.repositoryIdentity(deps, resolved) });
}

function branchCheckedOutElsewhere(worktrees, branch) {
  return worktrees.find(entry => core.shortBranch(entry.branch) === branch) || null;
}

/* ==================== inventory ==================== */

function describeWorktree(deps, repository, entry, options = {}) {
  const isPrimary = core.samePath(entry.path, repository.root, deps.platform);
  const ownership = isPrimary
    ? { ok: false, code: 'PRIMARY_WORKING_TREE', reason: 'This is the primary working tree, not an owned automation worktree.' }
    : core.verifyOwnership(deps, entry.path, { repositoryIdentity: repository.identity, path: entry.path });
  const record = {
    name: ownership.ok ? ownership.marker.name : path.basename(entry.path),
    role: ownership.ok ? ownership.marker.role : null,
    path: entry.path,
    primary: isPrimary,
    branch: core.shortBranch(entry.branch),
    detached: entry.detached,
    head: entry.head,
    locked: entry.locked,
    prunable: entry.prunable,
    owned: ownership.ok,
    ownershipCode: ownership.ok ? null : ownership.code,
    createdAt: ownership.ok ? ownership.marker.createdAt || null : null,
    readOnlyConvention: ownership.ok ? Boolean(ownership.marker.readOnly) : null,
    trackedChanges: null,
    untrackedCount: null,
    clean: null,
    operationsInProgress: null
  };
  if (options.withState && !entry.prunable && core.pathExists(deps, entry.path)) {
    try {
      const state = core.readRepositoryState(deps, entry.path);
      // The owner marker is written by this tool, so it must not make an
      // otherwise untouched worktree report as dirty.
      const foreign = state.untracked.filter(value => value !== OWNER_MARKER && !value.startsWith(`${OWNER_MARKER}/`));
      record.trackedChanges = state.trackedChanges;
      record.untrackedCount = foreign.length;
      record.clean = state.trackedChanges === 0 && foreign.length === 0;
      record.operationsInProgress = state.operationsInProgress;
      record.head = state.head || record.head;
    } catch (error) {
      record.stateError = error.code || 'WORKTREE_STATE_UNAVAILABLE';
    }
  }
  return Object.freeze(record);
}

function runtimeLockReport(deps, family) {
  return Object.freeze(RUNTIME_OPERATIONS.map(operation => {
    const lock = core.inspectRuntimeLock(deps, family, operation);
    return Object.freeze({ operation, held: lock.held, live: lock.live, stale: lock.stale, pid: lock.pid, ownerWorktree: lock.ownerWorktree });
  }).filter(entry => entry.held));
}

/* ==================== create ==================== */

function assertCreatePreconditions(deps, repository, options, name, role, worktrees) {
  const primary = core.readRepositoryState(deps, repository.root);
  if (primary.indexLocked) {
    throw new AutomationError('GIT_INDEX_LOCKED', 'The primary repository index is locked; another Git operation is running.', EXIT_BLOCKED);
  }
  if (primary.operationsInProgress.length) {
    throw new AutomationError('GIT_OPERATION_IN_PROGRESS',
      `Finish the in-progress Git operation first: ${primary.operationsInProgress.join(', ')}.`, EXIT_BLOCKED);
  }
  if (worktrees.some(entry => {
    const owned = core.verifyOwnership(deps, entry.path, { repositoryIdentity: repository.identity, path: entry.path });
    return owned.ok && owned.marker.name === name;
  })) {
    throw new AutomationError('WORKTREE_NAME_IN_USE', `An owned worktree named ${core.quoteUntrusted(name)} already exists.`, EXIT_BLOCKED);
  }
  return primary;
}

function resolveCreateTarget(deps, repository, options, role, worktrees) {
  if (role === 'review') {
    const ref = String(options.ref || '').trim();
    if (!ref) throw core.usageError('REF_REQUIRED', 'A review worktree requires --ref.');
    core.assertBranchNameSafe(ref === 'HEAD' ? 'refs/heads/placeholder' : ref);
    const resolved = core.git(deps, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repository.root });
    if (!resolved || resolved.status !== 0) {
      throw new AutomationError('REF_UNRESOLVED', `Git cannot resolve ${core.quoteUntrusted(ref)} to a commit.`, EXIT_BLOCKED);
    }
    const sha = String(resolved.stdout || '').trim().toLowerCase();
    if (!FULL_SHA.test(sha)) throw new AutomationError('REF_UNRESOLVED', 'Resolved ref is not a full commit SHA.', EXIT_BLOCKED);
    return Object.freeze({ kind: 'detached', ref, sha, branch: null });
  }

  const branch = core.assertImplementationBranch(options.branch);
  const existing = core.git(deps, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repository.root });
  const branchExists = Boolean(existing && existing.status === 0);
  if (!branchExists && !options.createBranch) {
    throw new AutomationError('BRANCH_MISSING',
      `Branch ${core.quoteUntrusted(branch)} does not exist. Re-run with --create-branch to create it from HEAD.`, EXIT_BLOCKED);
  }
  const conflict = branchCheckedOutElsewhere(worktrees, branch);
  if (conflict) {
    throw new AutomationError('BRANCH_CHECKED_OUT_ELSEWHERE',
      `Branch ${core.quoteUntrusted(branch)} is already checked out at ${core.quoteUntrusted(conflict.path)}.`, EXIT_BLOCKED);
  }
  return Object.freeze({ kind: 'branch', branch, create: !branchExists, sha: branchExists ? String(existing.stdout).trim().toLowerCase() : null });
}

function createWorktree(deps, options) {
  const name = resolveName(options);
  const role = resolveRole(options, name);
  const repository = resolveRepository(deps);
  const parent = resolveWorktreeParent(deps, repository.root, options.parent);
  const worktrees = core.listWorktrees(deps, repository.root);
  assertCreatePreconditions(deps, repository, options, name, role, worktrees);
  const target = resolveCreateTarget(deps, repository, options, role, worktrees);

  deps.fs.mkdirSync(parent, { recursive: true });
  core.assertNoLinkAncestor(deps, parent, 'WORKTREE_PARENT_UNSAFE');
  const canonicalParent = core.canonicalDirectory(deps, parent, 'WORKTREE_PARENT_UNSAFE');
  const worktreePath = resolveWorktreePath(deps, canonicalParent, name);

  if (core.pathExists(deps, worktreePath)) {
    throw new AutomationError('WORKTREE_PATH_OCCUPIED',
      `Refusing to adopt an existing directory at ${core.quoteUntrusted(worktreePath)}. Automation never claims a path it did not create.`,
      EXIT_BLOCKED,
      { remediation: 'Inspect the directory yourself and move or remove it manually, then retry.' });
  }

  const args = ['worktree', 'add'];
  if (target.kind === 'detached') args.push('--detach', worktreePath, target.sha);
  else if (target.create) args.push('-b', target.branch, worktreePath, 'HEAD');
  else args.push(worktreePath, target.branch);

  const added = core.git(deps, args, { cwd: repository.root, timeoutMs: 120000 });
  if (!added || added.status !== 0) {
    throw new AutomationError('WORKTREE_ADD_FAILED', core.bounded(core.commandOutput(added)), EXIT_BLOCKED);
  }

  // Post-creation verification. If any of this fails the worktree is left in
  // place for inspection unless it is provably empty and tool-created.
  let verification;
  try {
    core.assertNoLinkAncestor(deps, worktreePath, 'WORKTREE_PATH_UNSAFE');
    const canonicalWorktree = core.canonicalDirectory(deps, worktreePath, 'WORKTREE_PATH_UNSAFE');
    if (!core.samePath(canonicalWorktree, worktreePath, deps.platform)) {
      throw new AutomationError('WORKTREE_PATH_UNSAFE', 'Created worktree resolves through a link.', EXIT_BLOCKED);
    }
    if (!core.pathExists(deps, path.join(worktreePath, '.git'))) {
      throw new AutomationError('WORKTREE_LINK_MISSING', 'Created worktree has no .git linkage.', EXIT_INTERNAL);
    }
    const state = core.readRepositoryState(deps, worktreePath);
    if (target.kind === 'detached') {
      if (state.head !== target.sha) throw new AutomationError('WORKTREE_HEAD_MISMATCH', 'Detached worktree HEAD does not match the requested ref.', EXIT_INTERNAL);
      if (!state.detached) throw new AutomationError('WORKTREE_NOT_DETACHED', 'Review worktree is not detached.', EXIT_INTERNAL);
    } else if (state.branch !== target.branch) {
      throw new AutomationError('WORKTREE_BRANCH_MISMATCH', 'Worktree branch does not match the requested branch.', EXIT_INTERNAL);
    }
    const written = core.writeOwnerMarker(deps, worktreePath, {
      name,
      role,
      readOnly: role === 'review' ? true : Boolean(options.readOnly),
      repositoryIdentity: repository.identity,
      repositoryRoot: repository.root,
      path: worktreePath,
      branch: target.branch,
      ref: target.kind === 'detached' ? target.ref : null,
      head: state.head,
      createdAt: deps.now().toISOString(),
      token: core.ownershipToken(deps)
    });
    const confirmed = core.verifyOwnership(deps, worktreePath, {
      repositoryIdentity: repository.identity, path: worktreePath, name
    });
    if (!confirmed.ok) throw new AutomationError('OWNER_MARKER_UNVERIFIED', confirmed.reason, EXIT_INTERNAL);
    verification = { state, marker: written.marker };
  } catch (error) {
    throw rollbackFailedCreate(deps, repository, worktreePath, error);
  }

  return Object.freeze({
    name, role, path: worktreePath, parent: canonicalParent,
    branch: target.branch, ref: target.kind === 'detached' ? target.ref : null,
    detached: target.kind === 'detached', head: verification.state.head,
    createdBranch: Boolean(target.create),
    readOnlyConvention: verification.marker.readOnly,
    runtimeLocks: runtimeLockReport(deps, familyRoot(deps, canonicalParent))
  });
}

// Only a demonstrably empty, tool-created worktree is rolled back. Anything
// ambiguous is preserved and reported with its recovery path.
function rollbackFailedCreate(deps, repository, worktreePath, primary) {
  let removed = false;
  let note = 'The partial worktree was preserved for inspection.';
  try {
    const marker = core.pathExists(deps, path.join(worktreePath, OWNER_MARKER));
    const state = core.readRepositoryState(deps, worktreePath);
    const clean = state.trackedChanges === 0 && state.untrackedCount === 0;
    if (!marker && clean) {
      const result = core.git(deps, ['worktree', 'remove', worktreePath], { cwd: repository.root, timeoutMs: 60000 });
      if (result && result.status === 0) {
        removed = true;
        note = 'The empty tool-created worktree was removed.';
      }
    }
  } catch {
    note = 'The partial worktree could not be revalidated and was preserved.';
  }
  const message = `${primary.message} ${note}`;
  return new AutomationError(primary.code || 'WORKTREE_CREATE_FAILED', message,
    primary.exitCode || EXIT_INTERNAL, { recoveryPath: removed ? null : worktreePath });
}

/* ==================== remove ==================== */

function removeWorktree(deps, options) {
  const name = resolveName(options);
  const repository = resolveRepository(deps);
  const worktrees = core.listWorktrees(deps, repository.root);

  const match = worktrees.find(entry => {
    if (core.samePath(entry.path, repository.root, deps.platform)) return false;
    const owned = core.verifyOwnership(deps, entry.path, { repositoryIdentity: repository.identity, path: entry.path });
    return owned.ok && owned.marker.name === name;
  });
  if (!match) {
    throw new AutomationError('WORKTREE_NOT_OWNED',
      `No owned worktree named ${core.quoteUntrusted(name)} was found. Automation removes only worktrees carrying a valid ownership marker it can revalidate.`,
      EXIT_BLOCKED);
  }
  if (core.samePath(match.path, repository.root, deps.platform)) {
    throw new AutomationError('WORKTREE_IS_PRIMARY', 'Refusing to remove the primary working tree.', EXIT_BLOCKED);
  }

  const ownership = core.verifyOwnership(deps, match.path, {
    repositoryIdentity: repository.identity, path: match.path, name
  });
  if (!ownership.ok) throw new AutomationError(ownership.code, ownership.reason, EXIT_BLOCKED);
  const branch = core.shortBranch(match.branch);
  if (branch && ['main', 'master'].includes(branch)) {
    throw new AutomationError('WORKTREE_PROTECTED_BRANCH', 'Refusing to remove a worktree attached to a protected branch.', EXIT_BLOCKED);
  }
  if (match.locked) {
    throw new AutomationError('WORKTREE_LOCKED', 'Git reports this worktree as locked; automation never force-removes.', EXIT_BLOCKED);
  }

  const state = core.readRepositoryState(deps, match.path);
  if (state.indexLocked || state.operationsInProgress.length) {
    throw new AutomationError('WORKTREE_OPERATION_IN_PROGRESS',
      'The worktree has an incomplete Git operation or a locked index.', EXIT_BLOCKED);
  }
  if (state.trackedChanges > 0) {
    throw new AutomationError('WORKTREE_DIRTY',
      `The worktree has ${state.trackedChanges} tracked change(s). Automation never deletes unreviewed work.`, EXIT_BLOCKED,
      { remediation: 'Commit, stash, or discard the changes yourself, then retry.' });
  }
  // The owner marker is the only file automation may leave behind.
  const foreignUntracked = state.untracked.filter(entry => entry !== OWNER_MARKER && !entry.startsWith(`${OWNER_MARKER}/`));
  if (foreignUntracked.length) {
    throw new AutomationError('WORKTREE_UNTRACKED_PRESENT',
      `The worktree contains ${foreignUntracked.length} untracked path(s). Automation never deletes untracked files.`, EXIT_BLOCKED,
      { remediation: 'Move or delete the untracked files yourself, then retry.' });
  }
  const ignored = core.git(deps, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: match.path });
  const ignoredEntries = ignored && ignored.status === 0 ? core.splitNull(ignored.stdout) : [];
  if (ignoredEntries.length) {
    throw new AutomationError('WORKTREE_IGNORED_PRESENT',
      `The worktree contains ${ignoredEntries.length} ignored file(s) created by an unknown process.`, EXIT_BLOCKED,
      { remediation: 'Inspect and remove them yourself, then retry.' });
  }

  // Resolved from the same --parent the worktree was created under, so a lock
  // held for a custom worktree parent is seen here too.
  const family = familyRoot(deps, resolveWorktreeParent(deps, repository.root, options.parent));
  const heldLocks = runtimeLockReport(deps, family).filter(lock => lock.live);
  if (heldLocks.length) {
    throw new AutomationError('RUNTIME_LOCK_HELD',
      `A shared local runtime operation is active: ${heldLocks.map(lock => lock.operation).join(', ')}.`, EXIT_BLOCKED,
      { remediation: 'Wait for the destructive runtime operation to finish before removing a worktree.' });
  }

  const unmerged = unmergedCommits(deps, repository, branch);
  if (unmerged.count > 0) {
    throw new AutomationError('BRANCH_AHEAD_UNMERGED',
      `Branch ${core.quoteUntrusted(branch)} has ${unmerged.count} commit(s) not reachable from main.`, EXIT_BLOCKED,
      { remediation: 'Open and merge the pull request, or remove the worktree manually after review.' });
  }

  // Marker removal first: after this the directory is an ordinary clean
  // worktree, so a failure below cannot leave a stale ownership claim.
  deps.fs.rmSync(ownership.markerPath, { force: false });
  const removed = core.git(deps, ['worktree', 'remove', match.path], { cwd: repository.root, timeoutMs: 60000 });
  if (!removed || removed.status !== 0) {
    throw new AutomationError('WORKTREE_REMOVE_FAILED', core.bounded(core.commandOutput(removed)), EXIT_BLOCKED,
      { recoveryPath: match.path, remediation: 'Automation never retries with --force. Resolve the cause and rerun.' });
  }
  const after = core.listWorktrees(deps, repository.root);
  if (after.some(entry => core.samePath(entry.path, match.path, deps.platform))) {
    throw new AutomationError('WORKTREE_STILL_REGISTERED', 'Git still reports the worktree after removal.', EXIT_INTERNAL,
      { recoveryPath: match.path });
  }
  let residual = null;
  if (core.pathExists(deps, match.path)) {
    residual = core.directoryIsEmpty(deps, match.path) ? 'empty-directory-preserved' : 'non-empty-directory-preserved';
  }
  return Object.freeze({
    name, path: match.path, branch, head: match.head,
    branchDeleted: false, residual,
    note: 'The branch was not deleted. Branch deletion is a separate, explicit operation.'
  });
}

function unmergedCommits(deps, repository, branch) {
  if (!branch) return { count: 0, resolvedBase: null };
  for (const base of ['main', 'origin/main']) {
    const verified = core.git(deps, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: repository.root });
    if (!verified || verified.status !== 0) continue;
    const result = core.git(deps, ['rev-list', '--count', `${base}..refs/heads/${branch}`], { cwd: repository.root });
    if (result && result.status === 0) {
      return { count: Number.parseInt(String(result.stdout).trim(), 10) || 0, resolvedBase: base };
    }
  }
  return { count: 0, resolvedBase: null };
}

/* ==================== list / inspect / prune ==================== */

function listWorktreeRecords(deps, options) {
  const repository = resolveRepository(deps);
  const worktrees = core.listWorktrees(deps, repository.root);
  const records = worktrees.map(entry => describeWorktree(deps, repository, entry, { withState: true }));
  const parent = resolveWorktreeParent(deps, repository.root, options.parent);
  return Object.freeze({
    repository: repository.root,
    parent,
    worktrees: Object.freeze(records),
    runtimeLocks: runtimeLockReport(deps, familyRoot(deps, parent))
  });
}

function inspectWorktree(deps, options) {
  const name = resolveName(options);
  const listing = listWorktreeRecords(deps, options);
  const record = listing.worktrees.find(entry => entry.name === name && entry.owned)
    || listing.worktrees.find(entry => entry.name === name);
  if (!record) throw new AutomationError('WORKTREE_NOT_FOUND', `No worktree named ${core.quoteUntrusted(name)}.`, EXIT_BLOCKED);
  return Object.freeze({ repository: listing.repository, worktree: record, runtimeLocks: listing.runtimeLocks });
}

// Prune touches Git metadata only, never the filesystem, and refuses to run
// while Git considers an owned worktree prunable.
function pruneWorktrees(deps, options) {
  const repository = resolveRepository(deps);
  const before = core.listWorktrees(deps, repository.root);
  const dryRun = core.git(deps, ['worktree', 'prune', '--dry-run', '-v'], { cwd: repository.root });
  if (!dryRun || dryRun.status !== 0) {
    throw new AutomationError('PRUNE_INSPECTION_FAILED', core.bounded(core.commandOutput(dryRun)), EXIT_BLOCKED);
  }
  const plan = core.bounded(dryRun.stdout || '');
  // A vanished worktree takes its ownership marker with it, so managed entries
  // are identified by location instead: anything prunable under the automation
  // worktree parent is reported for inspection rather than pruned silently.
  const managedParent = resolveWorktreeParent(deps, repository.root, options.parent);
  const ownedPrunable = before
    .filter(entry => entry.prunable && core.pathIsInside(managedParent, entry.path))
    .map(entry => path.basename(entry.path));
  if (ownedPrunable.length) {
    return Object.freeze({
      repository: repository.root, pruned: false, plan,
      ownedPrunable: Object.freeze(ownedPrunable),
      reason: 'Git considers an owned worktree prunable, which usually means its directory disappeared unexpectedly. Automation will not prune it automatically.'
    });
  }
  if (!plan) {
    return Object.freeze({ repository: repository.root, pruned: false, plan: '', ownedPrunable: Object.freeze([]), reason: 'No stale worktree metadata was found.' });
  }
  const pruned = core.git(deps, ['worktree', 'prune', '-v'], { cwd: repository.root });
  if (!pruned || pruned.status !== 0) {
    throw new AutomationError('PRUNE_FAILED', core.bounded(core.commandOutput(pruned)), EXIT_BLOCKED);
  }
  return Object.freeze({
    repository: repository.root, pruned: true, plan,
    ownedPrunable: Object.freeze([]),
    reason: 'Stale Git worktree metadata was pruned. No filesystem path was deleted.'
  });
}

/* ==================== presentation ==================== */

// Reporting only. No destructive runtime command acquires these locks yet, so
// "none held" means nothing announced a runtime operation, not that none is
// running. Acquisition is deferred to PR 2-B2.
function describeLocks(locks) {
  if (!locks || !locks.length) {
    return ['Shared runtime locks: none held. Runtime commands do not claim this lock yet, so this is not proof that no reset is running.'];
  }
  return ['Shared runtime locks:'].concat(locks.map(lock =>
    `  - ${lock.operation}: ${lock.live ? 'HELD by a live process' : 'stale claim'}${lock.pid ? ` (pid ${lock.pid})` : ''}`));
}

function presentCreate(result) {
  return {
    statusLine: 'WORKTREE CREATED',
    exitCode: EXIT_OK,
    summary: [
      ['Name', result.name],
      ['Role', result.role],
      ['Path', result.path],
      ['Target', result.detached ? `detached at ${result.head}` : `branch ${result.branch}`],
      ['HEAD', result.head],
      ['Read-only convention', result.readOnlyConvention ? 'yes (not enforced by the filesystem)' : 'no']
    ],
    details: [
      'Open it manually:',
      `  cd ${result.path}`,
      result.detached
        ? 'This review worktree is detached. Git will not update any branch here, but nothing prevents local edits.'
        : 'This is an implementation worktree. Commit and push from inside it as usual.',
      'Automation did not launch any AI client.'
    ].concat(describeLocks(result.runtimeLocks)),
    payload: { schemaVersion: core.SCHEMA_VERSION, status: 'created', ...result }
  };
}

function presentList(result) {
  const details = result.worktrees.length
    ? result.worktrees.map(entry => [
      `- ${entry.primary ? '(primary)' : entry.owned ? `${entry.name} [${entry.role}]` : `${entry.name} [unowned: ${entry.ownershipCode}]`}`,
      `    path: ${entry.path}`,
      `    ref: ${entry.detached ? `detached ${entry.head}` : `branch ${entry.branch}`}`,
      `    state: ${entry.clean === null ? 'unknown' : entry.clean ? 'clean' : `${entry.trackedChanges} tracked, ${entry.untrackedCount} untracked`}${entry.prunable ? ', prunable' : ''}`
    ].join('\n'))
    : ['- none'];
  return {
    statusLine: 'WORKTREE LIST OK',
    exitCode: EXIT_OK,
    summary: [['Repository', result.repository], ['Worktree parent', result.parent], ['Worktrees', String(result.worktrees.length)]],
    details: details.concat(describeLocks(result.runtimeLocks)),
    payload: { schemaVersion: core.SCHEMA_VERSION, status: 'listed', ...result }
  };
}

function presentInspect(result) {
  const w = result.worktree;
  return {
    statusLine: w.owned ? 'WORKTREE OWNED' : 'WORKTREE NOT OWNED',
    exitCode: w.owned ? EXIT_OK : EXIT_VALIDATION,
    summary: [
      ['Name', w.name], ['Role', w.role || 'unknown'], ['Path', w.path],
      ['Ref', w.detached ? `detached ${w.head}` : `branch ${w.branch}`],
      ['Owned', w.owned ? 'yes' : `no (${w.ownershipCode})`],
      ['Clean', w.clean === null ? 'unknown' : w.clean ? 'yes' : 'no'],
      ['Tracked changes', w.trackedChanges === null ? 'unknown' : String(w.trackedChanges)],
      ['Untracked paths', w.untrackedCount === null ? 'unknown' : String(w.untrackedCount)],
      ['Prunable', w.prunable ? 'yes' : 'no']
    ],
    details: describeLocks(result.runtimeLocks),
    payload: { schemaVersion: core.SCHEMA_VERSION, status: 'inspected', ...result }
  };
}

function presentRemove(result) {
  return {
    statusLine: 'WORKTREE REMOVED',
    exitCode: EXIT_OK,
    summary: [['Name', result.name], ['Path', result.path], ['Branch', result.branch || 'detached'], ['Branch deleted', 'no']],
    details: [result.note].concat(result.residual ? [`Residual path state: ${result.residual}.`] : []),
    payload: { schemaVersion: core.SCHEMA_VERSION, status: 'removed', ...result }
  };
}

function presentPrune(result) {
  return {
    statusLine: result.pruned ? 'WORKTREE METADATA PRUNED' : 'WORKTREE PRUNE SKIPPED',
    exitCode: result.ownedPrunable.length ? EXIT_BLOCKED : EXIT_OK,
    summary: [['Repository', result.repository], ['Pruned', result.pruned ? 'yes' : 'no']],
    details: [result.reason].concat(result.plan ? ['Git prune plan:', core.bounded(result.plan)] : []),
    payload: { schemaVersion: core.SCHEMA_VERSION, status: result.pruned ? 'pruned' : 'not-pruned', ...result }
  };
}

function presentFailure(error) {
  return {
    statusLine: 'WORKTREE BLOCKED',
    exitCode: error.exitCode || EXIT_BLOCKED,
    summary: [['Failure', error.code || 'INTERNAL_ORCHESTRATION_FAILURE']],
    details: [core.bounded(error.message || 'Automation failed.')].concat(error.recoveryPath ? [`Recovery path: ${error.recoveryPath}`] : []),
    remediation: error.remediation,
    payload: {
      schemaVersion: core.SCHEMA_VERSION,
      status: 'blocked',
      failureCode: error.code || 'INTERNAL_ORCHESTRATION_FAILURE',
      message: core.bounded(error.message || 'Automation failed.'),
      recoveryPath: error.recoveryPath || null,
      remediation: error.remediation || null
    }
  };
}

/* ==================== entry point ==================== */

function runCommand(options, overrides = {}) {
  const deps = core.createDeps({ ...overrides, repositoryRoot: overrides.repositoryRoot || process.cwd() });
  switch (options.command) {
    case 'create': return presentCreate(createWorktree(deps, options));
    case 'list': return presentList(listWorktreeRecords(deps, options));
    case 'inspect': return presentInspect(inspectWorktree(deps, options));
    case 'remove': return presentRemove(removeWorktree(deps, options));
    case 'prune': return presentPrune(pruneWorktrees(deps, options));
    default: throw core.usageError('COMMAND_INVALID', 'Unknown command.');
  }
}

function main(argv = process.argv.slice(2), overrides = {}) {
  const deps = core.createDeps({ ...overrides, repositoryRoot: overrides.repositoryRoot || process.cwd() });
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    deps.streams.stderr.write(`[${error.code || 'USAGE_ERROR'}] ${core.redact(error.message)}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    deps.streams.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  try {
    return core.emit(deps, runCommand(options, overrides), options);
  } catch (error) {
    const known = error instanceof AutomationError;
    if (!known) {
      const wrapped = new AutomationError('INTERNAL_ORCHESTRATION_FAILURE', String(error && error.message || error), EXIT_INTERNAL);
      return core.emit(deps, presentFailure(wrapped), options);
    }
    return core.emit(deps, presentFailure(error), options);
  }
}

module.exports = Object.freeze({
  IMPLEMENTATION_ROLES,
  ROLES,
  RUNTIME_OPERATIONS,
  USAGE,
  WORKTREE_PARENT,
  createWorktree,
  describeWorktree,
  inspectWorktree,
  listWorktreeRecords,
  main,
  parseArgs,
  pruneWorktrees,
  removeWorktree,
  resolveWorktreeParent,
  resolveWorktreePath,
  runCommand,
  unmergedCommits
});

if (require.main === module) process.exitCode = main();
