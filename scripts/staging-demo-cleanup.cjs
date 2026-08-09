'use strict';

// Staging demo-prep, phase 1: cleanup. Deactivates leftover disposable
// smoke-test cashiers and removes leftover smoke-test players — both
// through the same reviewed, product-supported paths the existing staging
// smoke tooling already uses (team-management `set-member-active`, the
// `cleanup_smoke_test_run_atomic` RPC). Never touches anything else: an
// account or player that does not match the exact `smoke_test_` identity
// convention this repository's own tooling produces is left completely
// alone, and a smoke cashier that still owns players (so its disposability
// cannot be proven) is skipped and reported, not forced.
//
// This script never deletes or deactivates demo_* data — there is no
// delete-member or delete-player capability in this product, by design (see
// docs/decisions.md ADR-017), so "cleanup" for the persistent demo dataset
// is idempotent reconciliation, not removal; that is
// scripts/staging-demo-seed.cjs's job, not this one's.

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
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

  const report = { membersDeactivated: [], membersSkipped: [], playerRunsCleaned: [], playerRunsFailed: [], playersSkipped: [] };
  try {
    const membersResponse = await deps.fetchTeamManagement(functionsUrl, accessToken, { action: 'list-members' });
    if (membersResponse.status !== 200 || !membersResponse.body || membersResponse.body.ok !== true) {
      throw new Error(`LIST_MEMBERS_FAILED:${membersResponse.status}`);
    }
    // `messenger` (and phone/email) are not selectable by `authenticated` —
    // supabase/migrations/20260801000200_revoke_raw_contacts.sql revokes the
    // table-level grant and replaces it with an explicit column list that
    // omits every raw contact field, even for an admin. Only `id` is read
    // here; the messenger-marker match this used to pre-check client-side is
    // re-derived authoritatively inside cleanup_smoke_test_run_atomic itself
    // (security definer, reads p.messenger directly) — a candidate id that
    // turns out not to be genuine smoke debris simply deletes zero rows,
    // never an error, so calling the RPC for every id-prefix match is safe.
    const playersResult = await client.from('players').select('id');
    if (playersResult.error) throw playersResult.error;

    const plan = shared.planCleanup(membersResponse.body.data, playersResult.data);
    report.membersSkipped = plan.membersSkipped;
    report.playersSkipped = plan.playersSkipped;

    for (const member of plan.membersToDeactivate) {
      const requestId = crypto.randomUUID();
      const deactivated = await deps.fetchTeamManagement(functionsUrl, accessToken, {
        action: 'set-member-active', memberId: member.id, isActive: false, requestId
      });
      if (deactivated.status === 200 && deactivated.body && deactivated.body.ok === true) {
        report.membersDeactivated.push(member.username);
      } else {
        const code = deactivated.body && deactivated.body.error && deactivated.body.error.code;
        report.membersSkipped.push({ id: member.id, username: member.username, reason: `DEACTIVATE_FAILED:${code || deactivated.status}` });
      }
    }

    for (const runId of plan.playerRunIdsToClean) {
      try {
        const result = await client.rpc('cleanup_smoke_test_run_atomic', { p_run_id: runId, p_confirmation: `DELETE_SMOKE_TEST_${runId}` });
        if (result.error) throw result.error;
        report.playerRunsCleaned.push(runId);
      } catch (error) {
        // A caller mismatch (this admin did not create the leftover rows) or
        // any other RPC refusal means provenance is not provable by this
        // actor — report it, leave the rows exactly as they are.
        report.playerRunsFailed.push({ runId, reason: String(error && error.message || error) });
      }
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
      deps.emit(JSON.stringify({ schemaVersion: 1, ok: true, ...report }));
    } else {
      deps.log(`Deactivated ${report.membersDeactivated.length} leftover smoke cashier(s): ${report.membersDeactivated.join(', ') || '(none)'}`);
      for (const skip of report.membersSkipped) deps.log(`  - skipped member ${skip.username || skip.id}: ${skip.reason}`);
      deps.log(`Cleaned ${report.playerRunsCleaned.length} leftover smoke player run(s): ${report.playerRunsCleaned.join(', ') || '(none)'}`);
      for (const failure of report.playerRunsFailed) deps.log(`  - could not clean run ${failure.runId}: ${failure.reason}`);
      for (const skip of report.playersSkipped) deps.log(`  - left in place (ambiguous provenance): ${skip.id} (${skip.reason})`);
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

module.exports = { main, run, createDeps, callTeamManagement };
