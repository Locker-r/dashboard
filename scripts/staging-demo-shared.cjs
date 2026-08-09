'use strict';

// Shared, deterministic definitions for the staging demo-preparation
// tooling (scripts/staging-demo-cleanup.cjs, scripts/staging-demo-seed.cjs,
// scripts/staging-demo-flow-verify.cjs). Every identity here is synthetic:
// `.invalid` is the RFC 2606 reserved domain that is guaranteed to never
// route anywhere, phone numbers use the Ecuadorian mobile prefix shape but
// are not allocated numbers, and every name is a fake, obviously-placeholder
// LATAM-style name. No real PII of any kind.
//
// All identifiers carry an obvious `demo_` prefix by design (the whole point
// is that anyone inspecting the data — technical or not — can tell it is
// synthetic), and every mutation this tooling performs goes through the same
// product-supported RPCs and Edge Function actions the real UI uses: no
// service-role key, no direct table write bypassing RLS.

const domain = require('../src/domain.js');

const STAGING_PROJECT_REF = 'cjdxtakgmnzwixrajjry';

const SMOKE_TEST_USERNAME_PATTERN = /^smoke_test_/i;
// Mirrors scripts/runtime-smoke.cjs's own PREFIX/RUN_ID_PATTERN exactly —
// required so this tooling and the existing smoke harness always agree on
// what counts as a disposable smoke identity.
const SMOKE_TEST_PLAYER_ID_PATTERN = /^SMOKE_TEST_([a-z0-9]{12,40})_/;
const SMOKE_TEST_RUN_ID_PATTERN = /^[a-z0-9]{12,40}$/;

const DEMO_CASHIER_USERNAME_PATTERN = /^demo_cashier_/i;
const DEMO_LEAD_ID_PATTERN = /^demo_lead_\d{2}$/;

const DEMO_CASHIERS = Object.freeze([
  Object.freeze({ slot: 'a', email: 'demo_cashier_a@example.invalid', username: 'demo_cashier_a', name: 'Demo Cashier A', country: 'EC' }),
  Object.freeze({ slot: 'b', email: 'demo_cashier_b@example.invalid', username: 'demo_cashier_b', name: 'Demo Cashier B', country: 'EC' })
]);

// Fake LATAM (Ecuador-flavored) identities. Deterministic and stable across
// runs, so re-seeding always produces byte-identical contact fields for a
// given lead id.
const DEMO_LEAD_NAMES = Object.freeze([
  'camila.torres', 'mateo.vera', 'valentina.rojas', 'sebastian.chavez',
  'isabella.mendoza', 'santiago.paredes', 'daniela.aguirre', 'joaquin.salazar'
]);

function demoLeadPhone(index) {
  // A synthetic Ecuadorian mobile shape (+593 9xx xxx xxx), not an allocated number.
  return `+593${String(900000000 + index * 111).slice(0, 9)}`;
}

// change_player_status_atomic requires an active proof to close a lead as
// EITHER 'success' or 'failed' — the same check applies to both
// (supabase/migrations/20260805000100_lead_proof.sql: "if p_next_status in
// ('success','failed') then ... PROOF_REQUIRED"). A real seed run hit this
// exactly: demo_lead_08 targets 'failed' but was never given a proof step
// (found 2026-08-09, GitHub Actions run 31310524648). `withProof` is
// therefore derived from the target status, not hand-set per lead, so this
// class of bug cannot recur by omission.
const CLOSING_STATUSES_REQUIRING_PROOF = Object.freeze([domain.STATUSES.SUCCESS, domain.STATUSES.FAILED]);

// The canonical, idempotent target shape of the persistent demo dataset.
// `cashierSlot: null` means intentionally unassigned. `status` is the final
// state this lead should converge to on every run, regardless of where it
// currently sits (see staging-demo-seed.cjs's reconciliation logic).
const DEMO_LEADS = Object.freeze(
  DEMO_LEAD_NAMES.map((handle, index) => {
    const n = index + 1;
    const id = `demo_lead_${String(n).padStart(2, '0')}`;
    const plan = [
      { status: domain.STATUSES.NEW, cashierSlot: null },
      { status: domain.STATUSES.ASSIGNED, cashierSlot: 'a' },
      { status: domain.STATUSES.ASSIGNED, cashierSlot: 'b' },
      { status: domain.STATUSES.IN_WORK, cashierSlot: 'a' },
      { status: domain.STATUSES.IN_WORK, cashierSlot: 'b' },
      { status: domain.STATUSES.SUCCESS, cashierSlot: 'a' },
      { status: domain.STATUSES.NO_ANSWER, cashierSlot: 'b' },
      { status: domain.STATUSES.FAILED, cashierSlot: 'a' }
    ][index];
    return Object.freeze({
      id,
      email: `${handle}.demo@example.invalid`,
      messenger: `@${handle.replace('.', '_')}`,
      phone: demoLeadPhone(n),
      targetStatus: plan.status,
      targetCashierSlot: plan.cashierSlot,
      withProof: CLOSING_STATUSES_REQUIRING_PROOF.includes(plan.status)
    });
  })
);

function isDisposableSmokeUsername(username) {
  return SMOKE_TEST_USERNAME_PATTERN.test(String(username || ''));
}

function isDemoCashierUsername(username) {
  return DEMO_CASHIER_USERNAME_PATTERN.test(String(username || ''));
}

function isDemoLeadId(id) {
  return DEMO_LEAD_ID_PATTERN.test(String(id || ''));
}

function extractSmokeRunId(playerId) {
  const match = SMOKE_TEST_PLAYER_ID_PATTERN.exec(String(playerId || ''));
  return match ? match[1] : null;
}

// Groups leftover smoke-test players by the run id embedded in their own
// id. The messenger marker (`SMOKE_TEST:<runId>:...`) would be the other
// half of cleanup_smoke_test_run_atomic's own two-signal match, but
// `messenger` is not a column `authenticated` may select — the raw-contact
// grant revoke in supabase/migrations/20260801000200_revoke_raw_contacts.sql
// applies to every session, admin included (found 2026-08-09: the first
// real staging-demo-prep run failed here with "permission denied for table
// players"). The id-prefix match here is therefore a candidate list, not a
// final decision: cleanup_smoke_test_run_atomic is `security definer` and
// re-derives the messenger marker itself from the row directly, so calling
// it for an id that only coincidentally starts with the right text is safe
// — it deletes zero rows and returns players_deleted: 0, never an error.
function groupLeftoverSmokePlayers(players) {
  const groups = new Map();
  for (const player of players || []) {
    const runId = extractSmokeRunId(player && player.id);
    if (!runId || !SMOKE_TEST_RUN_ID_PATTERN.test(runId)) continue;
    if (!groups.has(runId)) groups.set(runId, []);
    groups.get(runId).push(player.id);
  }
  return groups;
}

// The exact fixed hop graph domain.js's STATUSES/TRANSITIONS already encode,
// walked breadth-first so reconciliation always finds the shortest legal
// path (or reports impossible, never guesses/forces a skip).
function planStatusHops(currentStatus, targetStatus) {
  if (currentStatus === targetStatus) return [];
  const queue = [[currentStatus]];
  const seen = new Set([currentStatus]);
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    const next = domain.STATUS_TRANSITIONS && domain.STATUS_TRANSITIONS[last] ? domain.STATUS_TRANSITIONS[last] : [];
    for (const candidate of next) {
      if (candidate === targetStatus) return [...path.slice(1), candidate];
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      queue.push([...path, candidate]);
    }
  }
  return null; // No legal path exists — reconciliation must fail closed, not force it.
}

// Pure cleanup targeting: given the current list of team members (from
// list-members) and players (from an admin `players` select), decides
// exactly what is safe to deactivate/clean and what must be left alone. No
// I/O, so every branch — including the ones a live staging project may
// never actually exercise, like a leftover smoke cashier that still owns
// players — is fully testable without a network call.
//
// `actorId` is the id of the admin account this script is itself signed in
// as, and it is always excluded from membersToDeactivate — an absolute
// rule, checked before the username pattern, not an edge case of it.
// runtime-smoke.cjs's own readConfig() requires SMOKE_TEST_ADMIN_EMAIL
// (the same value as STAGING_SMOKE_ADMIN_EMAIL) to start with `smoke_test`,
// so the operator admin account this tooling authenticates as is itself
// `smoke_test_`-shaped and would otherwise match isDisposableSmokeUsername.
// Found 2026-08-09: a real cleanup run deactivated its own calling admin
// account this way, then a later run's list-members call failed with 403
// ADMIN_REQUIRED because that account was no longer active.
function planCleanup(members, players, actorId) {
  const membersToDeactivate = [];
  const membersSkipped = [];
  for (const member of members || []) {
    if (member && actorId && member.id === actorId) continue; // Never deactivate the account performing the cleanup.
    if (!isDisposableSmokeUsername(member && member.username)) continue;
    if (member.is_active !== true) continue; // Already inactive: nothing to do.
    const assignedPlayers = Number(member.assigned_players || 0);
    if (assignedPlayers > 0) {
      // A "disposable" smoke cashier that still owns players cannot be
      // proven disposable — the well-behaved harness always empties a
      // cashier before the run ends. Fail closed rather than force a
      // reassignment this tooling was never asked to decide.
      membersSkipped.push({ id: member.id, username: member.username, reason: 'STILL_OWNS_PLAYERS', assignedPlayers });
      continue;
    }
    membersToDeactivate.push({ id: member.id, username: member.username });
  }

  // Every id-prefix match becomes a candidate run id to attempt cleanup for
  // — there is no client-side "skip, provenance uncertain" category for
  // players anymore (messenger is not readable here; see
  // groupLeftoverSmokePlayers's comment). The RPC itself is the sole,
  // authoritative arbiter of whether a candidate is genuine smoke debris.
  const leftoverGroups = groupLeftoverSmokePlayers(players);
  const playerRunIdsToClean = [...leftoverGroups.keys()];

  return Object.freeze({
    membersToDeactivate: Object.freeze(membersToDeactivate),
    membersSkipped: Object.freeze(membersSkipped),
    playerRunIdsToClean: Object.freeze(playerRunIdsToClean),
    playersSkipped: Object.freeze([])
  });
}

// Pure reconciliation planning for one demo lead: given its current row (or
// null if it does not exist yet), its canonical target (from DEMO_LEADS),
// the cashier ids for slots 'a'/'b', and whether an active proof already
// exists for it, returns an ordered list of abstract actions to reach the
// target state — or an 'unreconcilable' report if no safe path exists. The
// caller executes each action against the real RPCs; this function decides
// nothing about *how* to call them, only *what* needs to happen and in what
// order, so the decision itself is fully unit-testable without a live
// Supabase connection.
function planLeadReconciliation(currentPlayer, target, cashierIdBySlot, hasActiveProof) {
  const actions = [];
  let status = domain.STATUSES.NEW;
  let agentId = null;

  if (!currentPlayer) {
    actions.push({ type: 'create', id: target.id, phone: target.phone, email: target.email, messenger: target.messenger });
  } else {
    status = currentPlayer.status;
    agentId = currentPlayer.agent_id || null;
  }

  const targetAgentId = target.targetCashierSlot ? cashierIdBySlot.get(target.targetCashierSlot) : null;

  if (targetAgentId && agentId !== targetAgentId) {
    if (status === domain.STATUSES.NEW || status === domain.STATUSES.NO_ANSWER) {
      actions.push({ type: 'assign', id: target.id, agentId: targetAgentId });
      status = domain.STATUSES.ASSIGNED;
      agentId = targetAgentId;
    } else {
      return Object.freeze({ ok: false, reason: 'ASSIGNMENT_MISMATCH_NOT_RECONCILABLE', currentStatus: status, currentAgentId: agentId });
    }
  } else if (!targetAgentId && agentId) {
    // The canonical dataset never un-assigns a lead once assigned, and this
    // tooling has no product-supported "unassign" operation to call even if
    // it wanted to.
    return Object.freeze({ ok: false, reason: 'CANNOT_UNASSIGN', currentStatus: status, currentAgentId: agentId });
  }

  const hops = planStatusHops(status, target.targetStatus);
  if (hops === null) {
    return Object.freeze({ ok: false, reason: 'NO_LEGAL_STATUS_PATH', currentStatus: status, targetStatus: target.targetStatus });
  }

  for (const nextStatus of hops) {
    if (target.withProof && CLOSING_STATUSES_REQUIRING_PROOF.includes(nextStatus) && !hasActiveProof) {
      actions.push({ type: 'proof', id: target.id });
    }
    actions.push({
      type: 'status', id: target.id, next: nextStatus,
      reopen: status === domain.STATUSES.SUCCESS || status === domain.STATUSES.FAILED
    });
    status = nextStatus;
  }

  return Object.freeze({ ok: true, actions: Object.freeze(actions) });
}

module.exports = Object.freeze({
  STAGING_PROJECT_REF,
  SMOKE_TEST_USERNAME_PATTERN,
  SMOKE_TEST_PLAYER_ID_PATTERN,
  SMOKE_TEST_RUN_ID_PATTERN,
  DEMO_CASHIER_USERNAME_PATTERN,
  DEMO_LEAD_ID_PATTERN,
  DEMO_CASHIERS,
  DEMO_LEADS,
  isDisposableSmokeUsername,
  isDemoCashierUsername,
  isDemoLeadId,
  extractSmokeRunId,
  groupLeftoverSmokePlayers,
  planStatusHops,
  planCleanup,
  planLeadReconciliation
});
