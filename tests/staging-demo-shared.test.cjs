'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../scripts/staging-demo-shared.cjs');

test('exact staging project pin', () => {
  assert.equal(shared.STAGING_PROJECT_REF, 'cjdxtakgmnzwixrajjry');
});

/* ==================== identity classification ==================== */

test('smoke-test username matching is prefix-exact, not fuzzy', () => {
  assert.equal(shared.isDisposableSmokeUsername('smoke_test_abc123def456_a'), true);
  assert.equal(shared.isDisposableSmokeUsername('SMOKE_TEST_ABC123DEF456_A'), true);
  assert.equal(shared.isDisposableSmokeUsername('real_agent_maria'), false);
  assert.equal(shared.isDisposableSmokeUsername('demo_cashier_a'), false);
  assert.equal(shared.isDisposableSmokeUsername(''), false);
  assert.equal(shared.isDisposableSmokeUsername(undefined), false);
});

test('demo cashier username matching is prefix-exact', () => {
  assert.equal(shared.isDemoCashierUsername('demo_cashier_a'), true);
  assert.equal(shared.isDemoCashierUsername('demo_manager_x'), false);
  assert.equal(shared.isDemoCashierUsername('smoke_test_abc_a'), false);
});

test('demo lead id matching requires the exact two-digit shape', () => {
  assert.equal(shared.isDemoLeadId('demo_lead_01'), true);
  assert.equal(shared.isDemoLeadId('demo_lead_08'), true);
  assert.equal(shared.isDemoLeadId('demo_lead_9'), false);
  assert.equal(shared.isDemoLeadId('demo_lead_001'), false);
  assert.equal(shared.isDemoLeadId('demo_leads_01'), false);
  assert.equal(shared.isDemoLeadId('real_player_01'), false);
});

test('extractSmokeRunId only matches the exact uppercase SMOKE_TEST_ id prefix', () => {
  assert.equal(shared.extractSmokeRunId('SMOKE_TEST_abc123def456_assigned'), 'abc123def456');
  assert.equal(shared.extractSmokeRunId('smoke_test_abc123def456_assigned'), null);
  assert.equal(shared.extractSmokeRunId('demo_lead_01'), null);
  assert.equal(shared.extractSmokeRunId('SOME_OTHER_PLAYER'), null);
});

/* ==================== cleanup planning: unknown/ambiguous data is never touched ==================== */

test('unknown users and leads are never touched by cleanup planning', () => {
  const members = [
    { id: 'm1', username: 'maria_gonzalez', is_active: true, assigned_players: 3 },
    { id: 'm2', username: 'demo_cashier_a', is_active: true, assigned_players: 4 }
  ];
  const players = [
    { id: 'real_lead_001', messenger: '@maria' },
    { id: 'demo_lead_01', messenger: '@camila_torres' }
  ];
  const plan = shared.planCleanup(members, players);
  assert.deepEqual(plan.membersToDeactivate, []);
  assert.deepEqual(plan.membersSkipped, []);
  assert.deepEqual(plan.playerRunIdsToClean, []);
  assert.deepEqual(plan.playersSkipped, []);
});

test('a disposable smoke cashier with zero players is targeted for deactivation', () => {
  const members = [{ id: 'm1', username: 'smoke_test_abc123def456_a', is_active: true, assigned_players: 0 }];
  const plan = shared.planCleanup(members, []);
  assert.deepEqual(plan.membersToDeactivate, [{ id: 'm1', username: 'smoke_test_abc123def456_a' }]);
});

test('an already-inactive smoke cashier is left alone (nothing to do)', () => {
  const members = [{ id: 'm1', username: 'smoke_test_abc123def456_a', is_active: false, assigned_players: 0 }];
  const plan = shared.planCleanup(members, []);
  assert.deepEqual(plan.membersToDeactivate, []);
  assert.deepEqual(plan.membersSkipped, []);
});

test('a smoke-prefixed cashier that still owns players cannot be proven disposable and is skipped, not forced', () => {
  const members = [{ id: 'm1', username: 'smoke_test_abc123def456_a', is_active: true, assigned_players: 2 }];
  const plan = shared.planCleanup(members, []);
  assert.deepEqual(plan.membersToDeactivate, []);
  assert.equal(plan.membersSkipped.length, 1);
  assert.equal(plan.membersSkipped[0].reason, 'STILL_OWNS_PLAYERS');
});

test('regression: the currently signed-in actor is never a deactivation candidate, even when its own username is smoke_test_-shaped', () => {
  // runtime-smoke.cjs's own readConfig() requires SMOKE_TEST_ADMIN_EMAIL
  // (the same value as STAGING_SMOKE_ADMIN_EMAIL, which staging-demo-prep.yml
  // reuses) to start with "smoke_test" — so the real staging admin account
  // this tooling authenticates as is itself smoke_test_-shaped and would
  // otherwise match isDisposableSmokeUsername. A real cleanup run
  // deactivated its own calling admin this way, and a later run's
  // list-members call then failed with 403 ADMIN_REQUIRED (GitHub Actions
  // run 31308149570, following the account deactivated in run 31307722394).
  const actorId = 'admin-actor-id';
  const members = [
    { id: actorId, username: 'smoke_test_admin', is_active: true, assigned_players: 0 },
    { id: 'm2', username: 'smoke_test_abc123def456_a', is_active: true, assigned_players: 0 }
  ];
  const plan = shared.planCleanup(members, [], actorId);
  assert.deepEqual(plan.membersToDeactivate, [{ id: 'm2', username: 'smoke_test_abc123def456_a' }]);
  assert.ok(!plan.membersToDeactivate.some(m => m.id === actorId));
  assert.ok(!plan.membersSkipped.some(m => m.id === actorId), 'the actor must not even appear as a reported skip — it is never a candidate at all');
});

test('without an actorId, self-exclusion is simply a no-op (backward compatible), not a crash', () => {
  const members = [{ id: 'm1', username: 'smoke_test_abc123def456_a', is_active: true, assigned_players: 0 }];
  const plan = shared.planCleanup(members, []);
  assert.deepEqual(plan.membersToDeactivate, [{ id: 'm1', username: 'smoke_test_abc123def456_a' }]);
});

test('leftover smoke players are grouped by run id extracted from their own id — messenger is never read', () => {
  // `messenger` is not selectable by `authenticated` at all (the raw-contact
  // grant revoke applies to every session, admin included —
  // supabase/migrations/20260801000200_revoke_raw_contacts.sql, found via
  // the first real staging-demo-prep run failing with "permission denied
  // for table players"). Grouping input therefore only ever carries `id`.
  const players = [
    { id: 'SMOKE_TEST_abc123def456_assigned' },
    { id: 'SMOKE_TEST_abc123def456_other' },
    { id: 'SMOKE_TEST_zzz999zzz999_solo' }
  ];
  const plan = shared.planCleanup([], players);
  assert.deepEqual([...plan.playerRunIdsToClean].sort(), ['abc123def456', 'zzz999zzz999']);
  // There is no client-side "skip, uncertain provenance" category for
  // players anymore: cleanup_smoke_test_run_atomic (security definer)
  // re-derives the messenger marker itself and is the sole authority on
  // whether a candidate id is genuine smoke debris — see
  // groupLeftoverSmokePlayers's own comment.
  assert.deepEqual(plan.playersSkipped, []);
});

test('groupLeftoverSmokePlayers never requires or reads a messenger field', () => {
  const groups = shared.groupLeftoverSmokePlayers([{ id: 'SMOKE_TEST_abc123def456_x' }]);
  assert.deepEqual([...groups.keys()], ['abc123def456']);
});

test('a player with no smoke-shaped id at all is never reported or touched', () => {
  const players = [{ id: 'real_lead_999', messenger: '@somebody' }, { id: 'demo_lead_04', messenger: '@sebastian_chavez' }];
  const plan = shared.planCleanup([], players);
  assert.deepEqual(plan.playerRunIdsToClean, []);
  assert.deepEqual(plan.playersSkipped, []);
});

/* ==================== status hop planning ==================== */

test('planStatusHops finds the shortest legal path, or null if none exists', () => {
  assert.deepEqual(shared.planStatusHops('new', 'new'), []);
  assert.deepEqual(shared.planStatusHops('new', 'assigned'), ['assigned']);
  assert.deepEqual(shared.planStatusHops('new', 'in_work'), ['assigned', 'in_work']);
  assert.deepEqual(shared.planStatusHops('new', 'success'), ['assigned', 'in_work', 'success']);
  assert.deepEqual(shared.planStatusHops('success', 'no_answer'), ['in_work', 'no_answer']);
  assert.deepEqual(shared.planStatusHops('success', 'failed'), ['in_work', 'failed']);
  assert.deepEqual(shared.planStatusHops('no_answer', 'success'), ['assigned', 'in_work', 'success']);
});

/* ==================== lead reconciliation planning ==================== */

const CASHIER_IDS = new Map([['a', 'AGENT_A'], ['b', 'AGENT_B']]);

test('a fresh unassigned lead only needs a create action', () => {
  const target = shared.DEMO_LEADS.find(lead => lead.targetCashierSlot === null);
  const plan = shared.planLeadReconciliation(null, target, CASHIER_IDS, false);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.actions.map(a => a.type), ['create']);
});

test('a fresh lead targeting success+proof creates, assigns, works, proves, and closes — in that order', () => {
  const target = shared.DEMO_LEADS.find(lead => lead.withProof);
  const plan = shared.planLeadReconciliation(null, target, CASHIER_IDS, false);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.actions.map(a => a.type), ['create', 'assign', 'status', 'proof', 'status']);
  assert.equal(plan.actions[2].next, 'in_work');
  assert.equal(plan.actions[4].next, 'success');
});

test('a lead already at its target state needs no actions at all — idempotent re-run', () => {
  const target = shared.DEMO_LEADS.find(lead => lead.withProof);
  const current = { status: target.targetStatus, agent_id: CASHIER_IDS.get(target.targetCashierSlot) };
  const plan = shared.planLeadReconciliation(current, target, CASHIER_IDS, true);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.actions, []);
});

test('a lead already correctly assigned and in_work does not repeat the proof step if one is already active', () => {
  const target = shared.DEMO_LEADS.find(lead => lead.withProof);
  const current = { status: 'in_work', agent_id: CASHIER_IDS.get(target.targetCashierSlot) };
  const plan = shared.planLeadReconciliation(current, target, CASHIER_IDS, true);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.actions.map(a => a.type), ['status']);
  assert.equal(plan.actions[0].next, 'success');
});

test('a lead assigned to the wrong agent, in a status that cannot be re-assigned, is reported unreconcilable rather than force-reassigned', () => {
  const target = shared.DEMO_LEADS.find(lead => lead.targetCashierSlot === 'a' && lead.targetStatus === 'in_work');
  const current = { status: 'in_work', agent_id: 'SOME_OTHER_AGENT' };
  const plan = shared.planLeadReconciliation(current, target, CASHIER_IDS, false);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'ASSIGNMENT_MISMATCH_NOT_RECONCILABLE');
});

test('an assigned lead with no target agent (would need un-assignment) is reported unreconcilable — this tooling never un-assigns', () => {
  const target = shared.DEMO_LEADS.find(lead => lead.targetCashierSlot === null);
  const current = { status: 'assigned', agent_id: 'SOME_AGENT' };
  const plan = shared.planLeadReconciliation(current, target, CASHIER_IDS, false);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'CANNOT_UNASSIGN');
});

test('a success/failed lead being reopened toward a new target status marks the first hop as a reopen', () => {
  const target = shared.DEMO_LEADS.find(lead => lead.targetStatus === 'no_answer');
  const current = { status: 'success', agent_id: CASHIER_IDS.get(target.targetCashierSlot) };
  const plan = shared.planLeadReconciliation(current, target, CASHIER_IDS, false);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.actions.map(a => a.type), ['status', 'status']);
  assert.equal(plan.actions[0].next, 'in_work');
  assert.equal(plan.actions[0].reopen, true);
  assert.equal(plan.actions[1].next, 'no_answer');
  assert.equal(plan.actions[1].reopen, false);
});

/* ==================== dataset shape ==================== */

test('the demo dataset is exactly 8 leads and 2 cashiers, matching the requested distribution', () => {
  assert.equal(shared.DEMO_LEADS.length, 8);
  assert.equal(shared.DEMO_CASHIERS.length, 2);
  const statuses = shared.DEMO_LEADS.map(lead => lead.targetStatus);
  assert.deepEqual(new Set(statuses), new Set(['new', 'assigned', 'in_work', 'success', 'no_answer', 'failed']));
  assert.equal(statuses.filter(s => s === 'assigned').length, 2);
  assert.equal(statuses.filter(s => s === 'in_work').length, 2);
  assert.equal(shared.DEMO_LEADS.filter(lead => lead.withProof).length, 1);
});

test('every demo lead id is obviously prefixed and unique', () => {
  const ids = shared.DEMO_LEADS.map(lead => lead.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^demo_lead_\d{2}$/);
});

test('no demo contact field contains a real-looking non-.invalid domain or unmasked real data marker', () => {
  for (const lead of shared.DEMO_LEADS) {
    assert.match(lead.email, /@example\.invalid$/);
    assert.match(lead.phone, /^\+593\d{9}$/);
  }
  for (const cashier of shared.DEMO_CASHIERS) {
    assert.match(cashier.email, /@example\.invalid$/);
    assert.match(cashier.username, /^demo_cashier_/);
  }
});
