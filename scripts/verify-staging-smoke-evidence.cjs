'use strict';

// Read-only B1 acceptance verifier for the `proof-runtime-suite` criterion.
//
// It never dispatches scripts/release's own staging-cloud-smoke.yml workflow
// and never mutates anything: it reads the workflow's run history through the
// GitHub API (via `gh api`, read-only) and reads local git state, nothing
// else. It exists because the original criterion command,
// `node scripts/lead-proof-smoke.cjs`, is intentionally local-only and needs
// a service-role key an agent must never hold — see
// docs/release-gates.md, "B1 proof-runtime-suite: staging evidence
// verification".
//
// Passing means: a staging-cloud-smoke.yml run on main completed with
// conclusion "success", and its head_sha is either the exact commit being
// judged or an ancestor of it whose only differences are drift-allowed
// (release/scripts/release-core.cjs's own isEvidenceDriftAllowed — the same
// predicate G5b uses, not a separate or looser one). Anything else fails
// closed: a failed run, a run for the wrong workflow, a run whose head_sha
// cannot be reached from the current commit, or a run whose head_sha is an
// ancestor but the diff since then touches product/security-relevant code.

const { spawnSync } = require('node:child_process');
const { isEvidenceDriftAllowed } = require('./release/release-core.cjs');

const OWNER = 'Locker-r';
const REPO = 'dashboard';
const WORKFLOW_FILE = 'staging-cloud-smoke.yml';
const RUNS_PER_PAGE = 20;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;

const EXIT = Object.freeze({ OK: 0, VALIDATION: 1, BLOCKED: 2, INTERNAL: 70 });

function createDeps(overrides = {}) {
  return Object.freeze({
    run: (command, args) => spawnSync(command, args, { encoding: 'utf8' }),
    log: line => process.stderr.write(`${line}\n`),
    emit: line => process.stdout.write(`${line}\n`),
    ...overrides
  });
}

function currentHead(deps) {
  const result = deps.run('git', ['rev-parse', 'HEAD']);
  if (result.status !== 0 || !String(result.stdout || '').trim()) throw new Error('HEAD_UNRESOLVABLE');
  return String(result.stdout).trim();
}

function isAncestor(deps, candidate, head) {
  const result = deps.run('git', ['merge-base', '--is-ancestor', candidate, head]);
  return result.status === 0;
}

// The exact predicate G5b already uses for its own stale-evidence check
// (scripts/release/release-core.cjs `isCodeUnchangedSince`) — reimplemented
// here only because this script has no access to the harness's internal
// command ledger, not because the rule itself is different.
function isCodeUnchangedSince(deps, candidate, head) {
  if (candidate === head) return true;
  if (!HEAD_SHA_PATTERN.test(candidate) || !isAncestor(deps, candidate, head)) return false;
  const diff = deps.run('git', ['diff', '--name-only', candidate, head]);
  if (diff.status !== 0) return false;
  const changed = String(diff.stdout || '').split(/\r?\n/).filter(Boolean);
  return changed.every(file => isEvidenceDriftAllowed(file));
}

function fetchRuns(deps) {
  const result = deps.run('gh', [
    'api', `repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs`,
    '-f', `per_page=${RUNS_PER_PAGE}`, '-f', 'branch=main'
  ]);
  if (result.status !== 0) {
    throw new Error(`GH_API_FAILED:${String(result.stderr || result.error || '').trim().slice(0, 300)}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('GH_API_RESPONSE_INVALID'); }
  if (!parsed || !Array.isArray(parsed.workflow_runs)) throw new Error('GH_API_RESPONSE_INVALID');
  return parsed.workflow_runs;
}

function findQualifyingRun(deps, runs, head) {
  const attempts = [];
  for (const run of runs) {
    const sha = String(run && run.head_sha || '');
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
      attempts.push({ runId: run && run.id, sha, reason: `status=${run && run.status} conclusion=${run && run.conclusion}` });
      continue;
    }
    if (!HEAD_SHA_PATTERN.test(sha)) {
      attempts.push({ runId: run.id, sha, reason: 'INVALID_HEAD_SHA' });
      continue;
    }
    if (!isCodeUnchangedSince(deps, sha, head)) {
      attempts.push({ runId: run.id, sha, reason: 'NOT_HEAD_OR_DRIFT_DISALLOWED' });
      continue;
    }
    return { run, sha, attempts };
  }
  return { run: null, sha: null, attempts };
}

function main(argv, overrides = {}) {
  const deps = createDeps(overrides);
  try {
    const head = currentHead(deps);
    const runs = fetchRuns(deps);
    if (!runs.length) {
      deps.log(`Refused: no runs found for ${WORKFLOW_FILE}.`);
      return EXIT.BLOCKED;
    }
    const { run, sha, attempts } = findQualifyingRun(deps, runs, head);
    if (!run) {
      deps.log('Refused: no qualifying staging-cloud-smoke run proves the current commit.');
      for (const attempt of attempts.slice(0, 10)) {
        deps.log(`  - run ${attempt.runId} (${attempt.sha}): ${attempt.reason}`);
      }
      return EXIT.BLOCKED;
    }
    deps.emit(`Qualifying run: id=${run.id} head_sha=${sha} conclusion=${run.conclusion}${run.html_url ? ` url=${run.html_url}` : ''}`);
    deps.log(`Staging smoke evidence verified: run_id=${run.id} head_sha=${sha}`);
    return EXIT.OK;
  } catch (error) {
    deps.log(`Refused: ${String(error && error.message || error)}`);
    return EXIT.INTERNAL;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  main, createDeps, currentHead, isAncestor, isCodeUnchangedSince, fetchRuns, findQualifyingRun,
  OWNER, REPO, WORKFLOW_FILE, EXIT
};
