'use strict';

// M-2B2b: PR creation/CI-observation/merge/verify sequencing. The git-facing
// half (verifyMergedHead, cleanupMergedWork) is fully covered with real Git
// fixtures in tests/branch-cleanup.test.cjs; this file covers the gh-facing
// half with fake, deps-injected command output — gh is never actually
// invoked here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const core = require('../scripts/dev/automation-core.cjs');
const prLifecycle = require('../scripts/dev/pr-lifecycle.cjs');

function fakeDeps(handler) {
  const calls = [];
  return {
    deps: {
      ...core.createDeps({}),
      now: (() => { let tick = 0; return () => new Date(1754654400000 + tick++ * 1000); })(),
      runCommand: (file, args, options = {}) => {
        const call = { file, args: [...args], options };
        calls.push(call);
        return handler(call, calls);
      }
    },
    calls
  };
}

function checksResult(checks) {
  return { status: 0, stdout: JSON.stringify(checks), stderr: '' };
}

/* ==================== checks parsing / readiness (pure) ==================== */

test('buildChecksCommand requires a positive integer PR number and requests bucket JSON', () => {
  assert.deepEqual(prLifecycle.buildChecksCommand(7), ['pr', 'checks', '7', '--json', 'name,bucket,state']);
  assert.throws(() => prLifecycle.buildChecksCommand(0), error => error.code === 'PR_NUMBER_INVALID');
  assert.throws(() => prLifecycle.buildChecksCommand(-3), error => error.code === 'PR_NUMBER_INVALID');
});

test('parseChecksOutput refuses anything that is not a JSON array', () => {
  assert.throws(() => prLifecycle.parseChecksOutput('not json'), error => error.code === 'GH_CHECKS_OUTPUT_INVALID');
  assert.throws(() => prLifecycle.parseChecksOutput('{"not":"an array"}'), error => error.code === 'GH_CHECKS_OUTPUT_INVALID');
  assert.deepEqual(prLifecycle.parseChecksOutput('[]'), []);
});

test('checksPending detects any pending bucket', () => {
  assert.equal(prLifecycle.checksPending([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'pending' }]), true);
  assert.equal(prLifecycle.checksPending([{ name: 'a', bucket: 'pass' }]), false);
  assert.equal(prLifecycle.checksPending([]), false);
});

test('assessMergeReadiness only observes: not ready with no checks, pending checks, or a failure; ready only when everything passed', () => {
  assert.equal(prLifecycle.assessMergeReadiness([]).ready, false);
  assert.equal(prLifecycle.assessMergeReadiness([{ name: 'a', bucket: 'pending' }]).ready, false);
  assert.equal(prLifecycle.assessMergeReadiness([{ name: 'a', bucket: 'fail' }]).ready, false);
  assert.match(prLifecycle.assessMergeReadiness([{ name: 'a', bucket: 'fail' }]).reason, /a/);
  assert.equal(prLifecycle.assessMergeReadiness([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'pass' }]).ready, true);
});

/* ==================== waitForChecks ==================== */

test('waitForChecks polls read-only gh pr checks until nothing is pending, and only that command', async () => {
  let call = 0;
  const { deps, calls } = fakeDeps(() => {
    call += 1;
    if (call < 3) return checksResult([{ name: 'a', bucket: 'pending' }]);
    return checksResult([{ name: 'a', bucket: 'pass' }]);
  });
  const sleeps = [];
  const checks = await prLifecycle.waitForChecks(deps, {
    prNumber: 5, pollIntervalMs: 1, timeoutMs: 60000, sleep: ms => { sleeps.push(ms); return Promise.resolve(); }
  });
  assert.deepEqual(checks, [{ name: 'a', bucket: 'pass' }]);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.file, 'gh');
    assert.deepEqual(c.args, ['pr', 'checks', '5', '--json', 'name,bucket,state']);
  }
  assert.equal(sleeps.length, 2);
});

test('waitForChecks refuses (does not poll forever) once the timeout is exceeded', async () => {
  const { deps } = fakeDeps(() => checksResult([{ name: 'a', bucket: 'pending' }]));
  await assert.rejects(
    prLifecycle.waitForChecks(deps, { prNumber: 5, pollIntervalMs: 1, timeoutMs: 5, sleep: () => Promise.resolve() }),
    error => error.code === 'CHECKS_TIMEOUT'
  );
});

test('waitForChecks fails closed when gh itself fails', async () => {
  const { deps } = fakeDeps(() => ({ status: 1, stdout: '', stderr: 'gh: not authenticated' }));
  await assert.rejects(
    prLifecycle.waitForChecks(deps, { prNumber: 5, pollIntervalMs: 1, timeoutMs: 60000, sleep: () => Promise.resolve() }),
    error => error.code === 'GH_CHECKS_FAILED'
  );
});

/* ==================== merge / post-merge sha ==================== */

test('mergePullRequest constructs exactly the squash-only command from branch-cleanup.cjs', () => {
  const { deps, calls } = fakeDeps(() => ({ status: 0, stdout: '', stderr: '' }));
  prLifecycle.mergePullRequest(deps, { prNumber: 9 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'gh');
  assert.deepEqual(calls[0].args, ['pr', 'merge', '9', '--squash']);
});

test('mergePullRequest fails closed on a non-zero gh exit', () => {
  const { deps } = fakeDeps(() => ({ status: 1, stdout: '', stderr: 'merge blocked: required check pending' }));
  assert.throws(() => prLifecycle.mergePullRequest(deps, { prNumber: 9 }), error => error.code === 'GH_MERGE_FAILED');
});

test('fetchMergeCommitSha requires state MERGED and a full SHA, and returns it lowercased', () => {
  const sha = 'A'.repeat(40);
  const { deps } = fakeDeps(() => ({ status: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: sha } }), stderr: '' }));
  assert.equal(prLifecycle.fetchMergeCommitSha(deps, { prNumber: 9 }), sha.toLowerCase());
});

test('fetchMergeCommitSha refuses a PR that is not reported as merged', () => {
  const { deps } = fakeDeps(() => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeCommit: null }), stderr: '' }));
  assert.throws(() => prLifecycle.fetchMergeCommitSha(deps, { prNumber: 9 }), error => error.code === 'PR_NOT_MERGED');
});

test('fetchMergeCommitSha fails closed on invalid JSON', () => {
  const { deps } = fakeDeps(() => ({ status: 0, stdout: 'not json', stderr: '' }));
  assert.throws(() => prLifecycle.fetchMergeCommitSha(deps, { prNumber: 9 }), error => error.code === 'GH_PR_VIEW_OUTPUT_INVALID');
});

/* ==================== command-shape source guarantees ==================== */

test('this module never constructs anything other than --squash for gh pr merge, and never dispatches a workflow', () => {
  const source = fs.readFileSync(require.resolve('../scripts/dev/pr-lifecycle.cjs'), 'utf8');
  const code = source.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /--admin/);
  assert.doesNotMatch(code, /--force/);
  assert.doesNotMatch(code, /workflow_dispatch|workflow\s+run/);
  // The only place a merge command may be assembled is branch-cleanup.cjs's
  // buildMergeCommand, reused here — this file must not build its own.
  assert.doesNotMatch(code, /'pr',\s*'merge'/);
  assert.match(code, /branchCleanup\.buildMergeCommand/);
});
