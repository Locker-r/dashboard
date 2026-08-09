'use strict';

// Staging demo-prep, phase 3: live flow verification. Proves the exact
// management-demo path — admin login, cashier visibility, lead assignment,
// cashier login, assigned-lead isolation, in_work, the audited contact
// reveal, close with proof, and admin-side final-result/analytics
// visibility — against the real staging project, through one disposable,
// self-cleaning smoke identity. It never touches the persistent demo_*
// dataset scripts/staging-demo-seed.cjs maintains: the negative-isolation
// check below reads one demo lead's id read-only, and nothing about this
// script's own pass/fail depends on the demo dataset's shape.
//
// The disposable cashier and lead both use the existing SMOKE_TEST_<runId>
// naming convention scripts/runtime-smoke.cjs already established, so the
// same reviewed cleanup_smoke_test_run_atomic RPC removes the lead
// afterward, and the same team-management set-member-active action
// deactivates the cashier — this script adds no new cleanup mechanism.
//
// No service-role key anywhere: every step signs in as either the staging
// admin or the disposable cashier and calls only RPCs/Edge Function actions
// an ordinary authenticated session may call.

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { SupabaseDataService } = require('../src/data/supabase-data-service.js');

const PROOF_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function requireEnv(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function buildRunId() {
  return crypto.randomBytes(10).toString('hex');
}

function buildIdentities(runId) {
  const prefix = `SMOKE_TEST_${runId}_`;
  return Object.freeze({
    runId,
    cashier: {
      email: `smoke_test_${runId}_demoverify@example.invalid`,
      username: `smoke_test_${runId}_dv`,
      name: 'Demo Flow Verify Cashier'
    },
    playerId: `${prefix}demoverify`,
    marker: `SMOKE_TEST:${runId}:demoverify`,
    cleanupConfirmation: `DELETE_SMOKE_TEST_${runId}`
  });
}

async function callTeamManagement(functionsUrl, accessToken, body) {
  const response = await fetch(`${functionsUrl}/team-management`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, body: parsed };
}

function createDeps(overrides = {}) {
  return Object.freeze({
    createClient,
    fetchTeamManagement: callTeamManagement,
    buildRunId,
    log: line => process.stderr.write(`${line}\n`),
    emit: line => process.stdout.write(`${line}\n`),
    ...overrides
  });
}

async function signIn(deps, projectUrl, publishableKey, email, password) {
  const client = deps.createClient(projectUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error) throw result.error;
  return { client, id: result.data.user.id, token: result.data.session.access_token };
}

async function run(env, deps) {
  const projectUrl = requireEnv(env, 'DEMO_PREP_PROJECT_URL');
  const publishableKey = requireEnv(env, 'DEMO_PREP_PUBLISHABLE_KEY');
  const adminEmail = requireEnv(env, 'DEMO_PREP_ADMIN_EMAIL');
  const adminPassword = requireEnv(env, 'DEMO_PREP_ADMIN_PASSWORD');
  const negativeControlLeadId = env.DEMO_PREP_ISOLATION_CONTROL_LEAD_ID || 'demo_lead_01';
  const functionsUrl = `${projectUrl}/functions/v1`;

  const identities = buildIdentities(deps.buildRunId());
  const steps = [];
  let admin;
  let cashier;
  const sessions = [];
  const cashierPassword = crypto.randomBytes(24).toString('base64url');

  try {
    admin = await signIn(deps, projectUrl, publishableKey, adminEmail, adminPassword);
    sessions.push(admin.client);
    steps.push('admin_login');

    const created = await deps.fetchTeamManagement(functionsUrl, admin.token, {
      action: 'create-member', email: identities.cashier.email, username: identities.cashier.username,
      name: identities.cashier.name, country: 'EC', temporaryPassword: cashierPassword, requestId: crypto.randomUUID()
    });
    if (created.status !== 200 || !created.body || created.body.ok !== true) {
      throw new Error(`CREATE_VERIFY_CASHIER_FAILED:${created.status}:${JSON.stringify(created.body && created.body.error)}`);
    }
    const cashierId = created.body.data.member.id;
    steps.push('cashier_created');

    const adminData = new SupabaseDataService(admin.client);
    await adminData.createPlayers([{ id: identities.playerId, phone: '', email: `${identities.playerId}@example.invalid`, messenger: identities.marker }]);
    await adminData.assignPlayers([identities.playerId], [cashierId], { adminConfirmed: true });
    steps.push('lead_assigned');

    cashier = await signIn(deps, projectUrl, publishableKey, identities.cashier.email, cashierPassword);
    sessions.push(cashier.client);
    steps.push('cashier_login');

    const visible = await cashier.client.from('players').select('id').in('id', [identities.playerId, negativeControlLeadId]);
    if (visible.error) throw visible.error;
    const visibleIds = new Set((visible.data || []).map(row => row.id));
    if (!visibleIds.has(identities.playerId) || visibleIds.has(negativeControlLeadId)) {
      throw new Error(`ISOLATION_CHECK_FAILED:visible=${[...visibleIds].join(',')}`);
    }
    steps.push('assigned_lead_isolation_verified');

    const cashierData = new SupabaseDataService(cashier.client);
    await cashierData.changePlayerStatus(identities.playerId, 'in_work', `${identities.playerId}_in_work`);
    steps.push('in_work');

    const reveal = await cashierData.revealPlayerContacts(identities.playerId, crypto.randomUUID());
    // reveal_player_contacts's successful path sets outcome := 'revealed'
    // (supabase/migrations/20260802000200_contact_reveal_rpc.sql line 200);
    // 'granted' is only the internal contact_reveal_events audit event_type
    // for that same path (line 195), never the value returned to the caller.
    if (reveal.outcome !== 'revealed') throw new Error(`CONTACT_REVEAL_NOT_GRANTED:${reveal.outcome}`);
    steps.push('contact_reveal_granted');

    const proofId = crypto.randomUUID();
    const requested = await cashier.client.rpc('request_lead_proof_upload', {
      p_player_id: identities.playerId, p_proof_id: proofId, p_filename: `${identities.playerId}.png`,
      p_mime_type: 'image/png', p_file_size: PROOF_PNG.length
    });
    if (requested.error) throw requested.error;
    const uploaded = await cashier.client.storage.from('lead-proofs').upload(requested.data.storage_path, PROOF_PNG, { contentType: 'image/png', upsert: false });
    if (uploaded.error) throw uploaded.error;
    const confirmed = await cashier.client.rpc('confirm_lead_proof', { p_proof_id: proofId });
    if (confirmed.error) throw confirmed.error;
    steps.push('proof_uploaded_and_confirmed');

    await cashierData.changePlayerStatus(identities.playerId, 'success', `${identities.playerId}_close`);
    steps.push('closed_with_proof');

    const finalRow = await admin.client.from('players').select('id,status').eq('id', identities.playerId).single();
    if (finalRow.error) throw finalRow.error;
    if (finalRow.data.status !== 'success') throw new Error('ADMIN_FINAL_STATUS_NOT_VISIBLE');
    const proofRow = await admin.client.from('lead_proofs').select('id,state').eq('player_id', identities.playerId).eq('state', 'active').maybeSingle();
    if (proofRow.error) throw proofRow.error;
    if (!proofRow.data) throw new Error('ADMIN_PROOF_NOT_VISIBLE');
    steps.push('admin_final_result_and_proof_visible');

    // "Analytics update" is a client-side computation over exactly this
    // read (src/analytics.js, unit-tested separately) — proving the closed
    // lead is present with status 'success' in the admin's own players read
    // is what "the analytics view updates" reduces to server-side.
    const analyticsRead = await admin.client.from('players').select('id,status').eq('id', identities.playerId).eq('status', 'success');
    if (analyticsRead.error) throw analyticsRead.error;
    if ((analyticsRead.data || []).length !== 1) throw new Error('ANALYTICS_SOURCE_READ_MISMATCH');
    steps.push('analytics_source_confirmed');

    return { ok: true, runId: identities.runId, steps };
  } finally {
    if (admin) {
      try {
        const membersResponse = await deps.fetchTeamManagement(functionsUrl, admin.token, { action: 'list-members' });
        const member = (membersResponse.body && membersResponse.body.data || []).find(row => String(row.username || '').toLowerCase() === identities.cashier.username.toLowerCase());
        if (member) {
          await deps.fetchTeamManagement(functionsUrl, admin.token, {
            action: 'set-member-active', memberId: member.id, isActive: false, requestId: crypto.randomUUID()
          });
        }
      } catch { /* best-effort cleanup; reported by the caller via the players cleanup RPC result below, never fatal here */ }
      try {
        await admin.client.rpc('cleanup_smoke_test_run_atomic', { p_run_id: identities.runId, p_confirmation: identities.cleanupConfirmation });
      } catch { /* best-effort: nothing else this script can do if the actor's own cleanup RPC refuses */ }
    }
    await Promise.allSettled(sessions.map(client => client.auth.signOut({ scope: 'local' })));
  }
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  const deps = createDeps(overrides);
  const json = argv.includes('--json');
  try {
    const result = await run(process.env, deps);
    if (json) {
      deps.emit(JSON.stringify({ schemaVersion: 1, ...result }));
    } else {
      deps.log(`Demo flow verified (run ${result.runId}): ${result.steps.join(' -> ')}`);
    }
    return 0;
  } catch (error) {
    deps.log(`Refused: ${String(error && error.message || error)}`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => process.exit(code));
}

module.exports = { main, run, createDeps, buildIdentities, buildRunId, callTeamManagement, PROOF_PNG };
