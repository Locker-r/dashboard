'use strict';

// M-2B2b: PR creation, CI observation, squash merge, and post-merge
// verification — the small, safe half of Automation PR 2-B2b. Branch and
// worktree cleanup live in scripts/dev/branch-cleanup.cjs; this file only
// adds the gh-facing sequencing around it. See docs/decisions.md ADR-012.
//
// Every command this file can construct is one already covered by the
// release guard's classifier as `local-write`, not `production`:
// `gh pr create`, read-only `gh pr checks`/`gh pr view`, and
// `gh pr merge <n> --squash` with no other flag (branch-cleanup.cjs's
// buildMergeCommand is the only place that command is assembled). Nothing
// here decides to merge on its own — assessMergeReadiness only observes.

const core = require('./automation-core.cjs');
const branchCleanup = require('./branch-cleanup.cjs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildChecksCommand(prNumber) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw core.usageError('PR_NUMBER_INVALID', 'A positive integer pull request number is required.');
  }
  return Object.freeze(['pr', 'checks', String(prNumber), '--json', 'name,bucket,state']);
}

function parseChecksOutput(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch {
    throw new core.AutomationError('GH_CHECKS_OUTPUT_INVALID', 'gh pr checks did not return valid JSON.', core.EXIT_BLOCKED);
  }
  if (!Array.isArray(parsed)) {
    throw new core.AutomationError('GH_CHECKS_OUTPUT_INVALID', 'gh pr checks JSON was not an array.', core.EXIT_BLOCKED);
  }
  return parsed;
}

function bucketOf(check) {
  return String((check && (check.bucket || check.state)) || '').toLowerCase();
}

function checksPending(checks) {
  return checks.some(check => bucketOf(check) === 'pending');
}

// An observation, never a decision to act: this never merges anything and
// is not consulted by mergePullRequest. A caller reads `.ready` and decides.
function assessMergeReadiness(checks) {
  if (!checks.length) return Object.freeze({ ready: false, reason: 'No checks were reported.' });
  if (checksPending(checks)) return Object.freeze({ ready: false, reason: 'One or more checks are still pending.' });
  const failing = checks.filter(check => bucketOf(check) === 'fail');
  if (failing.length) {
    return Object.freeze({ ready: false, reason: `Failing checks: ${failing.map(check => check.name).join(', ')}.` });
  }
  return Object.freeze({ ready: true, reason: 'All reported checks passed.' });
}

function runGh(deps, args, options = {}) {
  const result = deps.runCommand('gh', args, { cwd: options.cwd, timeoutMs: options.timeoutMs || 60000 });
  if (!result || result.status !== 0) {
    throw new core.AutomationError(options.failureCode || 'GH_COMMAND_FAILED', core.bounded(core.commandOutput(result)), core.EXIT_BLOCKED);
  }
  return result;
}

// Read-only polling only — gh pr checks. Never dispatches, never retries a
// failed check, never merges. Refuses (does not silently keep polling
// forever) once timeoutMs is exceeded.
async function waitForChecks(deps, options) {
  const prNumber = options.prNumber;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 20000;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 600000;
  const started = deps.now().getTime();
  const sleepFn = options.sleep || sleep;
  for (;;) {
    const result = runGh(deps, buildChecksCommand(prNumber), { cwd: options.repositoryRoot, failureCode: 'GH_CHECKS_FAILED' });
    const checks = parseChecksOutput(result.stdout);
    if (!checksPending(checks)) return checks;
    if (deps.now().getTime() - started > timeoutMs) {
      throw new core.AutomationError('CHECKS_TIMEOUT', `Checks for PR #${prNumber} were still pending after ${timeoutMs}ms.`, core.EXIT_BLOCKED);
    }
    await sleepFn(pollIntervalMs);
  }
}

// The only merge this module can perform: branch-cleanup.cjs's
// buildMergeCommand, which is squash-only and refuses anything else at
// construction. No `--admin`, `--force`, `--merge`, or `--rebase` flag can
// ever reach this call.
function mergePullRequest(deps, options) {
  const args = branchCleanup.buildMergeCommand(options.prNumber);
  return runGh(deps, args, { cwd: options.repositoryRoot, timeoutMs: 60000, failureCode: 'GH_MERGE_FAILED' });
}

// Reads the merge outcome back from GitHub rather than trusting the merge
// command's own exit code alone — the same "prove it, don't assume it"
// discipline this repository's release harness already applies elsewhere.
function fetchMergeCommitSha(deps, options) {
  const result = runGh(deps, ['pr', 'view', String(options.prNumber), '--json', 'mergeCommit,state'], {
    cwd: options.repositoryRoot, timeoutMs: 30000, failureCode: 'GH_PR_VIEW_FAILED'
  });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch {
    throw new core.AutomationError('GH_PR_VIEW_OUTPUT_INVALID', 'gh pr view did not return valid JSON.', core.EXIT_BLOCKED);
  }
  if (parsed.state !== 'MERGED' || !parsed.mergeCommit || !core.FULL_SHA.test(String(parsed.mergeCommit.oid || ''))) {
    throw new core.AutomationError('PR_NOT_MERGED', `PR #${options.prNumber} is not reported as merged with a resolvable commit.`, core.EXIT_BLOCKED);
  }
  return String(parsed.mergeCommit.oid).toLowerCase();
}

// Cleanup order (docs/decisions.md ADR-012):
//   1. confirm the PR is merged (fetchMergeCommitSha already required this);
//   2. verify origin/main equals mergeCommit.oid;
//   3. safe agent-worktree removal (only if a worktreeName was given);
//   4. local `git branch -d`;
//   5. remote branch left untouched, always.
function mergeAndCleanup(deps, options) {
  const mergeCommitSha = fetchMergeCommitSha(deps, options);
  const verified = branchCleanup.verifyMergedHead(deps, {
    repositoryRoot: options.repositoryRoot, remote: options.remote, expectedSha: mergeCommitSha
  });
  const cleanup = branchCleanup.cleanupMergedWork(deps, {
    repositoryRoot: options.repositoryRoot, branch: options.branch,
    worktreeName: options.worktreeName || null, worktreeParent: options.worktreeParent || null
  });
  return Object.freeze({ mergeCommitSha, verifiedHead: verified.head, cleanup });
}

module.exports = Object.freeze({
  buildChecksCommand,
  parseChecksOutput,
  checksPending,
  assessMergeReadiness,
  waitForChecks,
  mergePullRequest,
  fetchMergeCommitSha,
  mergeAndCleanup
});
