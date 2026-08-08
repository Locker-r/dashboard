'use strict';

// M-2B2b: fail-closed local branch cleanup. Real Git fixtures, mirroring
// tests/agent-worktree.test.cjs — merge-base reachability, worktree-checkout
// refusal, and `-d`'s own unmerged refusal cannot be proven with mocked git
// output.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('../scripts/dev/automation-core.cjs');
const worktreeTool = require('../scripts/dev/agent-worktree.cjs');
const branchCleanup = require('../scripts/dev/branch-cleanup.cjs');

const PACKAGE_NAME = require('../scripts/dev/doctor.cjs').PACKAGE_NAME;
const fixtureRoots = [];

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function gitAllowFail(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
}

// origin (bare) <- local (working clone). A real remote is required to
// exercise "fetch succeeds" and "ancestor of origin/main" meaningfully.
function createFixture(label = 'branch cleanup fixture') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)));
  fixtureRoots.push(base);
  const origin = path.join(base, 'origin.git');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');

  const local = path.join(base, 'proyecto dashboard');
  fs.mkdirSync(local);
  git(local, 'init', '-q', '-b', 'main');
  git(local, 'config', 'user.email', 'fixture@example.invalid');
  git(local, 'config', 'user.name', 'Branch Cleanup Fixture');
  git(local, 'config', 'commit.gpgsign', 'false');
  git(local, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(local, 'package.json'), `${JSON.stringify({ name: PACKAGE_NAME, version: '1.0.0' }, null, 2)}\n`);
  git(local, 'add', '--', 'package.json');
  git(local, 'commit', '-q', '-m', 'fixture base');
  git(local, 'push', '-q', 'origin', 'main');
  return { base, origin, local, parent: path.join(base, 'worktrees') };
}

function deps(overrides = {}) {
  return core.createDeps({ repositoryRoot: overrides.repositoryRoot, ...overrides });
}

// Creates branch `name` in `local`, with one commit, and (unless
// `push: false`) merges it into origin's main so it is a real ancestor —
// the "already merged, ready to clean up" baseline every refusal test
// starts from and then breaks in exactly one way.
function createMergedBranch(fixture, name, options = {}) {
  git(fixture.local, 'checkout', '-q', '-b', name, 'main');
  fs.writeFileSync(path.join(fixture.local, `${name.replace(/[/\\]/g, '_')}.txt`), 'content\n');
  git(fixture.local, 'add', '-A');
  git(fixture.local, 'commit', '-q', '-m', `work on ${name}`);
  if (options.push !== false) {
    git(fixture.local, 'push', '-q', 'origin', `HEAD:refs/heads/${name}`);
    git(fixture.local, 'checkout', '-q', 'main');
    git(fixture.local, 'merge', '-q', '--no-ff', name, '-m', `merge ${name}`);
    git(fixture.local, 'push', '-q', 'origin', 'main');
  } else {
    git(fixture.local, 'checkout', '-q', 'main');
  }
}

test.after(() => {
  for (const root of fixtureRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/* ==================== fail-closed preconditions ==================== */

test('a protected branch (main/master/HEAD) is refused', () => {
  const fixture = createFixture();
  for (const name of ['main', 'master', 'HEAD']) {
    assert.throws(
      () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: name }),
      error => error.code === 'BRANCH_PROTECTED'
    );
  }
});

test('an unsafe or non-allowlisted branch name is refused', () => {
  const fixture = createFixture();
  assert.throws(
    () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: 'random/topic' }),
    error => error.code === 'BRANCH_PREFIX_NOT_ALLOWLISTED'
  );
  for (const unsafe of ['-rf', 'feat/../escape', 'feat/has space', 'feat/end.lock']) {
    assert.throws(
      () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: unsafe }),
      error => error.code === 'BRANCH_UNSAFE'
    );
  }
});

test('a branch checked out in another worktree is refused', () => {
  const fixture = createFixture();
  createMergedBranch(fixture, 'feat/checked-out-elsewhere');
  fs.mkdirSync(fixture.parent, { recursive: true });
  const wt = path.join(fixture.parent, 'elsewhere');
  git(fixture.local, 'worktree', 'add', wt, 'feat/checked-out-elsewhere');
  try {
    assert.throws(
      () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: 'feat/checked-out-elsewhere' }),
      error => error.code === 'BRANCH_CHECKED_OUT'
    );
  } finally {
    git(fixture.local, 'worktree', 'remove', '--force', wt);
  }
});

test('the currently checked-out branch in the primary repository is refused', () => {
  const fixture = createFixture();
  createMergedBranch(fixture, 'feat/current');
  git(fixture.local, 'checkout', '-q', 'feat/current');
  try {
    assert.throws(
      () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: 'feat/current' }),
      error => error.code === 'BRANCH_IS_CURRENT'
    );
  } finally {
    git(fixture.local, 'checkout', '-q', 'main');
  }
});

test('a locked index or an in-progress Git operation in the primary repository is refused', () => {
  const fixture = createFixture();
  createMergedBranch(fixture, 'feat/locked');
  const gitDir = git(fixture.local, 'rev-parse', '--git-dir');
  const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(fixture.local, gitDir);
  const lockPath = path.join(absoluteGitDir, 'index.lock');
  fs.writeFileSync(lockPath, '');
  try {
    assert.throws(
      () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: 'feat/locked' }),
      error => error.code === 'GIT_OPERATION_IN_PROGRESS'
    );
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test('a branch not reachable from origin/main is refused', () => {
  const fixture = createFixture();
  createMergedBranch(fixture, 'feat/unmerged', { push: false });
  assert.throws(
    () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: 'feat/unmerged' }),
    error => error.code === 'BRANCH_NOT_MERGED'
  );
});

test('a missing or ambiguous origin remote is refused', () => {
  const fixture = createFixture();
  createMergedBranch(fixture, 'feat/no-origin');
  git(fixture.local, 'remote', 'rename', 'origin', 'upstream');
  try {
    assert.throws(
      () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: 'feat/no-origin' }),
      error => error.code === 'AMBIGUOUS_OR_MISSING_ORIGIN'
    );
    git(fixture.local, 'remote', 'add', 'origin', fixture.origin);
    assert.throws(
      () => branchCleanup.assertBranchDeletable(deps(), { repositoryRoot: fixture.local, branch: 'feat/no-origin' }),
      error => error.code === 'AMBIGUOUS_OR_MISSING_ORIGIN'
    );
  } finally {
    gitAllowFail(fixture.local, 'remote', 'remove', 'upstream');
  }
});

/* ==================== deletion behaviour ==================== */

test('deletion uses `git branch -d` only; `-D` never appears anywhere in the module\'s code', () => {
  const source = fs.readFileSync(require.resolve('../scripts/dev/branch-cleanup.cjs'), 'utf8');
  const code = source.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /-D\b/);
  assert.doesNotMatch(code, /'branch',\s*'-D'/);
  assert.match(code, /'branch',\s*'-d'/);

  const fixture = createFixture();
  createMergedBranch(fixture, 'feat/deletable');
  const result = branchCleanup.deleteLocalBranch(deps(), { repositoryRoot: fixture.local, branch: 'feat/deletable' });
  assert.equal(result.deleted, true);
  assert.equal(result.alreadyAbsent, false);
  assert.throws(() => git(fixture.local, 'rev-parse', '--verify', 'refs/heads/feat/deletable'));
});

test('no remote-delete command exists anywhere in this module', () => {
  // Code only — the module's own prose comment documenting what is
  // forbidden legitimately contains these same substrings.
  const code = fs.readFileSync(require.resolve('../scripts/dev/branch-cleanup.cjs'), 'utf8')
    .split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /push[^\n]*--delete/);
  assert.doesNotMatch(code, /push[^\n]*:refs\/heads/);
  assert.doesNotMatch(code, /push[^\n]*origin[^\n]*:/);
  assert.doesNotMatch(code, /'push'/);
});

test('deleting an already-absent branch is idempotent success, not a refusal', () => {
  const fixture = createFixture();
  const result = branchCleanup.deleteLocalBranch(deps(), { repositoryRoot: fixture.local, branch: 'feat/never-existed' });
  assert.equal(result.alreadyAbsent, true);
  assert.equal(result.deleted, false);
  // Running it again must produce the exact same outcome, not an error.
  const again = branchCleanup.deleteLocalBranch(deps(), { repositoryRoot: fixture.local, branch: 'feat/never-existed' });
  assert.deepEqual(again, result);
});

/* ==================== composed cleanup: stop at first refusal ==================== */

test('cleanupMergedWork stops at the first refusal and reports exactly what completed', () => {
  const fixture = createFixture();
  createMergedBranch(fixture, 'feat/no-worktree');
  // No worktreeName given: worktree-removal step is skipped entirely, so the
  // only possible refusal is at branch deletion. Force one by leaving the
  // branch unpushed (unmerged).
  createMergedBranch(fixture, 'feat/partial', { push: false });
  const result = branchCleanup.cleanupMergedWork(deps(), { repositoryRoot: fixture.local, branch: 'feat/partial' });
  assert.equal(result.completed.length, 0, 'nothing should have completed before the refusal');
  assert.equal(result.refused.step, 'branch-deletion');
  assert.equal(result.refused.code, 'BRANCH_NOT_MERGED');
});

test('cleanupMergedWork removes the owned worktree first, then deletes the branch', () => {
  const fixture = createFixture();
  fs.mkdirSync(fixture.parent, { recursive: true });
  const capture = { stdout: '', stderr: '' };
  const streams = { stdout: { write: value => { capture.stdout += String(value); } }, stderr: { write: value => { capture.stderr += String(value); } } };
  const created = worktreeTool.main(
    ['create', '--name', 'cleanuptest', '--role', 'claude', '--branch', 'feature/owned-cleanup', '--create-branch', '--parent', fixture.parent, '--json'],
    { repositoryRoot: fixture.local, streams, now: () => new Date('2026-08-08T09:00:00.000Z'), randomToken: () => 'cleanuptesttoken001' }
  );
  assert.equal(created, 0);
  const createdPath = JSON.parse(capture.stdout).path;
  git(createdPath, 'commit', '--allow-empty', '-q', '-m', 'owned worktree work');
  git(fixture.local, 'fetch', createdPath, 'feature/owned-cleanup:refs/heads/feature/owned-cleanup-merge-src');
  git(fixture.local, 'merge', '-q', '--no-ff', 'feature/owned-cleanup-merge-src', '-m', 'merge owned work');
  git(fixture.local, 'branch', '-D', 'feature/owned-cleanup-merge-src');
  git(fixture.local, 'push', '-q', 'origin', 'main');

  const result = branchCleanup.cleanupMergedWork(deps(), {
    repositoryRoot: fixture.local, branch: 'feature/owned-cleanup',
    worktreeName: 'cleanuptest', worktreeParent: fixture.parent
  });
  assert.equal(result.refused, null);
  assert.deepEqual(result.completed.map(step => step.step), ['worktree-removed', 'branch-deleted']);
  assert.equal(fs.existsSync(createdPath), false);
});

test('a dirty owned worktree refuses cleanup at the worktree-removal step, before any branch deletion is attempted', () => {
  const fixture = createFixture();
  fs.mkdirSync(fixture.parent, { recursive: true });
  const capture = { stdout: '', stderr: '' };
  const streams = { stdout: { write: value => { capture.stdout += String(value); } }, stderr: { write: value => { capture.stderr += String(value); } } };
  const created = worktreeTool.main(
    ['create', '--name', 'dirtytest', '--role', 'claude', '--branch', 'feature/dirty-cleanup', '--create-branch', '--parent', fixture.parent, '--json'],
    { repositoryRoot: fixture.local, streams, now: () => new Date('2026-08-08T09:00:00.000Z'), randomToken: () => 'dirtytesttoken0001' }
  );
  assert.equal(created, 0);
  const createdPath = JSON.parse(capture.stdout).path;
  fs.writeFileSync(path.join(createdPath, 'untracked.txt'), 'oops\n');

  const result = branchCleanup.cleanupMergedWork(deps(), {
    repositoryRoot: fixture.local, branch: 'feature/dirty-cleanup',
    worktreeName: 'dirtytest', worktreeParent: fixture.parent
  });
  assert.equal(result.completed.length, 0);
  assert.equal(result.refused.step, 'worktree-removal');
  assert.equal(result.refused.code, 'WORKTREE_UNTRACKED_PRESENT');
  assert.equal(fs.existsSync(createdPath), true, 'the dirty worktree must be left in place');
  fs.rmSync(path.join(createdPath, 'untracked.txt'), { force: true });
});

/* ==================== post-merge verification ==================== */

test('verifyMergedHead confirms origin/main equals the expected SHA, and refuses a mismatch', () => {
  const fixture = createFixture();
  const head = git(fixture.local, 'rev-parse', 'main');
  const verified = branchCleanup.verifyMergedHead(deps(), { repositoryRoot: fixture.local, expectedSha: head });
  assert.equal(verified.head, head.toLowerCase());

  const wrongSha = 'f'.repeat(40);
  assert.throws(
    () => branchCleanup.verifyMergedHead(deps(), { repositoryRoot: fixture.local, expectedSha: wrongSha }),
    error => error.code === 'MERGE_HEAD_MISMATCH'
  );
});

test('verifyMergedHead requires a full, well-formed SHA', () => {
  const fixture = createFixture();
  assert.throws(
    () => branchCleanup.verifyMergedHead(deps(), { repositoryRoot: fixture.local, expectedSha: 'not-a-sha' }),
    error => error.code === 'EXPECTED_SHA_INVALID'
  );
});

/* ==================== PR merge command shape ==================== */

test('buildMergeCommand only ever produces squash-merge of one explicit PR number', () => {
  const args = branchCleanup.buildMergeCommand(42);
  assert.deepEqual(args, ['pr', 'merge', '42', '--squash']);
  for (const forbidden of ['--admin', '--force', '--merge', '--rebase', '--auto', '--delete-branch']) {
    assert.ok(!args.includes(forbidden), `must never include ${forbidden}`);
  }
  assert.throws(() => branchCleanup.buildMergeCommand(0), error => error.code === 'PR_NUMBER_INVALID');
  assert.throws(() => branchCleanup.buildMergeCommand(-1), error => error.code === 'PR_NUMBER_INVALID');
  assert.throws(() => branchCleanup.buildMergeCommand('42'), error => error.code === 'PR_NUMBER_INVALID');
});

test('resolveSingleOrigin and the merge-readiness path never construct a merge or delete command themselves', () => {
  const source = fs.readFileSync(require.resolve('../scripts/dev/branch-cleanup.cjs'), 'utf8');
  const mergeCommandCalls = source.match(/'pr',\s*'merge'/g) || [];
  assert.equal(mergeCommandCalls.length, 1, 'exactly one place may construct a merge command');
});
