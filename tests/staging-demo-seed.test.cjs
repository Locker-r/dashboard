'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../scripts/staging-demo-seed.cjs');
const shared = require('../scripts/staging-demo-shared.cjs');

const ENV = Object.freeze({
  DEMO_PREP_PROJECT_URL: 'https://cjdxtakgmnzwixrajjry.supabase.co',
  DEMO_PREP_PUBLISHABLE_KEY: 'synthetic-publishable-key',
  DEMO_PREP_ADMIN_EMAIL: 'admin@example.invalid',
  DEMO_PREP_ADMIN_PASSWORD: 'synthetic-admin-password'
});

// A minimal fake mirroring the exact calls SupabaseDataService/callRpc make:
// client.rpc(name, params) and client.from(table).select/eq/in/single/maybeSingle.
function fakePlayersTable(store) {
  function build(filters) {
    return {
      eq(column, value) { return build([...filters, [column, value]]); },
      in(column, values) { return build([...filters, [column, 'in', values]]); },
      async maybeSingle() {
        const rows = applyFilters(store, filters);
        return { data: rows[0] || null, error: null };
      },
      async single() {
        const rows = applyFilters(store, filters);
        return { data: rows[0], error: rows[0] ? null : { message: 'NOT_FOUND' } };
      },
      then(resolve) { resolve({ data: applyFilters(store, filters), error: null }); }
    };
  }
  return { select: () => build([]) };
}

function applyFilters(store, filters) {
  return store.filter(row => filters.every(([column, opOrValue, value]) => {
    if (opOrValue === 'in') return value.includes(row[column]);
    return row[column] === opOrValue;
  }));
}

function fakeClient({ existingPlayers = [], activeProofPlayerIds = new Set() } = {}) {
  const rpcCalls = [];
  const store = [...existingPlayers];
  return {
    rpcCalls, store,
    auth: {
      signInWithPassword: async () => ({ data: { session: { access_token: 'fake-admin-token' }, user: { id: 'admin-id' } }, error: null }),
      signOut: async () => ({ error: null })
    },
    from(table) {
      if (table === 'players') return fakePlayersTable(store);
      if (table === 'lead_proofs') {
        return {
          select: () => ({
            eq: (col1, val1) => ({
              eq: (col2, val2) => ({
                async maybeSingle() {
                  const playerId = col1 === 'player_id' ? val1 : val2;
                  return { data: activeProofPlayerIds.has(playerId) ? { id: 'proof-id' } : null, error: null };
                }
              })
            })
          })
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }) }) },
    rpc: async (name, params) => {
      rpcCalls.push([name, params]);
      if (name === 'create_players_atomic') {
        for (const item of params.p_players) store.push({ id: item.id, status: 'new', agent_id: null });
        return { data: null, error: null };
      }
      if (name === 'assign_players_atomic') {
        for (const id of params.p_player_ids) {
          const row = store.find(r => r.id === id);
          if (row) { row.agent_id = params.p_agent_ids[0]; row.status = 'assigned'; }
        }
        return { data: null, error: null };
      }
      if (name === 'change_player_status_atomic') {
        const row = store.find(r => r.id === params.p_player_id);
        if (row) row.status = params.p_next_status;
        return { data: null, error: null };
      }
      if (name === 'request_lead_proof_upload') return { data: { storage_path: 'lead-proofs/x.png' }, error: null };
      if (name === 'confirm_lead_proof') return { data: { state: 'active' }, error: null };
      throw new Error(`unexpected rpc: ${name}`);
    }
  };
}

function fakeCreateClient(client) {
  return () => client;
}

test('missing configuration fails closed before any network call', async () => {
  const status = await seed.main([], {
    createClient: () => { throw new Error('must not be called'); },
    log() {}, emit() {}
  });
  assert.equal(status, 1);
});

test('cashiers are created idempotently: existing usernames are reused, not recreated', async () => {
  const teamManagementCalls = [];
  const existingMembers = [{ id: 'existing-a', username: 'demo_cashier_a', is_active: true }];
  const fetchTeamManagement = async (functionsUrl, token, body) => {
    teamManagementCalls.push(body);
    if (body.action === 'list-members') return { status: 200, body: { ok: true, data: existingMembers } };
    if (body.action === 'create-member') return { status: 200, body: { ok: true, data: { member: { id: 'new-b', role: 'agent' } } } };
    throw new Error(`unexpected action: ${body.action}`);
  };
  const client = fakeClient({});
  process.env = { ...process.env, ...ENV };
  await seed.main([], { createClient: fakeCreateClient(client), fetchTeamManagement, log() {}, emit() {} });

  const createCalls = teamManagementCalls.filter(body => body.action === 'create-member');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].username, 'demo_cashier_b');
  const reactivateCalls = teamManagementCalls.filter(body => body.action === 'set-member-active');
  assert.equal(reactivateCalls.length, 0, 'an already-active cashier must not be touched');
});

test('an inactive existing cashier is reactivated, not recreated', async () => {
  const teamManagementCalls = [];
  const existingMembers = shared.DEMO_CASHIERS.map((c, i) => ({ id: `existing-${i}`, username: c.username, is_active: i === 0 ? false : true }));
  const fetchTeamManagement = async (functionsUrl, token, body) => {
    teamManagementCalls.push(body);
    if (body.action === 'list-members') return { status: 200, body: { ok: true, data: existingMembers } };
    if (body.action === 'set-member-active') return { status: 200, body: { ok: true, data: {} } };
    throw new Error(`unexpected action: ${body.action}`);
  };
  const client = fakeClient({});
  process.env = { ...process.env, ...ENV };
  await seed.main([], { createClient: fakeCreateClient(client), fetchTeamManagement, log() {}, emit() {} });

  assert.equal(teamManagementCalls.some(body => body.action === 'create-member'), false);
  const reactivate = teamManagementCalls.find(body => body.action === 'set-member-active');
  assert.ok(reactivate);
  assert.equal(reactivate.memberId, 'existing-0');
  assert.equal(reactivate.isActive, true);
});

test('re-running seed on an already-converged dataset issues no player-mutating RPC at all', async () => {
  const existingMembers = shared.DEMO_CASHIERS.map((c, i) => ({ id: `agent-${c.slot}`, username: c.username, is_active: true }));
  const cashierIdBySlot = new Map(shared.DEMO_CASHIERS.map(c => [c.slot, `agent-${c.slot}`]));
  const existingPlayers = shared.DEMO_LEADS.map(lead => ({
    id: lead.id, status: lead.targetStatus,
    agent_id: lead.targetCashierSlot ? cashierIdBySlot.get(lead.targetCashierSlot) : null
  }));
  const activeProofPlayerIds = new Set(shared.DEMO_LEADS.filter(l => l.withProof).map(l => l.id));
  const client = fakeClient({ existingPlayers, activeProofPlayerIds });
  const fetchTeamManagement = async (functionsUrl, token, body) => {
    if (body.action === 'list-members') return { status: 200, body: { ok: true, data: existingMembers } };
    throw new Error(`unexpected action on a converged re-run: ${body.action}`);
  };
  process.env = { ...process.env, ...ENV };
  let emitted = null;
  const status = await seed.main(['--json'], { createClient: fakeCreateClient(client), fetchTeamManagement, log() {}, emit: line => { emitted = line; } });
  assert.equal(status, 0);
  assert.equal(client.rpcCalls.length, 0, 'a converged dataset must trigger zero mutating RPCs');
  const parsed = JSON.parse(emitted);
  assert.equal(parsed.unreconcilable.length, 0);
  assert.ok(parsed.leads.every(lead => lead.actionsApplied === 0));
});

test('a fresh seed creates all 8 leads and reaches the target shape, including the proof/close sequence', async () => {
  const existingMembers = shared.DEMO_CASHIERS.map((c, i) => ({ id: `agent-${c.slot}`, username: c.username, is_active: true }));
  const fetchTeamManagement = async (functionsUrl, token, body) => {
    if (body.action === 'list-members') return { status: 200, body: { ok: true, data: existingMembers } };
    throw new Error(`unexpected action: ${body.action}`);
  };
  const client = fakeClient({});
  process.env = { ...process.env, ...ENV };
  const status = await seed.main([], { createClient: fakeCreateClient(client), fetchTeamManagement, log() {}, emit() {} });
  assert.equal(status, 0);

  for (const lead of shared.DEMO_LEADS) {
    const row = client.store.find(r => r.id === lead.id);
    assert.ok(row, `${lead.id} must exist after seeding`);
    assert.equal(row.status, lead.targetStatus, `${lead.id} must reach ${lead.targetStatus}`);
  }
  const rpcNames = client.rpcCalls.map(([name]) => name);
  assert.ok(rpcNames.includes('request_lead_proof_upload'));
  assert.ok(rpcNames.includes('confirm_lead_proof'));
});

test('no secret value ever appears in log or emit output', async () => {
  const existingMembers = shared.DEMO_CASHIERS.map(c => ({ id: `agent-${c.slot}`, username: c.username, is_active: true }));
  const fetchTeamManagement = async (functionsUrl, token, body) => {
    if (body.action === 'list-members') return { status: 200, body: { ok: true, data: existingMembers } };
    throw new Error(`unexpected action: ${body.action}`);
  };
  const client = fakeClient({});
  process.env = { ...process.env, ...ENV };
  const outputs = [];
  await seed.main([], { createClient: fakeCreateClient(client), fetchTeamManagement, log: l => outputs.push(l), emit: l => outputs.push(l) });
  const joined = outputs.join('\n');
  assert.ok(!joined.includes(ENV.DEMO_PREP_ADMIN_PASSWORD));
  assert.ok(!/sb_secret_/i.test(joined));
});
