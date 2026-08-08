'use strict';

// M-2B2b: fail-closed local branch cleanup after a PR merge, and the small
// PR/merge/post-merge primitives it composes with. See docs/decisions.md
// ADR-012 for the design this implements.
//
// Reuses scripts/dev/automation-core.cjs and scripts/dev/agent-worktree.cjs
// entirely unchanged: this file adds only the branch-deletion safety layer
// those modules do not already provide, plus the thin PR/merge/verify
// sequencing. It never edits, forks, or weakens either module.
//
// What this file will never do, by construction:
//   - `git branch -D` (only `-d`, which itself refuses an unmerged branch).
//   - Any remote branch deletion (`git push --delete` / `git push :ref`).
//     Those already classify as a production action and are refused
//     unconditionally by the release guard; this file never constructs them.
//   - `gh pr merge` with anything other than exactly `--squash`.
//   - Steal, force, retry, or auto-clear anything a precondition refused.

const core = require('./automation-core.cjs');
const worktreeTool = require('./agent-worktree.cjs');

// Two conventions coexist in this repository and a branch reaching this
// module may legitimately carry either: docs/release-governance.md,
// "Branching model" (feat/, fix/, chore/, docs/) is the one this repository's
// actual branch history follows; automation-core.cjs's own BRANCH_PREFIXES
// (feature/, fix/, docs/) is the narrower, older convention
// scripts/dev/agent-worktree.cjs still requires of every implementation
// worktree it creates. A branch this module is asked to clean up after
// `agent:worktree create` must satisfy that requirement to exist at all, so
// this allowlist is their union, not a new, wider policy of its own.
const CLEANUP_BRANCH_PREFIXES = Object.freeze(['feat/', 'feature/', 'fix/', 'chore/', 'docs/']);

function assertCleanupPrefix(branch) {
  if (!CLEANUP_BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix))) {
    throw new core.AutomationError('BRANCH_PREFIX_NOT_ALLOWLISTED',
      `Branch ${core.quoteUntrusted(branch)} does not start with an allowlisted branch prefix (${CLEANUP_BRANCH_PREFIXES.join(', ')}).`,
      core.EXIT_BLOCKED);
  }
}

function branchExists(deps, root, branch) {
  const result = core.git(deps, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root });
  return Boolean(result && result.status === 0);
}

// Exactly one remote, and it must be named `origin` — an ambiguous or
// differently-named remote makes "the" upstream undefined, and this
// function's caller (assertMergedIntoOrigin) must never guess.
function resolveSingleOrigin(deps, root) {
  const result = core.git(deps, ['remote'], { cwd: root, timeoutMs: 30000 });
  if (!result || result.status !== 0) {
    throw new core.AutomationError('GIT_REMOTE_UNAVAILABLE', core.bounded(core.commandOutput(result)), core.EXIT_BLOCKED);
  }
  const remotes = String(result.stdout || '').split(/\r?\n/).map(entry => entry.trim()).filter(Boolean);
  if (remotes.length !== 1 || remotes[0] !== 'origin') {
    throw new core.AutomationError('AMBIGUOUS_OR_MISSING_ORIGIN',
      `Expected exactly one remote named origin; found: ${remotes.length ? remotes.join(', ') : 'none'}.`, core.EXIT_BLOCKED);
  }
  return 'origin';
}

function assertNotCheckedOutAnywhere(deps, root, branch) {
  const worktrees = core.listWorktrees(deps, root);
  const found = worktrees.find(entry => core.shortBranch(entry.branch) === branch);
  if (found) {
    throw new core.AutomationError('BRANCH_CHECKED_OUT',
      `Branch ${core.quoteUntrusted(branch)} is checked out in worktree ${core.quoteUntrusted(found.path)}.`, core.EXIT_BLOCKED,
      { remediation: 'Remove that worktree first, then retry.' });
  }
}

// Not the branch currently checked out in the primary repository, and the
// primary repository itself is not mid-operation or index-locked. Deleting a
// local branch ref happens against the primary repository's own .git, so its
// own state — not any worktree's — is what matters here.
function assertPrimaryRepositoryReady(deps, root, branch) {
  const state = core.readRepositoryState(deps, root);
  if (state.branch === branch) {
    throw new core.AutomationError('BRANCH_IS_CURRENT',
      `Refusing to delete the currently checked-out branch ${core.quoteUntrusted(branch)}.`, core.EXIT_BLOCKED);
  }
  if (state.indexLocked || state.operationsInProgress.length) {
    throw new core.AutomationError('GIT_OPERATION_IN_PROGRESS',
      'The repository has a locked index or an incomplete Git operation.', core.EXIT_BLOCKED);
  }
}

function assertMergedIntoOrigin(deps, root, branch, remote) {
  const fetch = core.git(deps, ['fetch', remote], { cwd: root, timeoutMs: 60000 });
  if (!fetch || fetch.status !== 0) {
    throw new core.AutomationError('GIT_FETCH_FAILED', core.bounded(core.commandOutput(fetch)), core.EXIT_BLOCKED);
  }
  const ancestor = core.git(deps, ['merge-base', '--is-ancestor', branch, `${remote}/main`], { cwd: root, timeoutMs: 30000 });
  if (!ancestor || ancestor.status !== 0) {
    throw new core.AutomationError('BRANCH_NOT_MERGED',
      `Branch ${core.quoteUntrusted(branch)} is not an ancestor of ${remote}/main.`, core.EXIT_BLOCKED,
      { remediation: 'Merge the pull request first, or inspect why the branch diverged.' });
  }
}

// The full fail-closed precondition chain for local branch deletion. Throws
// at the first violated precondition — callers never see a partial or
// reordered check, and nothing after the throw runs.
function assertBranchDeletable(deps, options) {
  const root = options.repositoryRoot;
  const branch = core.assertBranchNameSafe(options.branch); // safe name; not main/master/HEAD
  assertCleanupPrefix(branch);
  assertPrimaryRepositoryReady(deps, root, branch); // not current; no index.lock; no in-progress op
  assertNotCheckedOutAnywhere(deps, root, branch); // not checked out in ANY worktree
  const remote = resolveSingleOrigin(deps, root); // exactly one unambiguous origin
  assertMergedIntoOrigin(deps, root, branch, remote); // fetch + ancestor-of-origin/main
  return Object.freeze({ branch, remote });
}

// `git branch -d` only — never `-D`. An already-absent branch is a no-op
// success: repeated cleanup runs must be idempotent, not increasingly noisy.
function deleteLocalBranch(deps, options) {
  const root = options.repositoryRoot;
  const name = String(options.branch || '');
  if (!branchExists(deps, root, name)) {
    return Object.freeze({ branch: name, deleted: false, alreadyAbsent: true });
  }
  const { branch } = assertBranchDeletable(deps, options);
  const result = core.git(deps, ['branch', '-d', branch], { cwd: root, timeoutMs: 30000 });
  if (!result || result.status !== 0) {
    throw new core.AutomationError('BRANCH_DELETE_FAILED', core.bounded(core.commandOutput(result)), core.EXIT_BLOCKED);
  }
  return Object.freeze({ branch, deleted: true, alreadyAbsent: false });
}

// Cleanup order: (3) safe agent-worktree removal (the existing, unmodified
// tool — ADR-011's ownership-marker/cleanliness/reachability/non-force
// guards apply exactly as they do for any other agent:worktree remove call),
// then (4) local `git branch -d`. Stops at the first refusal and reports
// exactly what completed and what was refused; never attempts remote
// deletion at any point.
function cleanupMergedWork(deps, options) {
  const steps = [];
  if (options.worktreeName) {
    try {
      // removeWorktree resolves the repository from deps.repositoryRoot
      // directly (not from an options field) — always pin it to the exact
      // root this call was given, regardless of what the caller's deps
      // object otherwise carries.
      const worktreeDeps = { ...deps, repositoryRoot: options.repositoryRoot };
      const removal = worktreeTool.removeWorktree(worktreeDeps, { name: options.worktreeName, parent: options.worktreeParent || null });
      steps.push(Object.freeze({ step: 'worktree-removed', name: options.worktreeName, path: removal.path }));
    } catch (error) {
      return Object.freeze({
        completed: Object.freeze(steps),
        refused: Object.freeze({ step: 'worktree-removal', code: error.code, message: error.message })
      });
    }
  }
  try {
    const branchResult = deleteLocalBranch(deps, { repositoryRoot: options.repositoryRoot, branch: options.branch });
    steps.push(Object.freeze({ step: 'branch-deleted', ...branchResult }));
  } catch (error) {
    return Object.freeze({
      completed: Object.freeze(steps),
      refused: Object.freeze({ step: 'branch-deletion', code: error.code, message: error.message })
    });
  }
  return Object.freeze({ completed: Object.freeze(steps), refused: null });
}

// Post-merge verification: origin/main must equal the PR's own
// mergeCommit.oid, read via a fresh fetch — never asserted from the merge
// command's own claimed success alone.
function verifyMergedHead(deps, options) {
  const root = options.repositoryRoot;
  const remote = options.remote || 'origin';
  const expected = String(options.expectedSha || '').toLowerCase();
  if (!core.FULL_SHA.test(expected)) {
    throw core.usageError('EXPECTED_SHA_INVALID', 'A full 40-character commit SHA is required.');
  }
  const fetch = core.git(deps, ['fetch', remote, 'main'], { cwd: root, timeoutMs: 60000 });
  if (!fetch || fetch.status !== 0) {
    throw new core.AutomationError('GIT_FETCH_FAILED', core.bounded(core.commandOutput(fetch)), core.EXIT_BLOCKED);
  }
  const head = core.gitText(deps, ['rev-parse', `${remote}/main`], 'GIT_REV_PARSE_FAILED', { cwd: root }).toLowerCase();
  if (head !== expected) {
    throw new core.AutomationError('MERGE_HEAD_MISMATCH',
      `${remote}/main is at ${head}, expected ${expected} (the PR's mergeCommit.oid).`, core.EXIT_BLOCKED);
  }
  return Object.freeze({ remote, head });
}

// The only `gh pr merge` shape this module (or anything built on it) may
// ever construct. No `--admin`, `--force`, `--merge`, `--rebase`, or any
// other flag — squash merge of one explicit, positive-integer PR number,
// matching docs/release-governance.md's merge policy exactly.
function buildMergeCommand(pullRequestNumber) {
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw core.usageError('PR_NUMBER_INVALID', 'A positive integer pull request number is required.');
  }
  return Object.freeze(['pr', 'merge', String(pullRequestNumber), '--squash']);
}

module.exports = Object.freeze({
  CLEANUP_BRANCH_PREFIXES,
  assertCleanupPrefix,
  branchExists,
  resolveSingleOrigin,
  assertNotCheckedOutAnywhere,
  assertPrimaryRepositoryReady,
  assertMergedIntoOrigin,
  assertBranchDeletable,
  deleteLocalBranch,
  cleanupMergedWork,
  verifyMergedHead,
  buildMergeCommand
});
