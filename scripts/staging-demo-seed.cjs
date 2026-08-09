'use strict';

// Staging demo-prep, phase 2: seed. Idempotently ensures the persistent demo
// dataset exists in its canonical shape — two cashier accounts and eight
// leads spread across every status — through the same product-supported
// RPCs and Edge Function actions the real UI uses. Every write is performed
// by the admin session alone; this product's RLS lets an admin perform any
// status transition or assignment regardless of ownership
// (supabase/migrations/20260729000200_atomic_writes.sql), so no cashier
// session or password needs to be created or remembered just to build the
// dataset. No service-role key is used anywhere in this script.
//
// Re-running is idempotent by construction: scripts/staging-demo-shared.cjs's
// planLeadReconciliation reads each lead's current state and computes only
// the actions still needed to reach its fixed target — creating nothing that
// already exists, re-assigning nothing that is already correctly assigned,
// and never re-uploading a proof that is already active. There is no
// delete-member or delete-player capability in this product (ADR-017), so
// "idempotent" here means "converges to the same canonical state," not
// "deletes and recreates."

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { SupabaseDataService } = require('../src/data/supabase-data-service.js');
const shared = require('./staging-demo-shared.cjs');

function requireEnv(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
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
    log: line => process.stderr.write(`${line}\n`),
    emit: line => process.stdout.write(`${line}\n`),
    ...overrides
  });
}

// A tiny, real 1x1 PNG — the same fixture scripts/runtime-smoke.cjs uses.
const PROOF_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function ensureCashiers(functionsUrl, accessToken, fetchTeamManagement) {
  const membersResponse = await fetchTeamManagement(functionsUrl, accessToken, { action: 'list-members' });
  if (membersResponse.status !== 200 || !membersResponse.body || membersResponse.body.ok !== true) {
    throw new Error(`LIST_MEMBERS_FAILED:${membersResponse.status}`);
  }
  const byUsername = new Map((membersResponse.body.data || []).map(row => [String(row.username || '').toLowerCase(), row]));
  const cashierIdBySlot = new Map();
  const report = [];

  for (const cashier of shared.DEMO_CASHIERS) {
    const existing = byUsername.get(cashier.username.toLowerCase());
    if (existing) {
      cashierIdBySlot.set(cashier.slot, existing.id);
      if (existing.is_active !== true) {
        const reactivated = await fetchTeamManagement(functionsUrl, accessToken, {
          action: 'set-member-active', memberId: existing.id, isActive: true, requestId: crypto.randomUUID()
        });
        if (reactivated.status !== 200 || !reactivated.body || reactivated.body.ok !== true) {
          throw new Error(`REACTIVATE_CASHIER_FAILED:${cashier.username}:${reactivated.status}`);
        }
        report.push({ slot: cashier.slot, username: cashier.username, action: 'reactivated' });
      } else {
        report.push({ slot: cashier.slot, username: cashier.username, action: 'already_active' });
      }
      continue;
    }
    const created = await fetchTeamManagement(functionsUrl, accessToken, {
      action: 'create-member', email: cashier.email, username: cashier.username, name: cashier.name,
      country: cashier.country, temporaryPassword: crypto.randomBytes(24).toString('base64url'), requestId: crypto.randomUUID()
    });
    if (created.status !== 200 || !created.body || created.body.ok !== true) {
      throw new Error(`CREATE_CASHIER_FAILED:${cashier.username}:${created.status}:${JSON.stringify(created.body && created.body.error)}`);
    }
    cashierIdBySlot.set(cashier.slot, created.body.data.member.id);
    report.push({ slot: cashier.slot, username: cashier.username, action: 'created' });
  }

  return { cashierIdBySlot, report };
}

async function hasActiveProof(client, playerId) {
  const result = await client.from('lead_proofs').select('id').eq('player_id', playerId).eq('state', 'active').maybeSingle();
  if (result.error) throw result.error;
  return Boolean(result.data);
}

async function executeAction(client, dataService, action) {
  if (action.type === 'create') {
    await dataService.createPlayers([{ id: action.id, phone: action.phone, email: action.email, messenger: action.messenger }]);
    return;
  }
  if (action.type === 'assign') {
    await dataService.assignPlayers([action.id], [action.agentId], { adminConfirmed: true });
    return;
  }
  if (action.type === 'proof') {
    const proofId = crypto.randomUUID();
    const requested = await client.rpc('request_lead_proof_upload', {
      p_player_id: action.id, p_proof_id: proofId, p_filename: `${action.id}.png`,
      p_mime_type: 'image/png', p_file_size: PROOF_PNG.length
    });
    if (requested.error) throw requested.error;
    const uploaded = await client.storage.from('lead-proofs').upload(requested.data.storage_path, PROOF_PNG, { contentType: 'image/png', upsert: false });
    if (uploaded.error) throw uploaded.error;
    const confirmed = await client.rpc('confirm_lead_proof', { p_proof_id: proofId });
    if (confirmed.error) throw confirmed.error;
    return;
  }
  if (action.type === 'status') {
    await dataService.changePlayerStatus(action.id, action.next, `${action.id}_${action.next}_${Date.now()}`, { adminConfirmed: action.reopen });
    return;
  }
  throw new Error(`UNKNOWN_ACTION_TYPE:${action.type}`);
}

async function run(env, deps) {
  const projectUrl = requireEnv(env, 'DEMO_PREP_PROJECT_URL');
  const publishableKey = requireEnv(env, 'DEMO_PREP_PUBLISHABLE_KEY');
  const adminEmail = requireEnv(env, 'DEMO_PREP_ADMIN_EMAIL');
  const adminPassword = requireEnv(env, 'DEMO_PREP_ADMIN_PASSWORD');
  const functionsUrl = `${projectUrl}/functions/v1`;

  const client = deps.createClient(projectUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await client.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (signIn.error) throw new Error(`ADMIN_SIGN_IN_FAILED:${signIn.error.message}`);
  const accessToken = signIn.data.session.access_token;
  const dataService = new SupabaseDataService(client);

  const report = { cashiers: [], leads: [], unreconcilable: [] };
  try {
    const { cashierIdBySlot, report: cashierReport } = await ensureCashiers(functionsUrl, accessToken, deps.fetchTeamManagement);
    report.cashiers = cashierReport;

    const existingResult = await client.from('players').select('id,status,agent_id').in('id', shared.DEMO_LEADS.map(lead => lead.id));
    if (existingResult.error) throw existingResult.error;
    const existingById = new Map((existingResult.data || []).map(row => [row.id, row]));

    for (const lead of shared.DEMO_LEADS) {
      const current = existingById.get(lead.id) || null;
      const proofAlready = lead.withProof ? await hasActiveProof(client, lead.id) : false;
      const plan = shared.planLeadReconciliation(current, lead, cashierIdBySlot, proofAlready);
      if (!plan.ok) {
        report.unreconcilable.push({ id: lead.id, reason: plan.reason });
        continue;
      }
      for (const action of plan.actions) await executeAction(client, dataService, action);
      report.leads.push({ id: lead.id, actionsApplied: plan.actions.length, targetStatus: lead.targetStatus });
    }
  } finally {
    await client.auth.signOut({ scope: 'local' });
  }
  return report;
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  const deps = createDeps(overrides);
  const json = argv.includes('--json');
  try {
    const report = await run(process.env, deps);
    if (json) {
      deps.emit(JSON.stringify({ schemaVersion: 1, ok: report.unreconcilable.length === 0, ...report }));
    } else {
      for (const cashier of report.cashiers) deps.log(`Cashier ${cashier.username}: ${cashier.action}`);
      for (const lead of report.leads) deps.log(`Lead ${lead.id}: ${lead.actionsApplied} action(s) applied, target ${lead.targetStatus}`);
      for (const bad of report.unreconcilable) deps.log(`  - could not reconcile ${bad.id}: ${bad.reason}`);
    }
    return report.unreconcilable.length === 0 ? 0 : 2;
  } catch (error) {
    deps.log(`Refused: ${String(error && error.message || error)}`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => process.exit(code));
}

module.exports = { main, run, createDeps, ensureCashiers, hasActiveProof, executeAction, callTeamManagement, PROOF_PNG };
