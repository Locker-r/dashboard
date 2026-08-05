'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const teamAdmin = require('../src/team-admin.js');
const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260805000200_agent_management.sql'), 'utf8');

function client(responder, calls) {
  return teamAdmin.createTeamAdminClient({
    functionsUrl: 'https://example.test/functions/v1',
    getAccessToken: async () => 'token-value',
    fetch: async (url, options) => {
      if (calls) calls.push({ url, options, body: JSON.parse(options.body) });
      return responder(url, options);
    },
    newRequestId: () => '11111111-1111-4111-8111-111111111111'
  });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('member form validation rejects every malformed field', () => {
  const valid = { email: 'Cashier@Example.com', name: 'Cashier One', username: 'cashier1', country: 'ec' };
  const good = teamAdmin.validateMemberForm(valid);
  assert.equal(good.ok, true);
  assert.equal(good.value.email, 'cashier@example.com', 'email is lowercased');
  assert.equal(good.value.country, 'EC', 'country is uppercased');
  assert.equal(good.value.temporaryPassword, null);

  const cases = [
    [{ ...valid, email: 'not-an-email' }, 'team_invalid_email'],
    [{ ...valid, email: '' }, 'team_invalid_email'],
    [{ ...valid, name: '' }, 'team_invalid_name'],
    [{ ...valid, name: 'x'.repeat(101) }, 'team_invalid_name'],
    [{ ...valid, username: 'a' }, 'team_invalid_username'],
    [{ ...valid, username: 'x'.repeat(51) }, 'team_invalid_username'],
    [{ ...valid, country: '' }, 'team_invalid_country'],
    [{ ...valid, country: 'ECU' }, 'team_invalid_country'],
    [{ ...valid, country: '12' }, 'team_invalid_country'],
    [{ ...valid, temporaryPassword: 'short' }, 'team_invalid_password']
  ];
  for (const [input, reason] of cases) {
    const result = teamAdmin.validateMemberForm(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} must be refused`);
    assert.equal(result.reason, reason);
  }
});

test('control characters are stripped from member input', () => {
  const dirty = `Cash${String.fromCharCode(0)}ier${String.fromCharCode(31)}`;
  const result = teamAdmin.validateMemberForm({
    email: 'a@b.co', name: dirty, username: 'cashier1', country: 'EC'
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.name, 'Cashier');
});

test('the client never sends a role, an actor id, or an isAdmin flag', async () => {
  const calls = [];
  const api = client(() => jsonResponse(200, { ok: true, data: { id: 'x' } }), calls);
  await api.createMember({ email: 'a@b.co', username: 'u1', name: 'N', country: 'EC', temporaryPassword: 'password123' });
  await api.updateMemberCountry('22222222-2222-4222-8222-222222222222', 'pe');
  await api.setMemberActive('22222222-2222-4222-8222-222222222222', false, undefined);
  for (const call of calls) {
    for (const forbidden of ['role', 'actor', 'actorId', 'isAdmin', 'p_role', 'admin']) {
      assert.equal(Object.prototype.hasOwnProperty.call(call.body, forbidden), false,
        `request must not carry ${forbidden}`);
    }
    assert.match(call.options.headers.authorization, /^Bearer /);
  }
  assert.equal(calls[1].body.country, 'PE', 'country is normalised before it is sent');
});

// The confirmed B2 defect: the access screen reported success for a write that
// never happened. These four cases pin the rule that only an ok:true envelope
// from the server can resolve an operation.
test('a non-2xx response rejects instead of resolving', async () => {
  const api = client(() => jsonResponse(403, { ok: false, error: { code: 'ADMIN_REQUIRED' } }));
  await assert.rejects(() => api.listMembers(), error => {
    assert.equal(error.code, 'ADMIN_REQUIRED');
    return true;
  });
});

test('a 200 response carrying ok:false rejects instead of resolving', async () => {
  const api = client(() => jsonResponse(200, { ok: false, error: { code: 'LAST_ACTIVE_ADMIN' } }));
  await assert.rejects(() => api.setMemberActive('22222222-2222-4222-8222-222222222222', false), error => {
    assert.equal(error.code, 'LAST_ACTIVE_ADMIN');
    return true;
  });
});

test('a 200 response with no envelope rejects instead of resolving', async () => {
  const api = client(() => jsonResponse(200, null));
  await assert.rejects(() => api.listMembers(), error => {
    assert.equal(error.code, 'HTTP_200');
    return true;
  });
});

test('a network failure rejects with a stable code and no transport detail', async () => {
  const api = client(() => { throw new Error('getaddrinfo ENOTFOUND internal.host'); });
  await assert.rejects(() => api.listMembers(), error => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.doesNotMatch(error.message, /ENOTFOUND|internal\.host/);
    return true;
  });
});

test('a missing session rejects before any request is sent', async () => {
  let sent = 0;
  const api = teamAdmin.createTeamAdminClient({
    functionsUrl: 'https://example.test/functions/v1',
    getAccessToken: async () => null,
    fetch: async () => { sent += 1; return jsonResponse(200, { ok: true, data: {} }); }
  });
  await assert.rejects(() => api.listMembers(), error => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    return true;
  });
  assert.equal(sent, 0, 'no request may be sent without a token');
});

test('a successful envelope resolves with exactly the server payload', async () => {
  const api = client(() => jsonResponse(200, { ok: true, data: { id: 'member-1', role: 'agent' } }));
  const result = await api.createMember({ email: 'a@b.co', username: 'u1', name: 'N', country: 'EC' });
  assert.deepEqual(result, { id: 'member-1', role: 'agent' });
});

test('server error codes map to stable reasons and never leak internals', () => {
  assert.equal(teamAdmin.teamErrorReason('ADMIN_REQUIRED'), 'team_admin_required');
  assert.equal(teamAdmin.teamErrorReason('USER_ALREADY_EXISTS'), 'team_user_exists');
  assert.equal(teamAdmin.teamErrorReason('USERNAME_ALREADY_EXISTS'), 'team_username_exists');
  assert.equal(teamAdmin.teamErrorReason('LAST_ACTIVE_ADMIN'), 'team_last_admin');
  assert.equal(teamAdmin.teamErrorReason('CREATE_PROFILE_FAILED_ORPHAN_USER'), 'team_create_orphan');
  assert.equal(teamAdmin.teamErrorReason('REASSIGNMENT_REQUIRED'), 'team_reassignment_required');
  assert.equal(teamAdmin.teamErrorReason('DATABASE_42501'), 'team_operation_failed');
  assert.equal(teamAdmin.teamErrorReason('relation "profiles" does not exist'), 'team_operation_failed');
  assert.equal(teamAdmin.teamErrorReason(undefined), 'team_operation_failed');
});

test('each request carries a fresh idempotency id', async () => {
  const seen = [];
  const api = teamAdmin.createTeamAdminClient({
    functionsUrl: 'https://example.test/functions/v1',
    getAccessToken: async () => 'token-value',
    fetch: async (_url, options) => { seen.push(JSON.parse(options.body).requestId); return jsonResponse(200, { ok: true, data: {} }); }
  });
  await api.setMemberActive('22222222-2222-4222-8222-222222222222', true);
  await api.setMemberActive('22222222-2222-4222-8222-222222222222', false);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'a replayed id would be refused by the server as REQUEST_ID_REUSE');
  for (const id of seen) assert.match(id, /^[0-9a-f-]{36}$/i);
});

test('an incomplete configuration is refused at construction', () => {
  assert.throws(() => teamAdmin.createTeamAdminClient({}), /TEAM_ADMIN_CONFIG_REQUIRED/);
  assert.throws(() => teamAdmin.createTeamAdminClient({ functionsUrl: 'https://x/functions/v1' }), /TEAM_ADMIN_CONFIG_REQUIRED/);
});

test('the access screen routes Supabase mode to the server and keeps local mode separate', () => {
  assert.match(indexHtml, /if\(dataMode==='supabase'\)\{ renderTeamView\(\); return; \}/);
  // The success message is produced in exactly one place, after the awaited
  // server call resolved. A thrown error returns before reaching it.
  const start = indexHtml.indexOf('async function runTeamOperation');
  const end = indexHtml.indexOf('async function submitNewMember');
  assert.ok(start > -1 && end > start);
  const body = indexHtml.slice(start, end);
  assert.match(body, /catch\(error\)\{[\s\S]*?return false;/);
  assert.ok(body.indexOf('return false;') < body.indexOf("setTeamMessage('success'"),
    'the failure path must return before any success message');
});

test('the country migration forces the agent role and validates the country shape', () => {
  assert.match(migration, /check \(country is null or country ~ '\^\[A-Z\]\{2\}\$'\)/);
  assert.match(migration, /values \(p_target_id, v_username, v_name, 'agent', 'es', true, v_country\)/);
  assert.doesNotMatch(migration, /p_role\s+public\.user_role/);
  assert.match(migration, /if v_country !~ '\^\[A-Z\]\{2\}\$' then\s*\n\s*raise exception using errcode = '22023', message = 'INVALID_COUNTRY'/);
});

test('a country change never reassigns leads on its own', () => {
  const start = migration.indexOf('function public.team_update_member_country');
  const body = migration.slice(start, migration.indexOf('drop function if exists public.team_list_members'));
  assert.doesNotMatch(body, /update public\.players/);
  assert.match(body, /select count\(\*\) into v_assigned from public\.players where agent_id = p_target_id/);
  assert.match(body, /'assigned_players', v_assigned/);
});

test('the new team functions are service_role only', () => {
  assert.match(migration, /revoke all on function[\s\S]*?from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function[\s\S]*?to service_role;/);
  assert.doesNotMatch(migration, /grant execute on function[\s\S]*?to authenticated/);
});
