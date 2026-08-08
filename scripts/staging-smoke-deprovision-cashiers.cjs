'use strict';

// Deactivates the disposable cashier accounts a smoke run created, through
// the same reviewed team-management `set-member-active` action an admin uses
// from the UI. There is no delete-member action — deactivation is the
// existing, reviewed disposal path, and it leaves the account as a clearly
// marked, inert staging record rather than removing data.
//
// Slots 'a' and 'b' are provisioned by staging-smoke-provision-cashiers.cjs
// before the run. Slot 'c' is provisioned by scripts/runtime-smoke.cjs itself,
// through the real create-member path, as part of proving the B2 admin
// cashier management contract — this script deactivates it the same way,
// computing the identical email from the same runId/slot naming.
//
// Always runs (the workflow calls this with `if: always()`), so a failed
// smoke run still leaves no active disposable cashier behind.

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { validateRunId } = require('./runtime-smoke.cjs');
const { buildCashier } = require('./staging-smoke-provision-cashiers.cjs');

function requireEnv(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

async function findMemberId(functionsUrl, adminAccessToken, email) {
  const response = await fetch(`${functionsUrl}/team-management`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list-members' })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.ok !== true) throw new Error(`LIST_MEMBERS_FAILED:${response.status}`);
  const member = (body.data || []).find(row => String(row.email || '').toLowerCase() === email.toLowerCase());
  return member ? member.id : null;
}

async function deactivate(functionsUrl, adminAccessToken, memberId) {
  const response = await fetch(`${functionsUrl}/team-management`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-member-active', memberId, isActive: false, requestId: crypto.randomUUID() })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.ok !== true) {
    const code = body && body.error && body.error.code;
    // REASSIGNMENT_REQUIRED means the cashier still holds smoke-test leads;
    // the run's own player cleanup runs first in the workflow specifically
    // so this does not happen in the normal case, but this script must not
    // throw past its own best-effort cleanup responsibility.
    throw new Error(`SET_MEMBER_ACTIVE_FAILED:${memberId}:${response.status}:${code || 'UNKNOWN'}`);
  }
}

async function main() {
  const env = process.env;
  const runId = validateRunId(process.argv[2]);
  const projectUrl = requireEnv(env, 'SMOKE_TEST_PROJECT_URL');
  const publishableKey = requireEnv(env, 'SMOKE_TEST_PUBLISHABLE_KEY');
  const adminEmail = requireEnv(env, 'SMOKE_TEST_ADMIN_EMAIL');
  const adminPassword = requireEnv(env, 'SMOKE_TEST_ADMIN_PASSWORD');

  const client = createClient(projectUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await client.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (signIn.error) throw new Error(`ADMIN_SIGN_IN_FAILED:${signIn.error.message}`);
  const accessToken = signIn.data.session.access_token;

  const functionsUrl = `${projectUrl}/functions/v1`;
  const emails = [buildCashier(runId, 'a').email, buildCashier(runId, 'b').email, buildCashier(runId, 'c').email];
  const failures = [];
  try {
    for (const email of emails) {
      try {
        const memberId = await findMemberId(functionsUrl, accessToken, email);
        if (!memberId) continue; // Never created, or already gone — nothing to deactivate.
        await deactivate(functionsUrl, accessToken, memberId);
      } catch (error) {
        failures.push(`${email}: ${String(error && error.message || error)}`);
      }
    }
  } finally {
    // Signing out earlier revokes this session, and the Edge Function
    // validates the bearer token against Auth on every call — the token
    // must stay live until every call that needs it has finished.
    await client.auth.signOut({ scope: 'local' });
  }
  if (failures.length) throw new Error(`CASHIER_DEACTIVATION_INCOMPLETE: ${failures.join('; ')}`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Cashier deprovisioning failed: ${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { findMemberId, deactivate };
