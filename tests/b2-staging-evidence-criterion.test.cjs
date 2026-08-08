'use strict';

// B2's cashier-runtime-suite criterion moved from a local-only, service-role
// runtime script to the same read-only hosted-staging evidence verifier B1
// already uses (scripts/verify-staging-smoke-evidence.cjs). These tests pin
// the backlog definition itself, independent of tests/release-harness.test.cjs
// and tests/verify-staging-smoke-evidence.test.cjs, which cover the harness
// engine and the verifier's own behavior respectively.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const backlog = JSON.parse(fs.readFileSync(path.join(ROOT, 'release', 'backlog.json'), 'utf8'));

function findTask(id) {
  const task = (backlog.tasks || []).find(entry => entry.id === id);
  assert.ok(task, `backlog is missing task ${id}`);
  return task;
}

function findCriterion(task, id) {
  const criterion = (task.acceptanceCriteria || []).find(entry => entry.id === id);
  assert.ok(criterion, `${task.id} is missing acceptance criterion ${id}`);
  return criterion;
}

test('B2 cashier-runtime-suite now runs the shared read-only staging evidence verifier, not the local-only service-role script', () => {
  const b2 = findTask('B2');
  const criterion = findCriterion(b2, 'cashier-runtime-suite');
  assert.equal(criterion.command, 'node scripts/verify-staging-smoke-evidence.cjs');
  assert.doesNotMatch(criterion.command, /agent-management-smoke\.cjs/);
  assert.doesNotMatch(criterion.statement, /live local stack/);
  assert.doesNotMatch(criterion.statement, /SMOKE_TEST_LOCAL_SERVICE_KEY/);
});

test('B2 reuses the exact same verifier script as B1 — one shared implementation, not a fork', () => {
  const b1 = findCriterion(findTask('B1'), 'proof-runtime-suite');
  const b2 = findCriterion(findTask('B2'), 'cashier-runtime-suite');
  assert.equal(b1.command, b2.command);
  assert.equal(b1.command, 'node scripts/verify-staging-smoke-evidence.cjs');
});

test('B2 cashier-runtime-suite\'s statement names every guarantee ported from the local suite', () => {
  const criterion = findCriterion(findTask('B2'), 'cashier-runtime-suite');
  const mustMention = [
    /admin gate/i,
    /unknown action/i,
    /validation/i,
    /Auth write/i,
    /duplicate-username/i,
    /orphan or squatted Auth user/i,
    /create-member/i,
    /own profile row/i,
    /duplicate email/i,
    /previous country/i,
    /assigned-lead count/i,
    /already-issued token/i,
    /reactivation/i,
    /self-promote/i,
    /bypassing the Edge Function/i,
    /requestId replay/i,
    /reuse with different values is refused/i
  ];
  for (const pattern of mustMention) {
    assert.match(criterion.statement, pattern, `statement must mention: ${pattern}`);
  }
});

test('B2 cashier-runtime-suite explicitly defers audit-history immutability to the structural criterion, not the API boundary', () => {
  const criterion = findCriterion(findTask('B2'), 'cashier-runtime-suite');
  assert.match(criterion.statement, /admin_audit_events/);
  assert.match(criterion.statement, /proven structurally by cashier-structure/);
});

test('B2 gained a dedicated no-browser-secret criterion, mirroring B1\'s', () => {
  const b1Secret = findCriterion(findTask('B1'), 'proof-no-browser-secret');
  const b2Secret = findCriterion(findTask('B2'), 'cashier-no-browser-secret');
  assert.equal(b1Secret.command, 'npm run check:secrets');
  assert.equal(b2Secret.command, 'npm run check:secrets');
  assert.equal(b1Secret.statement, b2Secret.statement);
});

test('every acceptance criterion in B2 cites a docs/release-gates.md heading that actually exists', () => {
  const gates = fs.readFileSync(path.join(ROOT, 'docs', 'release-gates.md'), 'utf8');
  const criterion = findCriterion(findTask('B2'), 'cashier-runtime-suite');
  const citation = criterion.statement.match(/docs\/release-gates\.md, '([^']+)'/);
  assert.ok(citation, 'cashier-runtime-suite must cite its docs/release-gates.md section');
  assert.match(gates, new RegExp(`^## ${citation[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('the B2 doc section names the same guarantees the backlog statement does, and defers audit immutability the same way', () => {
  const gates = fs.readFileSync(path.join(ROOT, 'docs', 'release-gates.md'), 'utf8');
  const start = gates.indexOf('## B2 cashier-runtime-suite: staging evidence verification');
  assert.ok(start >= 0, 'missing B2 staging evidence verification section');
  const end = gates.indexOf('\n## ', start + 1);
  const section = gates.slice(start, end === -1 ? undefined : end);
  assert.match(section, /verify-staging-smoke-evidence\.cjs/);
  assert.match(section, /one shared,\s+task-agnostic verifier, not a fork/);
  assert.match(section, /admin_audit_events/);
  assert.match(section, /cashier-structure/);
});
