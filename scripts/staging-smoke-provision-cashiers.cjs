'use strict';

// Provisions two disposable, run-scoped cashier accounts on staging through
// the reviewed team-management Edge Function's `create-member` action — the
// same product-supported path an admin uses from the UI, not a direct
// database or Auth-admin mutation. Each account is created with a freshly
// generated temporary password (never logged, never persisted) so it can
// sign in immediately, with no email-confirmation step to wait on.
//
// Designed to be piped into tests/runtime-smoke.cjs's staging write mode:
// this script's stdout is exactly two lines, `email<TAB>password`, one per
// created cashier, for the caller to consume — nothing else is printed.

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { validateRunId } = require('./runtime-smoke.cjs');

function requireEnv(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function generatePassword() {
  // 24 bytes of entropy, base64url — comfortably inside the Edge Function's
  // 8-200 character bound and never dictionary-guessable.
  return crypto.randomBytes(24).toString('base64url');
}

function buildCashier(runId, slot) {
  const email = `smoke_test_${runId}_cashier_${slot}@example.invalid`;
  const username = `smoke_test_${runId}_${slot}`;
  const name = `Smoke Test Cashier ${slot.toUpperCase()}`;
  return { email, username, name, password: generatePassword() };
}

async function createMember(functionsUrl, adminAccessToken, cashier) {
  const response = await fetch(`${functionsUrl}/team-management`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'create-member',
      email: cashier.email,
      username: cashier.username,
      name: cashier.name,
      country: 'EC',
      temporaryPassword: cashier.password,
      requestId: crypto.randomUUID()
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.ok !== true) {
    const code = body && body.error && body.error.code;
    throw new Error(`CREATE_MEMBER_FAILED:${cashier.email}:${response.status}:${code || 'UNKNOWN'}`);
  }
  return body.data;
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
  const a = buildCashier(runId, 'a');
  const b = buildCashier(runId, 'b');
  try {
    await createMember(functionsUrl, accessToken, a);
    await createMember(functionsUrl, accessToken, b);
  } finally {
    // Signing out earlier revokes this session, and the Edge Function
    // validates the bearer token against Auth on every call — the token
    // must stay live until every call that needs it has finished.
    await client.auth.signOut({ scope: 'local' });
  }

  process.stdout.write(`${a.email}\t${a.password}\n`);
  process.stdout.write(`${b.email}\t${b.password}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Cashier provisioning failed: ${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildCashier, generatePassword };
