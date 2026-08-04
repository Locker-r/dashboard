'use strict';

// Real Git fixtures. Worktree ownership, protected-branch refusal, and
// dirty/untracked removal guards cannot be proven with mocked command output,
// so these tests build throwaway repositories with real worktrees outside the
// working tree and delete them afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('../scripts/dev/automation-core.cjs');
const worktree = require('../scripts/dev/agent-worktree.cjs');

const PACKAGE_NAME = require('../scripts/dev/doctor.cjs').PACKAGE_NAME;
const fixtureRoots = [];

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

// Deliberately uses a space and a non-ASCII character: Windows path handling
// and quoting regressions surface here rather than in production.
function createFixture(label = 'agent worktree fixture') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)));
  fixtureRoots.push(base);
  const repository = path.join(base, 'proyecto dashboard');
  fs.mkdirSync(repository);
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.email', 'fixture@example.invalid');
  git(repository, 'config', 'user.name', 'Worktree Fixture');
  git(repository, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repository, 'package.json'), `${JSON.stringify({ name: PACKAGE_NAME, version: '1.0.0' }, null, 2)}\n`);
  fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored-output/\n');
  git(repository, 'add', '--', 'package.json', '.gitignore');
  git(repository, 'commit', '-q', '-m', 'fixture base');
  return { base, repository, parent: path.join(base, 'worktrees') };
}

function captureStreams() {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

let tokenCounter = 0;
function overridesFor(fixture, extra = {}) {
  return {
    repositoryRoot: fixture.repository,
    now: extra.now || (() => new Date('2026-08-04T09:00:00.000Z')),
    randomToken: extra.randomToken || (() => `fixturetoken${String(tokenCounter++).padStart(12, '0')}`),
    ...extra
  };
}

function run(fixture, argv, extra = {}) {
  const capture = extra.capture || captureStreams();
  const code = worktree.main(argv, { ...overridesFor(fixture, extra), streams: capture.streams });
  return { code, capture, stdout: capture.stdout(), stderr: capture.stderr() };
}

function runJson(fixture, argv, extra = {}) {
  const result = run(fixture, [...argv, '--json'], extra);
  return { ...result, payload: JSON.parse(result.stdout) };
}

function createClaude(fixture, extra = {}) {
  return runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/agent-work', '--create-branch', '--parent', fixture.parent], extra);
}

test.after(() => {
  for (const root of fixtureRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/* ==================== usage ==================== */

test('help and invalid usage are deterministic without touching Git', () => {
  const fixture = createFixture();
  for (const argv of [[], ['bogus'], ['create', '--unknown'], ['create', '--name']]) {
    const result = run(fixture, argv);
    assert.equal(result.code, core.EXIT_USAGE);
    assert.match(result.stderr, /Usage: node scripts\/dev\/agent-worktree\.cjs/);
  }
  const help = run(fixture, ['--help']);
  assert.equal(help.code, core.EXIT_OK);
  assert.match(help.stdout, /never launches an AI client/);
  assert.equal(help.stderr, '');
  assert.equal(fs.existsSync(fixture.parent), false, 'usage errors must not create a worktree parent');
});

test('worktree names and roles are validated before any Git call', () => {
  const fixture = createFixture();
  for (const [name, code] of [['../escape', 'NAME_INVALID'], ['UPPER', 'NAME_INVALID'], ['.hidden', 'NAME_INVALID'], ['a'.repeat(41), 'NAME_INVALID']]) {
    const result = runJson(fixture, ['create', '--name', name, '--branch', 'feature/x', '--parent', fixture.parent]);
    assert.equal(result.payload.failureCode, code, `${name} must be refused`);
  }
  const unknownRole = runJson(fixture, ['create', '--name', 'custom', '--branch', 'feature/x', '--parent', fixture.parent]);
  assert.equal(unknownRole.payload.failureCode, 'ROLE_REQUIRED');
});

/* ==================== create ==================== */

test('creates a Claude implementation worktree with verified ownership and real Git linkage', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  assert.equal(created.code, core.EXIT_OK);
  assert.equal(created.payload.status, 'created');
  assert.equal(created.payload.role, 'claude');
  assert.equal(created.payload.branch, 'feature/agent-work');
  assert.equal(created.payload.detached, false);
  assert.match(created.stdout, /"status": "created"/);

  const target = created.payload.path;
  assert.equal(fs.existsSync(path.join(target, '.git')), true, 'the worktree must have real Git linkage');
  assert.equal(git(target, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/agent-work');
  assert.equal(git(target, 'rev-parse', 'HEAD'), git(fixture.repository, 'rev-parse', 'HEAD'));

  const marker = JSON.parse(fs.readFileSync(path.join(target, core.OWNER_MARKER), 'utf8'));
  assert.equal(marker.tool, 'dashboard-automation');
  assert.equal(marker.name, 'claude');
  assert.equal(marker.role, 'claude');
  assert.match(marker.token, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(marker.repositoryRoot, fixture.repository);

  // The primary repository must be untouched by worktree creation.
  assert.equal(git(fixture.repository, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(fixture.repository, 'status', '--porcelain'), '');
});

test('creates a detached review worktree at the exact reviewed SHA', () => {
  const fixture = createFixture();
  const reviewed = git(fixture.repository, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(fixture.repository, 'later.txt'), 'later\n');
  git(fixture.repository, 'add', '--', 'later.txt');
  git(fixture.repository, 'commit', '-q', '-m', 'later commit');

  const created = runJson(fixture, ['create', '--name', 'review', '--ref', reviewed, '--read-only', '--parent', fixture.parent]);
  assert.equal(created.code, core.EXIT_OK);
  assert.equal(created.payload.detached, true);
  assert.equal(created.payload.head, reviewed);
  assert.equal(created.payload.branch, null);
  assert.equal(created.payload.readOnlyConvention, true);
  assert.equal(git(created.payload.path, 'rev-parse', 'HEAD'), reviewed);
  assert.equal(git(created.payload.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'review worktrees must be detached');
  // Honest about the limits of the convention.
  const human = run(fixture, ['inspect', '--name', 'review', '--parent', fixture.parent]);
  assert.match(created.stdout, /"readOnlyConvention": true/);
  assert.equal(human.code, core.EXIT_OK);
});

test('protected branches, bad prefixes, and missing branches are refused before creation', () => {
  const fixture = createFixture();
  for (const [branch, code] of [
    ['main', 'BRANCH_PROTECTED'],
    ['master', 'BRANCH_PROTECTED'],
    ['random/thing', 'BRANCH_PREFIX_REQUIRED'],
    ['feature/missing', 'BRANCH_MISSING']
  ]) {
    const result = runJson(fixture, ['create', '--name', 'claude', '--branch', branch, '--parent', fixture.parent]);
    assert.equal(result.code, core.EXIT_BLOCKED);
    assert.equal(result.payload.failureCode, code, `${branch} must be refused`);
  }
  assert.equal(core.listWorktrees(core.createDeps({ repositoryRoot: fixture.repository }), fixture.repository).length, 1);
});

test('branch names that Git would read as options or revisions are refused', () => {
  const fixture = createFixture();
  for (const branch of ['--upload-pack=evil', 'feature/a..b', 'feature/a b', 'feature/x@{0}', 'feature/x.lock']) {
    const result = runJson(fixture, ['create', '--name', 'claude', '--branch', branch, '--create-branch', '--parent', fixture.parent]);
    assert.equal(result.payload.failureCode, 'BRANCH_UNSAFE', `${branch} must be refused`);
  }
});

test('a branch already checked out in another worktree is refused', () => {
  const fixture = createFixture();
  const first = createClaude(fixture);
  assert.equal(first.code, core.EXIT_OK);
  const second = runJson(fixture, ['create', '--name', 'codex', '--branch', 'feature/agent-work', '--parent', fixture.parent]);
  assert.equal(second.code, core.EXIT_BLOCKED);
  assert.equal(second.payload.failureCode, 'BRANCH_CHECKED_OUT_ELSEWHERE');
});

test('a duplicate owned name is refused', () => {
  const fixture = createFixture();
  assert.equal(createClaude(fixture).code, core.EXIT_OK);
  const duplicate = runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/other', '--create-branch', '--parent', fixture.parent]);
  assert.equal(duplicate.code, core.EXIT_BLOCKED);
  assert.equal(duplicate.payload.failureCode, 'WORKTREE_NAME_IN_USE');
});

test('a foreign existing directory is never adopted', () => {
  const fixture = createFixture();
  const target = path.join(fixture.parent, 'claude');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'operator-notes.txt'), 'operator material\n');
  const result = runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/agent-work', '--create-branch', '--parent', fixture.parent]);
  assert.equal(result.code, core.EXIT_BLOCKED);
  assert.equal(result.payload.failureCode, 'WORKTREE_PATH_OCCUPIED');
  assert.equal(fs.readFileSync(path.join(target, 'operator-notes.txt'), 'utf8'), 'operator material\n');
});

test('a worktree parent inside the primary working tree is refused', () => {
  const fixture = createFixture();
  const inside = path.join(fixture.repository, 'nested-worktrees');
  const result = runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/agent-work', '--create-branch', '--parent', inside]);
  assert.equal(result.code, core.EXIT_BLOCKED);
  assert.equal(result.payload.failureCode, 'WORKTREE_PARENT_INSIDE_REPOSITORY');
  assert.equal(fs.existsSync(inside), false);
});

test('path traversal and control characters are refused in the worktree parent', () => {
  const fixture = createFixture();
  // Built by string concatenation on purpose: path.join would normalise the
  // traversal away and the guard would never be exercised.
  const raw = `${fixture.base}${path.sep}worktrees${path.sep}..${path.sep}..${path.sep}escaped`;
  const traversal = runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/agent-work', '--create-branch', '--parent', raw]);
  assert.equal(traversal.code, core.EXIT_USAGE);
  assert.equal(traversal.payload.failureCode, 'WORKTREE_PARENT_UNSAFE');
  assert.match(traversal.payload.message, /traversal is refused/);


  // Control and bidirectional characters are built from char codes so the
  // test file itself stays plain ASCII.
  for (const bad of [String.fromCharCode(1), String.fromCharCode(0x202e), String.fromCharCode(0x200b)]) {
    const result = runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/agent-work', '--create-branch',
      '--parent', `${fixture.base}${path.sep}bad${bad}name`]);
    assert.equal(result.payload.failureCode, 'WORKTREE_PARENT_UNSAFE');
    assert.match(result.payload.message, /control or bidirectional/);
  }

  // A space is legitimate on Windows and must still be accepted.
  const spaced = runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/agent-work', '--create-branch',
    '--parent', `${fixture.base}${path.sep}with space`]);
  assert.equal(spaced.code, core.EXIT_OK);
});

test('a symbolic-link or junction ancestor is refused', { skip: !supportsLinks() }, () => {
  const fixture = createFixture();
  const real = path.join(fixture.base, 'real-parent');
  const linked = path.join(fixture.base, 'linked-parent');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, linked, 'junction');
  const result = runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/agent-work', '--create-branch', '--parent', linked]);
  assert.equal(result.code, core.EXIT_BLOCKED);
  assert.equal(result.payload.failureCode, 'WORKTREE_PARENT_UNSAFE');
  assert.match(result.payload.message, /symbolic-link or junction ancestor/);
  assert.equal(fs.readdirSync(real).length, 0, 'the link target must not be populated');
});

function supportsLinks() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'link-probe-'));
  try {
    fs.mkdirSync(path.join(probe, 'target'));
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/* ==================== ownership ==================== */

test('marker tampering, repository mismatch, and path mismatch all revoke ownership', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  const markerPath = path.join(created.payload.path, core.OWNER_MARKER);
  const original = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

  for (const [mutation, expected] of [
    [marker => { marker.token = 'short'; }, 'OWNER_TOKEN_INVALID'],
    [marker => { marker.repositoryIdentity = 'f'.repeat(32); }, 'OWNER_REPOSITORY_MISMATCH'],
    [marker => { marker.path = path.join(fixture.base, 'elsewhere'); }, 'OWNER_PATH_MISMATCH'],
    [marker => { marker.tool = 'someone-else'; }, 'OWNER_MARKER_INVALID']
  ]) {
    const mutated = JSON.parse(JSON.stringify(original));
    mutation(mutated);
    fs.writeFileSync(markerPath, `${JSON.stringify(mutated)}\n`);
    const removal = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
    assert.equal(removal.code, core.EXIT_BLOCKED);
    assert.equal(removal.payload.failureCode, 'WORKTREE_NOT_OWNED', `tampered marker (${expected}) must not be removable`);
    assert.equal(fs.existsSync(created.payload.path), true, 'a tampered worktree is preserved');
  }

  fs.writeFileSync(markerPath, '{ not json');
  const invalid = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(invalid.payload.failureCode, 'WORKTREE_NOT_OWNED');
  assert.equal(fs.existsSync(created.payload.path), true);
});

test('a missing marker means the worktree is never removable by automation', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  fs.rmSync(path.join(created.payload.path, core.OWNER_MARKER));
  const removal = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(removal.code, core.EXIT_BLOCKED);
  assert.equal(removal.payload.failureCode, 'WORKTREE_NOT_OWNED');
  assert.equal(fs.existsSync(created.payload.path), true);
});

/* ==================== remove ==================== */

test('a clean owned worktree is removed and its branch is deliberately kept', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  const target = created.payload.path;
  const removal = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(removal.code, core.EXIT_OK);
  assert.equal(removal.payload.status, 'removed');
  assert.equal(removal.payload.branchDeleted, false);
  assert.match(removal.payload.note, /branch was not deleted/i);
  assert.equal(fs.existsSync(target), false, 'Git removed the clean worktree directory');
  // The branch itself must survive removal.
  assert.equal(git(fixture.repository, 'rev-parse', '--verify', 'refs/heads/feature/agent-work').length, 40);
  assert.equal(core.listWorktrees(core.createDeps({ repositoryRoot: fixture.repository }), fixture.repository).length, 1);
});

test('dirty tracked changes block removal and nothing is deleted', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  fs.writeFileSync(path.join(created.payload.path, 'package.json'), '{"name":"mutated"}\n');
  const removal = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(removal.code, core.EXIT_BLOCKED);
  assert.equal(removal.payload.failureCode, 'WORKTREE_DIRTY');
  assert.match(removal.payload.remediation, /Commit, stash, or discard/);
  assert.equal(fs.existsSync(created.payload.path), true);
  assert.equal(fs.readFileSync(path.join(created.payload.path, 'package.json'), 'utf8'), '{"name":"mutated"}\n');
});

test('untracked and ignored files block removal and are never deleted', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  const stray = path.join(created.payload.path, 'agent-scratch.txt');
  fs.writeFileSync(stray, 'unsaved agent work\n');
  const untracked = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(untracked.payload.failureCode, 'WORKTREE_UNTRACKED_PRESENT');
  assert.equal(fs.readFileSync(stray, 'utf8'), 'unsaved agent work\n');

  fs.rmSync(stray);
  const ignoredDirectory = path.join(created.payload.path, 'ignored-output');
  fs.mkdirSync(ignoredDirectory);
  fs.writeFileSync(path.join(ignoredDirectory, 'build.log'), 'unknown process output\n');
  const ignored = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(ignored.payload.failureCode, 'WORKTREE_IGNORED_PRESENT');
  assert.equal(fs.existsSync(path.join(ignoredDirectory, 'build.log')), true);
});

test('a branch with unique unmerged commits blocks removal', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  fs.writeFileSync(path.join(created.payload.path, 'work.txt'), 'agent work\n');
  git(created.payload.path, 'add', '--', 'work.txt');
  git(created.payload.path, 'commit', '-q', '-m', 'agent commit');
  const removal = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(removal.code, core.EXIT_BLOCKED);
  assert.equal(removal.payload.failureCode, 'BRANCH_AHEAD_UNMERGED');
  assert.match(removal.payload.message, /1 commit\(s\) not reachable from main/);
  assert.equal(fs.existsSync(created.payload.path), true);
});

test('a merged branch no longer blocks removal', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  fs.writeFileSync(path.join(created.payload.path, 'work.txt'), 'agent work\n');
  git(created.payload.path, 'add', '--', 'work.txt');
  git(created.payload.path, 'commit', '-q', '-m', 'agent commit');
  git(fixture.repository, 'merge', '--no-edit', '-q', 'feature/agent-work');
  const removal = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(removal.code, core.EXIT_OK);
  assert.equal(fs.existsSync(created.payload.path), false);
  assert.equal(git(fixture.repository, 'rev-parse', '--verify', 'refs/heads/feature/agent-work').length, 40);
});

test('an unknown name is refused rather than guessed', () => {
  const fixture = createFixture();
  createClaude(fixture);
  const removal = runJson(fixture, ['remove', '--name', 'codex', '--parent', fixture.parent]);
  assert.equal(removal.code, core.EXIT_BLOCKED);
  assert.equal(removal.payload.failureCode, 'WORKTREE_NOT_OWNED');
});

/* ==================== list / inspect / prune ==================== */

test('list and inspect report ownership, state, and JSON without reading file contents', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  // Planted here and asserted below: both the name and the body of an untracked
  // file must stay out of every output. The commands may count untracked paths
  // but must never echo what an agent left in the worktree.
  const plantedName = 'agent-scratch-notes.txt';
  const plantedBody = 'UNREVIEWED AGENT DRAFT rev-7742 do-not-echo';
  fs.writeFileSync(path.join(created.payload.path, plantedName), `${plantedBody}\n`);

  const listing = runJson(fixture, ['list', '--parent', fixture.parent]);
  assert.equal(listing.code, core.EXIT_OK);
  assert.equal(listing.payload.worktrees.length, 2);
  const owned = listing.payload.worktrees.find(entry => entry.owned);
  assert.equal(owned.name, 'claude');
  assert.equal(owned.role, 'claude');
  assert.equal(owned.clean, false);
  assert.equal(owned.untrackedCount, 1);
  const primary = listing.payload.worktrees.find(entry => entry.primary);
  assert.equal(primary.owned, false);
  assert.equal(primary.ownershipCode, 'PRIMARY_WORKING_TREE');

  const inspected = runJson(fixture, ['inspect', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(inspected.payload.worktree.name, 'claude');
  assert.equal(inspected.payload.worktree.owned, true);
  assert.equal(inspected.payload.worktree.untrackedCount, 1, 'the count is reported');

  // The planted values are the ones actually on disk, so these fail if any
  // command starts echoing untracked path names or file contents.
  const humanListing = run(fixture, ['list', '--parent', fixture.parent]);
  const humanInspect = run(fixture, ['inspect', '--name', 'claude', '--parent', fixture.parent]);
  for (const [label, text] of [
    ['list JSON', listing.stdout],
    ['inspect JSON', inspected.stdout],
    ['list human', humanListing.stdout],
    ['inspect human', humanInspect.stdout]
  ]) {
    assert.equal(text.includes(plantedBody), false, `${label} must not echo untracked file contents`);
    assert.equal(text.includes(plantedName), false, `${label} must not echo untracked path names`);
  }

  const missing = runJson(fixture, ['inspect', '--name', 'ghost', '--parent', fixture.parent]);
  assert.equal(missing.code, core.EXIT_BLOCKED);
  assert.equal(missing.payload.failureCode, 'WORKTREE_NOT_FOUND');
});

test('an unowned foreign worktree is listed but never treated as owned', () => {
  const fixture = createFixture();
  const foreign = path.join(fixture.base, 'manual-worktree');
  git(fixture.repository, 'worktree', 'add', '-q', '-b', 'feature/manual', foreign, 'HEAD');
  const listing = runJson(fixture, ['list', '--parent', fixture.parent]);
  const record = listing.payload.worktrees.find(entry => !entry.primary);
  assert.equal(record.owned, false);
  assert.equal(record.ownershipCode, 'OWNER_MARKER_MISSING');
  const removal = runJson(fixture, ['remove', '--name', 'manual-worktree', '--parent', fixture.parent]);
  assert.equal(removal.payload.failureCode, 'WORKTREE_NOT_OWNED');
  assert.equal(fs.existsSync(foreign), true);
});

test('prune reports stale metadata and never deletes a filesystem path', () => {
  const fixture = createFixture();
  const clean = runJson(fixture, ['prune', '--parent', fixture.parent]);
  assert.equal(clean.code, core.EXIT_OK);
  assert.equal(clean.payload.pruned, false);
  assert.match(clean.payload.reason, /No stale worktree metadata/);

  const created = createClaude(fixture);
  // Simulate an externally deleted worktree directory, which is exactly what
  // makes Git consider the metadata prunable.
  fs.rmSync(created.payload.path, { recursive: true, force: true });
  const blocked = runJson(fixture, ['prune', '--parent', fixture.parent]);
  assert.equal(blocked.code, core.EXIT_BLOCKED);
  assert.equal(blocked.payload.pruned, false);
  assert.deepEqual(blocked.payload.ownedPrunable, ['claude']);
});

/* ==================== runtime lock ==================== */

test('the shared runtime lock is exclusive, refuses a second owner, and preserves foreign locks', () => {
  const fixture = createFixture();
  const deps = core.createDeps(overridesFor(fixture));
  const family = path.join(fixture.base, 'family');
  const lock = core.acquireRuntimeLock(deps, family, 'database-reset', { ownerWorktree: 'claude' });
  assert.match(lock.path, /database-reset\.lock\.json$/);
  assert.equal(fs.existsSync(lock.path), true);

  assert.throws(() => core.acquireRuntimeLock(deps, family, 'database-reset', { ownerWorktree: 'codex' }),
    error => error.code === 'RUNTIME_LOCK_HELD');

  const held = core.inspectRuntimeLock(deps, family, 'database-reset');
  assert.equal(held.held, true);
  assert.equal(held.live, true);
  assert.equal(held.ownerWorktree, 'claude');

  // The token is the lock's release credential. It is written to the lock file
  // and must never travel back out through an inspection result, so assert
  // against the real token rather than a value the fixture never contained.
  assert.match(lock.token, /^[A-Za-z0-9_-]{16,128}$/, 'the fixture must hold a real token');
  assert.ok(fs.readFileSync(lock.path, 'utf8').includes(lock.token), 'the token is genuinely on disk');
  assert.equal(JSON.stringify(held).includes(lock.token), false, 'inspection must not return the release token');
  assert.equal(Object.hasOwn(held, 'token'), false);

  // A different token must never release someone else's lock.
  const foreign = core.releaseRuntimeLock(deps, family, { path: lock.path, token: 'someone-elses-token-value' });
  assert.equal(foreign.released, false);
  assert.equal(fs.existsSync(lock.path), true);

  const released = core.releaseRuntimeLock(deps, family, lock);
  assert.equal(released.released, true);
  assert.equal(fs.existsSync(lock.path), false);
});

test('a dead PID is reported stale and a reused PID is not trusted as live', () => {
  const fixture = createFixture();
  const family = path.join(fixture.base, 'family-stale');
  const deadDeps = core.createDeps(overridesFor(fixture, {
    processPid: () => 424242,
    processKill: () => { const error = new Error('no such process'); error.code = 'ESRCH'; throw error; }
  }));
  core.acquireRuntimeLock(deadDeps, family, 'runtime-smoke', { ownerWorktree: 'claude' });
  const stale = core.inspectRuntimeLock(deadDeps, family, 'runtime-smoke');
  assert.equal(stale.held, true);
  assert.equal(stale.live, false);
  assert.equal(stale.stale, true);

  // PID reuse: the process is alive but its recorded start identity changed.
  const family2 = path.join(fixture.base, 'family-reuse');
  let start = '2026-08-04T09:00:00.0000000Z';
  const reuseDeps = core.createDeps(overridesFor(fixture, {
    platform: 'win32',
    processPid: () => 4242,
    processKill: () => true,
    runCommand: (file, args) => file === 'powershell.exe'
      ? { status: 0, stdout: start, stderr: '', error: null, signal: null }
      : core.defaultRunCommand(file, args, { cwd: fixture.repository })
  }));
  core.acquireRuntimeLock(reuseDeps, family2, 'runtime-smoke', {});
  assert.equal(core.inspectRuntimeLock(reuseDeps, family2, 'runtime-smoke').live, true);
  start = '2026-08-04T11:30:00.0000000Z';
  const reused = core.inspectRuntimeLock(reuseDeps, family2, 'runtime-smoke');
  assert.equal(reused.reused, true);
  assert.equal(reused.live, false, 'a reused PID must not keep a stale lock alive');
});

test('worktree commands report a held shared runtime lock and removal refuses while it is live', () => {
  const fixture = createFixture();
  // The default worktree parent, so the family root under test is the default
  // <repository-parent>/.worktrees one.
  const created = runJson(fixture, ['create', '--name', 'claude', '--branch', 'feature/agent-work', '--create-branch']);
  assert.equal(created.code, core.EXIT_OK);
  const family = path.join(path.dirname(fixture.repository), '.worktrees');
  const deps = core.createDeps(overridesFor(fixture));
  const lock = core.acquireRuntimeLock(deps, family, 'database-reset', { ownerWorktree: 'codex' });
  try {
    const listing = runJson(fixture, ['list']);
    assert.equal(listing.payload.runtimeLocks.length, 1);
    assert.equal(listing.payload.runtimeLocks[0].operation, 'database-reset');
    assert.equal(listing.payload.runtimeLocks[0].live, true);
    assert.match(listing.stdout, /"live": true/);

    // The held lock is reported, but its release token must not reach either
    // output form. Asserted against the token actually written to the lock file.
    const humanListing = run(fixture, ['list']);
    assert.match(humanListing.stdout, /database-reset: HELD by a live process/);
    assert.equal(listing.stdout.includes(lock.token), false, 'JSON output must not carry the lock token');
    assert.equal(humanListing.stdout.includes(lock.token), false, 'human output must not carry the lock token');

    const removal = runJson(fixture, ['remove', '--name', 'claude']);
    assert.equal(removal.code, core.EXIT_BLOCKED);
    assert.equal(removal.payload.failureCode, 'RUNTIME_LOCK_HELD');
    assert.equal(fs.existsSync(created.payload.path), true);
  } finally {
    core.releaseRuntimeLock(deps, family, lock);
  }
});

// Regression: create, list, and remove must resolve the shared family root from
// the same worktree parent. Deriving it from the repository root in remove while
// create derived it from --parent made a live lock invisible to the only command
// that has to refuse because of it, and the worktree was removed mid-reset.
test('a live runtime lock under a custom worktree parent is seen by create, list, and remove', () => {
  const fixture = createFixture();
  const created = createClaude(fixture);
  assert.equal(created.code, core.EXIT_OK);
  const deps = core.createDeps(overridesFor(fixture));
  const customFamily = path.dirname(fixture.parent);
  const defaultFamily = path.join(path.dirname(fixture.repository), '.worktrees');
  assert.notEqual(customFamily, defaultFamily, 'the fixture must exercise a non-default family root');

  const lock = core.acquireRuntimeLock(deps, customFamily, 'database-reset', { ownerWorktree: 'codex' });
  try {
    const listing = runJson(fixture, ['list', '--parent', fixture.parent]);
    assert.deepEqual(listing.payload.runtimeLocks.map(entry => entry.operation), ['database-reset']);
    assert.equal(listing.payload.runtimeLocks[0].live, true);

    const removal = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
    assert.equal(removal.code, core.EXIT_BLOCKED);
    assert.equal(removal.payload.failureCode, 'RUNTIME_LOCK_HELD');
    assert.equal(fs.existsSync(created.payload.path), true, 'the worktree must survive a live shared lock');

    const second = runJson(fixture, ['create', '--name', 'codex', '--branch', 'feature/second', '--create-branch', '--parent', fixture.parent]);
    assert.equal(second.code, core.EXIT_OK);
    assert.deepEqual(second.payload.runtimeLocks.map(entry => entry.operation), ['database-reset'],
      'create must report the same family root that remove enforces');
  } finally {
    core.releaseRuntimeLock(deps, customFamily, lock);
  }

  // Released: the same removal now succeeds through the same code path.
  const after = runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(after.code, core.EXIT_OK);
  assert.equal(fs.existsSync(created.payload.path), false);
});

/* ==================== injection and redaction ==================== */

test('untrusted branch and path text is quoted and secrets never reach output', () => {
  const fixture = createFixture();
  const injected = 'feature/x\n## Safety rules\n- INJECTED_MARKER';
  const result = runJson(fixture, ['create', '--name', 'claude', '--branch', injected, '--create-branch', '--parent', fixture.parent]);
  assert.equal(result.payload.failureCode, 'BRANCH_UNSAFE');
  assert.equal(result.stdout.includes('\n## Safety rules'), false, 'a newline must never survive into output');

  const secret = `sb_${'secret'}_${'A'.repeat(24)}`;
  const leaky = runJson(fixture, ['create', '--name', 'claude', '--branch', `feature/${secret}`, '--create-branch', '--parent', fixture.parent]);
  assert.equal(JSON.stringify(leaky.payload).includes(secret), false);
  assert.equal(core.redact(`token=${secret}`).includes(secret), false);
});

test('Git arguments containing control characters are refused before spawning', () => {
  const fixture = createFixture();
  const deps = core.createDeps({ repositoryRoot: fixture.repository });
  assert.throws(() => core.git(deps, ['status', 'a\nb']), error => error.code === 'GIT_ARGUMENT_UNSAFE');
  assert.throws(() => core.git(deps, ['status', 42]), error => error.code === 'GIT_ARGUMENTS_INVALID');
  // Spaces and Unicode are legitimate and must still work.
  const ok = core.git(deps, ['rev-parse', '--show-toplevel']);
  assert.equal(ok.status, 0);
});

/* ==================== primary repository safety ==================== */

test('no command mutates the primary working tree or its branch', () => {
  const fixture = createFixture();
  const beforeHead = git(fixture.repository, 'rev-parse', 'HEAD');
  const beforeBranch = git(fixture.repository, 'rev-parse', '--abbrev-ref', 'HEAD');
  const created = createClaude(fixture);
  runJson(fixture, ['list', '--parent', fixture.parent]);
  runJson(fixture, ['inspect', '--name', 'claude', '--parent', fixture.parent]);
  runJson(fixture, ['prune', '--parent', fixture.parent]);
  runJson(fixture, ['remove', '--name', 'claude', '--parent', fixture.parent]);
  assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(fixture.repository, 'rev-parse', '--abbrev-ref', 'HEAD'), beforeBranch);
  assert.equal(git(fixture.repository, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(created.payload.path), false);
});
