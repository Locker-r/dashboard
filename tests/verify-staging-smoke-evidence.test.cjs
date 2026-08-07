'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const verifier = require('../scripts/verify-staging-smoke-evidence.cjs');

const HEAD = 'a'.repeat(40);
const ANCESTOR = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function successRun(overrides = {}) {
  return { id: 1001, status: 'completed', conclusion: 'success', head_sha: HEAD, html_url: 'https://example.invalid/run', ...overrides };
}

// A fake git+gh dispatcher. `git` calls are matched by their subcommand;
// `gh api` calls just return the given runs payload.
function fakeRun({ runsResponse, diffFiles = [], ancestorOf = new Set(), headOverride = HEAD } = {}) {
  return (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${headOverride}\n` };
    if (command === 'git' && args[0] === 'merge-base') {
      const candidate = args[2];
      return { status: ancestorOf.has(candidate) ? 0 : 1, stdout: '' };
    }
    if (command === 'git' && args[0] === 'diff') return { status: 0, stdout: diffFiles.join('\n') };
    if (command === 'gh' && args[0] === 'api') {
      if (runsResponse instanceof Error) return { status: 1, stderr: runsResponse.message };
      return { status: 0, stdout: JSON.stringify({ workflow_runs: runsResponse }) };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(' ')}`);
  };
}

test('success: a run whose head_sha exactly matches the current commit passes', () => {
  const status = verifier.main([], { run: fakeRun({ runsResponse: [successRun()] }), log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.OK);
});

test('failed run: a run for the same commit that did not succeed is refused', () => {
  const logs = [];
  const status = verifier.main([], {
    run: fakeRun({ runsResponse: [successRun({ conclusion: 'failure' })] }),
    log: line => logs.push(line), emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
  assert.ok(logs.some(line => line.includes('status=completed conclusion=failure')));
});

test('wrong workflow: the API call targets exactly staging-cloud-smoke.yml, nothing else', () => {
  const calls = [];
  verifier.main([], {
    run: (command, args) => {
      calls.push([command, args]);
      return fakeRun({ runsResponse: [successRun()] })(command, args);
    },
    log() {}, emit() {}
  });
  const ghCall = calls.find(([command]) => command === 'gh');
  assert.ok(ghCall);
  assert.match(ghCall[1].join(' '), /repos\/Locker-r\/dashboard\/actions\/workflows\/staging-cloud-smoke\.yml\/runs/);
});

test('the gh api call is an unambiguous GET: no -f/-F/-X/--method flag anywhere', () => {
  // `gh api` treats -f/-F fields as a request body, which forces a mutating
  // method even against a listing endpoint (the exact bug this regresses:
  // `-f per_page=20 -f branch=main` 404'd where the equivalent query string
  // succeeds). Query parameters belong in the URL, never in -f/-F fields, and
  // no explicit method flag should be needed for a call that must always be
  // a GET.
  const calls = [];
  verifier.main([], {
    run: (command, args) => {
      calls.push([command, args]);
      return fakeRun({ runsResponse: [successRun()] })(command, args);
    },
    log() {}, emit() {}
  });
  const ghCall = calls.find(([command]) => command === 'gh');
  assert.ok(ghCall);
  for (const flag of ['-f', '-F', '--field', '--raw-field', '-X', '--method']) {
    assert.ok(!ghCall[1].includes(flag), `gh api call must not use ${flag}`);
  }
  assert.match(ghCall[1].join(' '), /runs\?per_page=\d+&branch=main/, 'query parameters must be in the URL, not in -f fields');
});

test('stale SHA: an ancestor run whose diff touches product code is refused', () => {
  const status = verifier.main([], {
    run: fakeRun({
      runsResponse: [successRun({ head_sha: ANCESTOR })],
      ancestorOf: new Set([ANCESTOR]),
      diffFiles: ['src/lead-proof.js']
    }),
    log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('security-relevant drift: an ancestor run whose diff touches the Edge Function is refused', () => {
  const status = verifier.main([], {
    run: fakeRun({
      runsResponse: [successRun({ head_sha: ANCESTOR })],
      ancestorOf: new Set([ANCESTOR]),
      diffFiles: ['supabase/functions/team-management/index.ts']
    }),
    log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('allowed drift: an ancestor run whose diff touches only docs/release paths passes', () => {
  const status = verifier.main([], {
    run: fakeRun({
      runsResponse: [successRun({ head_sha: ANCESTOR })],
      ancestorOf: new Set([ANCESTOR]),
      diffFiles: ['docs/release-gates.md', 'release/verification/B1.evidence.json']
    }),
    log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.OK);
});

test('missing run: an empty run list is refused', () => {
  const status = verifier.main([], { run: fakeRun({ runsResponse: [] }), log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('missing evidence: a gh api failure fails closed, not open', () => {
  const status = verifier.main([], { run: fakeRun({ runsResponse: new Error('rate limited') }), log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.INTERNAL);
});

test('a run whose head_sha is not an ancestor of the current commit is refused, even with an empty diff', () => {
  const status = verifier.main([], {
    run: fakeRun({ runsResponse: [successRun({ head_sha: OTHER })], ancestorOf: new Set() }),
    log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('isCodeUnchangedSince reuses the real isEvidenceDriftAllowed predicate, not a fork', () => {
  const core = require('../scripts/release/release-core.cjs');
  const deps = verifier.createDeps({ run: fakeRun({ ancestorOf: new Set([ANCESTOR]), diffFiles: ['docs/x.md'] }) });
  assert.equal(verifier.isCodeUnchangedSince(deps, ANCESTOR, HEAD), core.isEvidenceDriftAllowed('docs/x.md'));
});

test('the exact same commit never needs a git call to be judged unchanged', () => {
  let gitCalled = false;
  const deps = verifier.createDeps({ run: (command, args) => { if (command === 'git') gitCalled = true; return { status: 0, stdout: '' }; } });
  assert.equal(verifier.isCodeUnchangedSince(deps, HEAD, HEAD), true);
  assert.equal(gitCalled, false);
});
