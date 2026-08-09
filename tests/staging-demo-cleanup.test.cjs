'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cleanup = require('../scripts/staging-demo-cleanup.cjs');

const ENV = Object.freeze({
  DEMO_PREP_PROJECT_URL: 'https://cjdxtakgmnzwixrajjry.supabase.co',
  DEMO_PREP_PUBLISHABLE_KEY: 'synthetic-publishable-key',
  DEMO_PREP_ADMIN_EMAIL: 'admin@example.invalid',
  DEMO_PREP_ADMIN_PASSWORD: 'synthetic-admin-password'
});

// Mirrors the real grant exactly: `authenticated` (admin included) may
// select only id/status/agent_id/created_by/imported_at/updated_at/
// follow_up_at from `players` — never phone/email/messenger
// (supabase/migrations/20260801000200_revoke_raw_contacts.sql). Selecting a
// raw contact column here fails the same way Postgres actually does, which
// is what the first real staging-demo-prep run hit ("permission denied for
// table players").
const SELECTABLE_PLAYER_COLUMNS = new Set(['id', 'status', 'agent_id', 'created_by', 'imported_at', 'updated_at', 'follow_up_at']);

function fakeSupabaseClient({ members = [], players = [] } = {}) {
  const calls = { rpc: [], selects: [] };
  return {
    calls,
    auth: {
      signInWithPassword: async () => ({ data: { session: { access_token: 'fake-admin-token' } }, error: null }),
      signOut: async () => ({ error: null })
    },
    from(table) {
      assert.equal(table, 'players');
      return {
        select(columns) {
          calls.selects.push(columns);
          const requested = String(columns || '').split(',').map(c => c.trim()).filter(Boolean);
          const forbidden = requested.find(column => !SELECTABLE_PLAYER_COLUMNS.has(column));
          if (forbidden) {
            return Promise.resolve({ data: null, error: { message: 'permission denied for table players', code: '42501' } });
          }
          return Promise.resolve({ data: players, error: null });
        }
      };
    },
    rpc: async (name, params) => {
      calls.rpc.push([name, params]);
      return { data: { deleted_players: 1 }, error: null };
    }
  };
}

function fakeCreateClient(client) {
  return () => client;
}

test('missing configuration fails closed with a usage-style refusal, before any network call', async () => {
  const logs = [];
  const status = await cleanup.main([], {
    createClient: () => { throw new Error('must not be called'); },
    log: line => logs.push(line), emit() {}
  });
  assert.equal(status, 1);
  assert.ok(logs.some(line => line.includes('MISSING_DEMO_PREP_PROJECT_URL')));
});

test('only smoke_test-prefixed, zero-player members are deactivated; unknown users are preserved', async () => {
  const members = [
    { id: 'm-real', username: 'maria_gonzalez', is_active: true, assigned_players: 5 },
    { id: 'm-demo', username: 'demo_cashier_a', is_active: true, assigned_players: 3 },
    { id: 'm-smoke-empty', username: 'smoke_test_abc123def456_a', is_active: true, assigned_players: 0 },
    { id: 'm-smoke-busy', username: 'smoke_test_abc123def456_b', is_active: true, assigned_players: 1 }
  ];
  const client = fakeSupabaseClient({ members });
  const teamManagementCalls = [];
  const fetchTeamManagement = async (functionsUrl, token, body) => {
    teamManagementCalls.push(body);
    if (body.action === 'list-members') return { status: 200, body: { ok: true, data: members } };
    if (body.action === 'set-member-active') return { status: 200, body: { ok: true, data: { member: { id: body.memberId, is_active: body.isActive } } } };
    throw new Error(`unexpected action: ${body.action}`);
  };

  process.env = { ...process.env, ...ENV };
  const status = await cleanup.main(['--json'], {
    createClient: fakeCreateClient(client), fetchTeamManagement,
    log() {}, emit() {}
  });
  assert.equal(status, 0);

  const deactivateCalls = teamManagementCalls.filter(body => body.action === 'set-member-active');
  assert.equal(deactivateCalls.length, 1);
  assert.equal(deactivateCalls[0].memberId, 'm-smoke-empty');
});

test('regression: the players select never requests messenger (or any other raw contact column), reproducing GitHub Actions run 31307205728', async () => {
  const players = [{ id: 'SMOKE_TEST_abc123def456_x' }];
  const client = fakeSupabaseClient({ players });
  process.env = { ...process.env, ...ENV };
  const logs = [];
  const status = await cleanup.main([], {
    createClient: fakeCreateClient(client),
    fetchTeamManagement: async () => ({ status: 200, body: { ok: true, data: [] } }),
    log: line => logs.push(line), emit() {}
  });
  assert.equal(status, 0, logs.join('\n'));
  assert.ok(!logs.some(line => line.includes('permission denied')));
  assert.equal(client.calls.selects.length, 1);
  const requestedColumns = String(client.calls.selects[0] || '').split(',').map(c => c.trim());
  for (const forbidden of ['messenger', 'phone', 'email']) {
    assert.ok(!requestedColumns.includes(forbidden), `must never select ${forbidden} from players`);
  }
});

test('leftover smoke players are cleaned via the existing cleanup RPC, one call per distinct run id', async () => {
  const players = [
    { id: 'SMOKE_TEST_abc123def456_assigned', messenger: 'SMOKE_TEST:abc123def456:assigned' },
    { id: 'SMOKE_TEST_abc123def456_other', messenger: 'SMOKE_TEST:abc123def456:other' },
    { id: 'demo_lead_01', messenger: '@camila_torres' }
  ];
  const client = fakeSupabaseClient({ players });
  process.env = { ...process.env, ...ENV };
  const status = await cleanup.main([], {
    createClient: fakeCreateClient(client),
    fetchTeamManagement: async () => ({ status: 200, body: { ok: true, data: [] } }),
    log() {}, emit() {}
  });
  assert.equal(status, 0);
  assert.equal(client.calls.rpc.length, 1);
  assert.equal(client.calls.rpc[0][0], 'cleanup_smoke_test_run_atomic');
  assert.equal(client.calls.rpc[0][1].p_run_id, 'abc123def456');
  assert.equal(client.calls.rpc[0][1].p_confirmation, 'DELETE_SMOKE_TEST_abc123def456');
});

test('a cleanup RPC refusal for one run is reported, not fatal, and does not stop the run', async () => {
  const players = [{ id: 'SMOKE_TEST_abc123def456_x', messenger: 'SMOKE_TEST:abc123def456:x' }];
  const client = fakeSupabaseClient({ players });
  client.rpc = async () => ({ data: null, error: { message: 'ADMIN_REQUIRED' } });
  process.env = { ...process.env, ...ENV };
  let emitted = null;
  const status = await cleanup.main(['--json'], {
    createClient: fakeCreateClient(client),
    fetchTeamManagement: async () => ({ status: 200, body: { ok: true, data: [] } }),
    log() {}, emit: line => { emitted = line; }
  });
  assert.equal(status, 0);
  const parsed = JSON.parse(emitted);
  assert.equal(parsed.playerRunsCleaned.length, 0);
  assert.equal(parsed.playerRunsFailed.length, 1);
  assert.equal(parsed.playerRunsFailed[0].runId, 'abc123def456');
});

test('no secret value ever appears in log or emit output', async () => {
  const client = fakeSupabaseClient({});
  process.env = { ...process.env, ...ENV };
  const outputs = [];
  await cleanup.main([], {
    createClient: fakeCreateClient(client),
    fetchTeamManagement: async () => ({ status: 200, body: { ok: true, data: [] } }),
    log: line => outputs.push(line), emit: line => outputs.push(line)
  });
  const joined = outputs.join('\n');
  assert.ok(!joined.includes(ENV.DEMO_PREP_ADMIN_PASSWORD));
  assert.ok(!/sb_secret_/i.test(joined));
});
