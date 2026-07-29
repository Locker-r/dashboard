const test = require('node:test');
const assert = require('node:assert/strict');
const cleanup = require('../src/test-data-cleanup.js');

function testPlayers(count = 30, agentId = 'test-agent') {
  return Array.from({ length: count }, (_, index) => ({
    id: `test-player-${index + 1}`,
    email: `test${String(index + 1).padStart(2, '0')}@example.com`,
    agentId,
    comments: [{ id: `comment-${index + 1}`, authorId: agentId }],
    statusHistory: [{ id: `history-${index + 1}`, userId: agentId }]
  }));
}

const users = [{ id: 'admin', role: 'admin' }, { id: 'test-agent', role: 'agent' }];

test('removes exactly 30 matching players and their exclusively referenced agent', () => {
  const result = cleanup.clean(testPlayers(), users, cleanup.CONFIRMATION_PHRASE);
  assert.equal(result.ok, true);
  assert.equal(result.before.counts.testPlayers, 30);
  assert.equal(result.before.counts.comments, 30);
  assert.equal(result.before.counts.historyEvents, 30);
  assert.equal(result.players.length, 0);
  assert.deepEqual(result.users, [{ id: 'admin', role: 'admin' }]);
});

test('preserves similar emails that do not strictly match the pattern', () => {
  const similar = [
    { id: 'similar-1', email: 'test31@example.com' },
    { id: 'similar-2', email: 'test1@example.com' },
    { id: 'similar-3', email: 'test01@example.org' },
    { id: 'similar-4', email: 'prefix-test01@example.com' }
  ];
  const result = cleanup.clean([...testPlayers(), ...similar], users, cleanup.CONFIRMATION_PHRASE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.players.map(player => player.id), similar.map(player => player.id));
});

test('always preserves an administrator', () => {
  const result = cleanup.clean(testPlayers('30', 'admin'), users, cleanup.CONFIRMATION_PHRASE);
  assert.equal(result.ok, true);
  assert.equal(result.users.some(user => user.role === 'admin'), true);
});

test('does not remove a user referenced by a non-test player and blocks cleanup', () => {
  const players = [...testPlayers(), { id: 'real-player', email: 'real@example.invalid', agentId: 'test-agent' }];
  const plan = cleanup.preview(players, users);
  assert.equal(plan.counts.otherPlayersUsingReferencedUsers, 1);
  assert.equal(plan.eligible, false);
  const result = cleanup.clean(players, users, cleanup.CONFIRMATION_PHRASE);
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan.counts, plan.counts);
});

test('blocks cleanup with 29 or 31 matching players', () => {
  assert.equal(cleanup.clean(testPlayers(29), users, cleanup.CONFIRMATION_PHRASE).ok, false);
  const thirtyOne = [...testPlayers(), { id: 'duplicate-email-row', email: 'test01@example.com', agentId: 'test-agent' }];
  assert.equal(cleanup.clean(thirtyOne, users, cleanup.CONFIRMATION_PHRASE).ok, false);
});

test('a repeated run is safe and removes nothing else', () => {
  const real = { id: 'real-player', email: 'real@example.invalid', agentId: null };
  const first = cleanup.clean([...testPlayers(), real], users, cleanup.CONFIRMATION_PHRASE);
  assert.equal(first.ok, true);
  const second = cleanup.clean(first.players, first.users, cleanup.CONFIRMATION_PHRASE);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'preconditions_failed');
  assert.deepEqual(first.players, [real]);
  assert.deepEqual(first.users, [{ id: 'admin', role: 'admin' }]);
});
