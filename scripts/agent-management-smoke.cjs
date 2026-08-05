'use strict';
// Runtime security verification for Supabase-native cashier management (B2).
//
// Drives the deployed team-management Edge Function over HTTP with real
// per-user JWTs. The service role key is never used to obtain a result that is
// then asserted as an access-control outcome; it appears only to read back what
// the server actually wrote.
const { createClient } = require('@supabase/supabase-js');
const { normalizeUrl, isLoopback } = require('./runtime-smoke.cjs');
const randomId = () => require('node:crypto').randomUUID();

const failures = [];
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return true; }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
  console.log(`  FAIL  ${name} :: ${detail || ''}`);
  return false;
}

async function signIn(url, key, email, password) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error || !result.data.session) throw result.error || new Error(`SIGN_IN_FAILED_${email}`);
  return { client, user: result.data.user, token: result.data.session.access_token };
}

function callFactory(functionsUrl) {
  return async function call(token, body) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${functionsUrl}/team-management`, {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, body: payload };
  };
}

function refusedWith(name, result, status, code) {
  const actualCode = result.body && result.body.error && result.body.error.code;
  return check(name,
    result.status === status && result.body && result.body.ok === false && (!code || actualCode === code),
    `status=${result.status} ok=${result.body && result.body.ok} code=${actualCode}`);
}

// The platform's own JWT gate (config.toml verify_jwt = true) answers before the
// function body ever runs, so an absent or unparsable token is rejected by the
// gateway with its own payload shape. Either layer refusing is a pass; what must
// never happen is the request being served.
function refusedBeforeHandler(name, result) {
  return check(name, result.status === 401 || result.status === 403,
    `status=${result.status} body=${JSON.stringify(result.body)}`);
}

async function main() {
  const url = normalizeUrl(process.env.SMOKE_TEST_PROJECT_URL);
  const key = process.env.SMOKE_TEST_PUBLISHABLE_KEY;
  const serviceKey = process.env.SMOKE_TEST_LOCAL_SERVICE_KEY;
  const runId = String(process.argv[2] || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!isLoopback(url) || !key || !serviceKey) throw new Error('LOCAL_SECURITY_SMOKE_CONFIG_REQUIRED');
  if (runId.length < 6) throw new Error('RUN_ID_REQUIRED');

  const call = callFactory(`${url}/functions/v1`);
  const admin = await signIn(url, key, process.env.SMOKE_TEST_ADMIN_EMAIL, process.env.SMOKE_TEST_ADMIN_PASSWORD);
  const agentA = await signIn(url, key, process.env.SMOKE_TEST_AGENT_A_EMAIL, process.env.SMOKE_TEST_AGENT_A_PASSWORD);
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const newEmail = `smoke_test_${runId}_cashier@local.invalid`;
  const newUsername = `SMOKE_TEST_${runId}_c1`;
  const password = `LocalOnly_${runId}_Pw1`;
  let createdId = null;

  try {
    console.log('\n[1] the function refuses everyone who is not an active admin');
    refusedBeforeHandler('no token is refused', await call(null, { action: 'list-members' }));
    refusedBeforeHandler('a garbage token is refused', await call('not-a-jwt', { action: 'list-members' }));
    refusedWith('an agent token is refused', await call(agentA.token, { action: 'list-members' }), 403, 'ADMIN_REQUIRED');
    refusedWith('an agent cannot create a cashier', await call(agentA.token, {
      action: 'create-member', email: `smoke_test_${runId}_x@local.invalid`,
      username: `SMOKE_TEST_${runId}_x`, name: 'X', country: 'EC', requestId: randomId()
    }), 403, 'ADMIN_REQUIRED');
    refusedWith('an agent cannot deactivate anyone', await call(agentA.token, {
      action: 'set-member-active', memberId: agentA.user.id, isActive: false, requestId: randomId()
    }), 403, 'ADMIN_REQUIRED');
    refusedWith('an agent cannot change a country', await call(agentA.token, {
      action: 'update-member-country', memberId: agentA.user.id, country: 'PE', requestId: randomId()
    }), 403, 'ADMIN_REQUIRED');
    refusedWith('an agent cannot promote themselves', await call(agentA.token, {
      action: 'update-member-role', memberId: agentA.user.id, role: 'admin', requestId: randomId()
    }), 403, 'ADMIN_REQUIRED');
    refusedWith('an unknown action is refused', await call(admin.token, { action: 'delete-member' }), 400, 'INVALID_ACTION');

    console.log('\n[2] input validation happens before any Auth write');
    refusedWith('a malformed email is refused', await call(admin.token, {
      action: 'create-member', email: 'not-an-email', username: newUsername, name: 'N', country: 'EC', requestId: randomId()
    }), 400, 'INVALID_EMAIL');
    refusedWith('a malformed country is refused', await call(admin.token, {
      action: 'create-member', email: newEmail, username: newUsername, name: 'N', country: 'ECU', requestId: randomId()
    }), 400, 'INVALID_COUNTRY');
    refusedWith('a short temporary password is refused', await call(admin.token, {
      action: 'create-member', email: newEmail, username: newUsername, name: 'N', country: 'EC',
      temporaryPassword: 'short', requestId: randomId()
    }), 400, 'INVALID_PASSWORD');
    const notCreated = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    check('no Auth user was created by any refused request',
      !notCreated.error && !notCreated.data.users.some(u => (u.email || '').toLowerCase() === newEmail),
      'an Auth user leaked from a validation failure');

    console.log('\n[3] an active admin creates a cashier');
    const created = await call(admin.token, {
      action: 'create-member', email: newEmail, username: newUsername, name: 'Smoke Cashier',
      country: 'ec', temporaryPassword: password, requestId: randomId()
    });
    check('create-member returned ok', created.status === 200 && created.body && created.body.ok === true,
      `status=${created.status} body=${JSON.stringify(created.body && created.body.error)}`);
    const member = created.body && created.body.data && created.body.data.member;
    createdId = member && member.id;
    check('the profile was created with role agent', member && member.role === 'agent', `role=${member && member.role}`);
    check('the country was normalised to uppercase', member && member.country === 'EC', `country=${member && member.country}`);
    check('the cashier is active', member && member.is_active === true, `is_active=${member && member.is_active}`);

    const authUsers = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const authUser = authUsers.data.users.find(u => (u.email || '').toLowerCase() === newEmail);
    check('a matching Auth user exists', Boolean(authUser), 'no Auth user');
    check('the Auth user and the profile share one id', authUser && createdId && authUser.id === createdId,
      `auth=${authUser && authUser.id} profile=${createdId}`);

    console.log('\n[4] the created cashier can actually sign in and is correctly scoped');
    const cashier = await signIn(url, key, newEmail, password);
    check('the new cashier signs in with the temporary password', Boolean(cashier.user), 'sign-in failed');
    const ownProfile = await cashier.client.from('profiles').select('id,role,is_active,country').eq('id', cashier.user.id).single();
    check('the cashier reads their own profile as an active agent',
      !ownProfile.error && ownProfile.data.role === 'agent' && ownProfile.data.is_active === true && ownProfile.data.country === 'EC',
      String(ownProfile.error && ownProfile.error.message));
    const otherProfiles = await cashier.client.from('profiles').select('id');
    check('the cashier sees only their own profile row', !otherProfiles.error && otherProfiles.data.length === 1,
      `rows=${otherProfiles.data && otherProfiles.data.length}`);
    refusedWith('the new cashier cannot call the admin function',
      await call(cashier.token, { action: 'list-members' }), 403, 'ADMIN_REQUIRED');

    console.log('\n[5] duplicates are reported, not silently adopted');
    refusedWith('a duplicate email is refused', await call(admin.token, {
      action: 'create-member', email: newEmail, username: `${newUsername}_2`, name: 'Dup', country: 'EC',
      temporaryPassword: password, requestId: randomId()
    }), 409, 'USER_ALREADY_EXISTS');
    const dupUsername = await call(admin.token, {
      action: 'create-member', email: `smoke_test_${runId}_dup@local.invalid`, username: newUsername,
      name: 'Dup', country: 'EC', temporaryPassword: password, requestId: randomId()
    });
    check('a duplicate username is refused with a stable code',
      dupUsername.body && dupUsername.body.ok === false
        && dupUsername.body.error.code === 'USERNAME_ALREADY_EXISTS',
      `code=${dupUsername.body && dupUsername.body.error && dupUsername.body.error.code}`);
    const afterDup = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    check('the failed duplicate-username create left no orphan Auth user',
      !afterDup.data.users.some(u => (u.email || '').toLowerCase() === `smoke_test_${runId}_dup@local.invalid`),
      'an orphan Auth user survived a failed profile insert');

    console.log('\n[6] country changes are recorded and never reassign leads');
    const countryChange = await call(admin.token, {
      action: 'update-member-country', memberId: createdId, country: 'pe', requestId: randomId()
    });
    check('update-member-country returned ok', countryChange.status === 200 && countryChange.body.ok === true,
      JSON.stringify(countryChange.body && countryChange.body.error));
    check('the response reports the previous country and the retained lead count',
      countryChange.body.data && countryChange.body.data.previous_country === 'EC'
        && countryChange.body.data.assigned_players === 0,
      JSON.stringify(countryChange.body.data));
    const afterCountry = await service.rpc('team_list_members', { p_actor_id: admin.user.id });
    const listed = (afterCountry.data || []).find(row => row.id === createdId);
    check('the stored country is PE', listed && listed.country === 'PE', `country=${listed && listed.country}`);

    console.log('\n[7] deactivation takes effect against an already-issued token');
    const deactivated = await call(admin.token, {
      action: 'set-member-active', memberId: createdId, isActive: false, requestId: randomId()
    });
    check('set-member-active(false) returned ok', deactivated.status === 200 && deactivated.body.ok === true,
      JSON.stringify(deactivated.body && deactivated.body.error));
    const deadRead = await cashier.client.from('players').select('id');
    check('the deactivated cashier reads no players with their live token',
      !deadRead.error && deadRead.data.length === 0, `rows=${deadRead.data && deadRead.data.length}`);
    const deadRpc = await cashier.client.rpc('request_lead_proof_upload', {
      p_player_id: 'nonexistent', p_proof_id: randomId(), p_filename: 'x.png', p_mime_type: 'image/png', p_file_size: 10
    });
    check('the deactivated cashier is refused by an RPC with ACTIVE_PROFILE_REQUIRED',
      Boolean(deadRpc.error) && String(deadRpc.error.message).includes('ACTIVE_PROFILE_REQUIRED'),
      String(deadRpc.error && deadRpc.error.message));

    console.log('\n[8] reactivation restores access without a new Auth user');
    const reactivated = await call(admin.token, {
      action: 'set-member-active', memberId: createdId, isActive: true, requestId: randomId()
    });
    check('set-member-active(true) returned ok', reactivated.status === 200 && reactivated.body.ok === true,
      JSON.stringify(reactivated.body && reactivated.body.error));
    const revived = await cashier.client.from('profiles').select('id,is_active').eq('id', cashier.user.id).single();
    check('the same token works again after reactivation',
      !revived.error && revived.data.is_active === true, String(revived.error && revived.error.message));
    const usersNow = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    check('reactivation created no second Auth user',
      usersNow.data.users.filter(u => (u.email || '').toLowerCase() === newEmail).length === 1,
      'duplicate Auth user');

    console.log('\n[9] privilege escalation stays blocked');
    refusedWith('an admin cannot promote themselves through this function',
      await call(admin.token, { action: 'update-member-role', memberId: admin.user.id, role: 'admin', requestId: randomId() }),
      409, 'SELF_PROMOTION_FORBIDDEN');
    const cashierStillAgent = await service.rpc('team_list_members', { p_actor_id: admin.user.id });
    const stillAgent = (cashierStillAgent.data || []).find(row => row.id === createdId);
    check('the created cashier is still an agent', stillAgent && stillAgent.role === 'agent',
      `role=${stillAgent && stillAgent.role}`);
    const directRpc = await agentA.client.rpc('team_register_member', {
      p_actor_id: admin.user.id, p_target_id: randomId(), p_username: 'x1', p_name: 'X',
      p_country: 'EC', p_request_id: randomId()
    });
    check('an agent cannot call the team RPC directly, bypassing the function',
      Boolean(directRpc.error), 'the direct RPC SUCCEEDED');

    console.log('\n[10] idempotency and replay');
    const replayId = randomId();
    const first = await call(admin.token, {
      action: 'update-member-country', memberId: createdId, country: 'CO', requestId: replayId
    });
    const replay = await call(admin.token, {
      action: 'update-member-country', memberId: createdId, country: 'CO', requestId: replayId
    });
    check('an identical replay returns the same recorded result',
      first.body.ok === true && replay.body.ok === true
        && JSON.stringify(first.body.data.member.country) === JSON.stringify(replay.body.data.member.country),
      'replay diverged');
    refusedWith('the same request id with different values is refused', await call(admin.token, {
      action: 'update-member-country', memberId: createdId, country: 'AR', requestId: replayId
    }), 409, 'REQUEST_ID_REUSE');

    console.log('\n[11] the shipped browser bundle carries no elevated secret');
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const bundleFiles = ['index.html', 'src/team-admin.js', 'src/lead-proof.js', 'src/data/supabase-data-service.js'];
    const elevated = /service_role|SUPABASE_SERVICE_ROLE_KEY|sb_secret_|eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}/;
    const leaking = bundleFiles.filter(file => elevated.test(fs.readFileSync(path.join(root, file), 'utf8')));
    check('no frontend file references a service role key or secret', leaking.length === 0, leaking.join(', '));
  } finally {
    console.log('\n[12] the audit trail is append-only, so members are retired, not erased');
    if (createdId) {
      // admin_audit_events.target_user_id references profiles with ON DELETE
      // RESTRICT, and no role -- not even service_role -- holds DELETE on that
      // table. A member who has ever been acted on therefore cannot be deleted,
      // which is exactly the business rule: deactivate, never destroy history.
      const auditDelete = await service.from('admin_audit_events').delete().eq('target_user_id', createdId);
      check('not even the service role can delete audit rows',
        Boolean(auditDelete.error), 'audit history was DELETED');
      const userDelete = await service.auth.admin.deleteUser(createdId);
      check('the Auth user cannot be deleted while audit history references it',
        Boolean(userDelete.error), 'the audited member was DELETED');
      const auditRows = await service.rpc('team_list_members', { p_actor_id: admin.user.id });
      check('the member still exists and is auditable',
        (auditRows.data || []).some(row => row.id === createdId), 'the member vanished');

      // Retire the synthetic account instead: deactivated, so it can never sign
      // in again, and still named SMOKE_TEST for a later bulk local reset.
      const retired = await call(admin.token, {
        action: 'set-member-active', memberId: createdId, isActive: false, requestId: randomId()
      });
      check('the synthetic cashier was retired (deactivated)',
        retired.status === 200 && retired.body.ok === true,
        JSON.stringify(retired.body && retired.body.error));
    }
    await Promise.allSettled([admin, agentA].map(s => s.client.auth.signOut({ scope: 'local' })));
  }

  const total = failures.length;
  console.log(`\n${total ? 'FAILED' : 'PASSED'}: agent management runtime security (${total} failure${total === 1 ? '' : 's'})`);
  if (total) { failures.forEach(f => console.log(`  - ${f}`)); process.exitCode = 1; }
}

if (require.main === module) main().catch(error => {
  console.error(`Agent management smoke failed: ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
