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

test('normalizes roles with a safe agent fallback', () => {
  assert.equal(domain.normalizeRole(' ADMIN '), 'admin');
  assert.equal(domain.normalizeRole('unexpected'), 'agent');
});

test('normalizes duplicate identifiers', () => {
  assert.equal(domain.normalizePhone('+593 98-765-4321'), '593987654321');
  assert.equal(domain.normalizePhone('00593 98 765 4321'), '593987654321');
  assert.equal(domain.normalizeEmail(' Agent@Example.COM '), 'agent@example.com');
  assert.equal(domain.duplicateKeyFor({ phone: '+593 98 765 4321', email: 'ignored@example.com' }), 'phone:593987654321');
  assert.equal(domain.duplicateKeyFor({ phone: '', email: ' Agent@Example.COM ' }), 'email:agent@example.com');
  assert.equal(domain.duplicateKeyFor({}), null);
});

test('enforces approved status transitions by role', () => {
  assert.equal(domain.canRoleTransitionStatus('agent', 'assigned', 'in_work'), true);
  assert.equal(domain.canRoleTransitionStatus('agent', 'in_work', 'success'), true);
  assert.equal(domain.canRoleTransitionStatus('agent', 'no_answer', 'assigned'), true);
  assert.equal(domain.canRoleTransitionStatus('agent', 'success', 'in_work'), false);
  assert.equal(domain.canRoleTransitionStatus('admin', 'success', 'in_work'), true);
  assert.equal(domain.canRoleTransitionStatus('admin', 'new', 'success'), false);
});

test('allows no_answer to return to assigned', () => {
  assert.equal(domain.isStatusTransitionAllowed('no_answer', 'assigned'), true);
});

test('rejects terminal-to-assigned and malformed transitions safely', () => {
  assert.equal(domain.canRoleTransitionStatus('agent', 'success', 'assigned'), false);
  assert.equal(domain.canRoleTransitionStatus('agent', 'failed', 'assigned'), false);
  assert.equal(domain.isStatusTransitionAllowed('assigned', 'assigned'), false);
  assert.equal(domain.isStatusTransitionAllowed('unknown', 'assigned'), false);
  assert.equal(domain.isStatusTransitionAllowed('assigned', 'unknown'), false);
});

test('checks the current user and player ownership', () => {
  const ownPlayer = { id: 'p_1', agentId: 'u_agent', status: 'assigned' };
  const otherPlayer = { id: 'p_2', agentId: 'u_other', status: 'assigned' };
  const agent = { id: 'u_agent', role: 'agent' };

  assert.equal(domain.canUserChangePlayerStatus(agent, ownPlayer), true);
  assert.equal(domain.evaluateStatusTransition(agent, ownPlayer, 'in_work').allowed, true);
  assert.equal(domain.canUserChangePlayerStatus(agent, otherPlayer), false);
  assert.equal(domain.evaluateStatusTransition(agent, otherPlayer, 'in_work').reason, 'not_owner');
  assert.equal(domain.evaluateStatusTransition(null, ownPlayer, 'in_work').reason, 'no_current_user');
});

test('requires confirmation for an administrator to reopen a final status', () => {
  const admin = { id: 'u_admin', role: 'admin' };
  for (const status of ['success', 'failed']) {
    const player = { id: `p_${status}`, agentId: 'u_agent', status };
    const before = { ...player };
    const pendingConfirmation = domain.evaluateStatusTransition(admin, player, 'in_work');
    assert.equal(pendingConfirmation.allowed, false);
    assert.equal(pendingConfirmation.reason, 'confirmation_required');
    assert.deepEqual(player, before);
    const confirmed = domain.evaluateStatusTransition(admin, player, 'in_work', { adminConfirmed: true });
    assert.equal(confirmed.allowed, true);
    assert.equal(confirmed.reason, 'allowed');
  }
});

test('blocks agents from reopening final statuses', () => {
  const agent = { id: 'u_agent', role: 'agent' };
  for (const status of ['success', 'failed']) {
    const player = { id: `p_${status}`, agentId: agent.id, status };
    assert.equal(domain.evaluateStatusTransition(agent, player, 'in_work').reason, 'role_forbidden');
  }
});

test('requires admin and confirmation to reassign final players', () => {
  assert.equal(domain.canReassignPlayer('agent', 'assigned', true), false);
  assert.equal(domain.canReassignPlayer('admin', 'assigned', false), true);
  assert.equal(domain.canReassignPlayer('admin', 'success', false), false);
  assert.equal(domain.canReassignPlayer('admin', 'success', true), true);
});

test('protects the last active administrator', () => {
  assert.equal(domain.canPerformAdministrativeAction('agent'), false);
  assert.equal(domain.canPerformAdministrativeAction('admin'), true);
  assert.equal(domain.canPerformAdministrativeAction('admin', { affectsActiveAdmin: true }), false);
  assert.equal(domain.canPerformAdministrativeAction('admin', { affectsActiveAdmin: true, activeAdminCount: 1 }), false);
  assert.equal(domain.canPerformAdministrativeAction('admin', { affectsActiveAdmin: true, activeAdminCount: 2 }), true);
});

test('creates status history only for an allowed transition', () => {
  const user = { id: 'u_agent', name: 'Test Agent', role: 'agent' };
  const player = { id: 'p_1', agentId: user.id, status: 'assigned' };
  const allowed = domain.prepareStatusTransition(user, player, 'in_work', { historyId: 'h_1', changedAt: 123 });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.historyEntry.id, 'h_1');
  assert.equal(allowed.historyEntry.fromStatus, 'assigned');
  assert.equal(allowed.historyEntry.toStatus, 'in_work');
  assert.equal(allowed.historyEntry.changedAt, 123);
  assert.equal(allowed.historyEntry.userId, user.id);
  assert.equal(allowed.historyEntry.userName, user.name);
  assert.equal(allowed.historyEntry.userRole, user.role);

  const forbidden = domain.prepareStatusTransition(user, { ...player, agentId: 'u_other' }, 'in_work', { historyId: 'h_2' });
  assert.equal(forbidden.allowed, false);
  assert.equal(forbidden.historyEntry, undefined);
});

test('normalizes absent player activity arrays', () => {
  assert.deepEqual(Array.from(domain.normalizeStatusHistory({})), []);
  assert.deepEqual(Array.from(domain.normalizeComments({})), []);
  assert.deepEqual(Array.from(domain.normalizeStatusHistory({ statusHistory: [{ id: 'h_1' }] })), [{ id: 'h_1' }]);
  assert.deepEqual(Array.from(domain.normalizeComments({ comments: [{ id: 'c_1' }] })), [{ id: 'c_1' }]);
});

test('creates trimmed comments and rejects invalid text', () => {
  const user = { id: 'u_agent', name: 'Test Agent', role: 'agent' };
  const created = domain.createComment({ id: 'c_1', text: '  Follow up tomorrow  ', createdAt: 456, user });
  assert.equal(created.ok, true);
  assert.equal(created.comment.text, 'Follow up tomorrow');
  assert.equal(created.comment.authorId, user.id);
  assert.equal(created.comment.authorName, user.name);
  assert.equal(created.comment.authorRole, user.role);
  assert.equal(domain.createComment({ text: '   ', user }).reason, 'empty_comment');
  assert.equal(domain.createComment({ text: 'x'.repeat(domain.COMMENT_MAX_LENGTH + 1), user }).reason, 'comment_too_long');
});

test('checks ownership for comments and follow-up management', () => {
  const agent = { id: 'u_agent', role: 'agent' };
  const admin = { id: 'u_admin', role: 'admin' };
  assert.equal(domain.canUserManagePlayer(agent, { agentId: agent.id }), true);
  assert.equal(domain.canUserManagePlayer(agent, { agentId: 'u_other' }), false);
  assert.equal(domain.canUserManagePlayer(admin, { agentId: 'u_other' }), true);
  assert.equal(domain.canUserManagePlayer(null, { agentId: agent.id }), false);
});

test('classifies follow-up values using the local calendar', () => {
  const now = new Date(2026, 6, 29, 12, 0, 0).getTime();
  const earlierToday = new Date(2026, 6, 29, 9, 0, 0).toISOString();
  const laterToday = new Date(2026, 6, 29, 15, 0, 0).toISOString();
  const tomorrow = new Date(2026, 6, 30, 10, 0, 0).toISOString();

  assert.equal(domain.isFollowUpToday(earlierToday, now), true);
  assert.equal(domain.isFollowUpOverdue(earlierToday, now), true);
  assert.equal(domain.isFollowUpScheduled(laterToday, now), true);
  assert.equal(domain.isFollowUpScheduled(tomorrow, now), true);
  assert.equal(domain.matchesFollowUpFilter(laterToday, 'today', now), true);
  assert.equal(domain.matchesFollowUpFilter(earlierToday, 'overdue', now), true);
  assert.equal(domain.matchesFollowUpFilter(tomorrow, 'scheduled', now), true);
  assert.equal(domain.matchesFollowUpFilter(null, 'none', now), true);
  assert.equal(domain.matchesFollowUpFilter('not-a-date', 'none', now), true);
  assert.equal(domain.normalizeFollowUpAt('not-a-date'), null);
});
