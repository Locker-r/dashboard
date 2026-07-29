const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadClassicModule(relativePath, requireImplementation) {
  const filename = path.join(__dirname, relativePath);
  const sandbox = { module: { exports: {} }, require: requireImplementation };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports;
}

const domain = loadClassicModule('../src/domain.js');
const analytics = loadClassicModule('../src/analytics.js', request => request === './domain.js' ? domain : require(request));
const now = new Date(2026, 6, 29, 12, 0, 0).getTime();
const at = (daysAgo, hour = 10) => {
  const date = new Date(2026, 6, 29, hour, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
};

test('allows analytics only for an administrator', () => {
  assert.equal(analytics.canAccessAnalytics({ role: 'admin' }), true);
  assert.equal(analytics.canAccessAnalytics({ role: 'agent' }), false);
  assert.equal(analytics.canAccessAnalytics({ role: 'unknown' }), false);
  assert.equal(analytics.canAccessAnalytics(null), false);
});

test('uses exact local period boundaries', () => {
  assert.equal(analytics.isEventInPeriod(at(0), 'today', now), true);
  assert.equal(analytics.isEventInPeriod(at(1), 'today', now), false);
  assert.equal(analytics.isEventInPeriod(at(6), '7d', now), true);
  assert.equal(analytics.isEventInPeriod(at(7), '7d', now), false);
  assert.equal(analytics.isEventInPeriod(at(29), '30d', now), true);
  assert.equal(analytics.isEventInPeriod(at(30), '30d', now), false);
});

test('ignores future and invalid events while all time has no lower bound', () => {
  assert.equal(analytics.isEventInPeriod(now + 1, 'all', now), false);
  assert.equal(analytics.isEventInPeriod('invalid', 'all', now), false);
  assert.equal(analytics.isEventInPeriod(null, 'all', now), false);
  assert.equal(analytics.isEventInPeriod(new Date(2000, 0, 1).getTime(), 'all', now), true);
});

test('calculates current snapshot metrics and follow-ups safely', () => {
  const users = [{ id: 'a1', role: 'agent' }];
  const players = [
    { agentId: 'a1', status: 'assigned', followUpAt: new Date(2026, 6, 29, 9).toISOString() },
    { agentId: 'a1', status: 'in_work', followUpAt: new Date(2026, 6, 30, 9).toISOString() },
    { agentId: 'a1', status: 'success' },
    { agentId: 'a1', status: 'failed' },
    { agentId: 'a1', status: 'no_answer', followUpAt: 'invalid' },
    { agentId: null, status: 'new' },
    { agentId: 'deleted', status: 'new' }
  ];
  const result = analytics.snapshotMetrics(players, users, now);
  assert.equal(result.total, 7);
  assert.equal(result.assigned, 5);
  assert.equal(result.unassigned, 2);
  assert.equal(result.inWork, 2);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.noAnswer, 1);
  assert.equal(result.today, 1);
  assert.equal(result.overdue, 1);
  assert.equal(result.currentConversion, 50);
});

test('groups players by compatible string and number agent IDs', () => {
  const users = [{ id: 7, name: 'Seven', role: 'agent' }, { id: 'empty', name: 'Empty', role: 'agent' }];
  const players = [{ id: 'p1', agentId: '7', status: 'assigned' }, { id: 'p2', agentId: 'other', status: 'assigned' }];
  const result = analytics.buildAnalytics(players, users, { period: 'all', now });
  assert.equal(result.agents.length, 2);
  assert.equal(result.agents.find(row => String(row.id) === '7').total, 1);
  assert.equal(result.agents.find(row => row.id === 'empty').total, 0);
  assert.equal(analytics.buildAnalytics(players, users, { agentId: 7, period: 'all', now }).snapshot.total, 1);
  assert.equal(analytics.buildAnalytics(players, users, { agentId: 'missing', period: 'all', now }).selectedAgentMissing, true);
});

test('counts terminal events and conversion without treating legacy success as an event', () => {
  const players = [
    { status: 'success' },
    { statusHistory: [
      { toStatus: 'success', changedAt: at(1), userId: 'a1' },
      { toStatus: 'failed', changedAt: at(1), userId: 'a1' },
      { toStatus: 'success', changedAt: at(10), userId: 'a1' }
    ] }
  ];
  const events = analytics.statusEvents(players, '7d', now);
  const metrics = analytics.eventMetrics(events, []);
  assert.equal(metrics.success, 1);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.conversion, 50);
  assert.equal(analytics.eventMetrics([], []).conversion, 0);
});

test('attributes status activity to the event actor after reassignment', () => {
  const players = [{ agentId: 'new-agent', statusHistory: [
    { toStatus: 'in_work', changedAt: at(0), userId: 'old-agent' },
    { toStatus: 'success', changedAt: at(0), userId: 'new-agent' }
  ] }];
  assert.equal(analytics.statusEvents(players, 'today', now, 'old-agent').length, 1);
  assert.equal(analytics.statusEvents(players, 'today', now, 'new-agent').length, 1);
});

test('counts comments by author and period and ignores malformed comments', () => {
  const players = [{ comments: [
    { authorId: 'a1', createdAt: at(0), text: 'today' },
    { authorId: 'a1', createdAt: at(8), text: 'old' },
    { authorId: 'a2', createdAt: at(0), text: 'other' },
    { authorId: '', createdAt: at(0), text: 'missing author' },
    { authorId: 'a1', createdAt: 'invalid', text: 'invalid date' }
  ] }];
  assert.equal(analytics.commentEvents(players, '7d', now, 'a1').length, 1);
  assert.equal(analytics.commentEvents(players, '7d', now, 'a2').length, 1);
});

test('returns finite zero metrics for empty data', () => {
  const result = analytics.buildAnalytics([], [], { period: '30d', now });
  assert.equal(result.snapshot.total, 0);
  assert.equal(result.snapshot.currentConversion, 0);
  assert.equal(result.events.conversion, 0);
  assert.equal(Number.isFinite(result.events.conversion), true);
});
