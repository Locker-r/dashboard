'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const verify = require('../scripts/staging-demo-flow-verify.cjs');

const ENV = Object.freeze({
  DEMO_PREP_PROJECT_URL: 'https://cjdxtakgmnzwixrajjry.supabase.co',
  DEMO_PREP_PUBLISHABLE_KEY: 'synthetic-publishable-key',
  DEMO_PREP_ADMIN_EMAIL: 'admin@example.invalid',
  DEMO_PREP_ADMIN_PASSWORD: 'synthetic-admin-password'
});

const RUN_ID = 'abc123def456fixedrun';

test('buildIdentities produces a SMOKE_TEST-shaped, self-cleaning disposable identity', () => {
  const identities = verify.buildIdentities(RUN_ID);
  assert.equal(identities.cashier.username, `smoke_test_${RUN_ID}_dv`);
  assert.match(identities.cashier.email, /^smoke_test_/);
  assert.equal(identities.playerId, `SMOKE_TEST_${RUN_ID}_demoverify`);
  assert.equal(identities.marker, `SMOKE_TEST:${RUN_ID}:demoverify`);
  assert.equal(identities.cleanupConfirmation, `DELETE_SMOKE_TEST_${RUN_ID}`);
});

// `scope` mirrors RLS: null means unrestricted (the admin session), a
// cashier id restricts `.in()` visibility to rows that cashier owns — the
// exact isolation the real players RLS policy enforces. Supports chained
// `.eq()` calls (the real query builder does too) and both a direct
// `await` (via `.then`) and the terminal `.single()`/`.maybeSingle()` forms.
function fakePlayers(store, scope = null) {
  function build(filters) {
    const rows = () => store.filter(r => (scope === null || r.agent_id === scope) && filters.every(([col, val]) => r[col] === val));
    return {
      eq: (col, val) => build([...filters, [col, val]]),
      in: (column, ids) => Promise.resolve({
        data: store.filter(r => ids.includes(r.id) && (scope === null || r.agent_id === scope)).map(r => ({ id: r.id })),
        error: null
      }),
      async single() {
        const row = rows()[0];
        return { data: row ? { id: row.id, status: row.status } : undefined, error: row ? null : { message: 'NOT_FOUND' } };
      },
      async maybeSingle() {
        const row = rows()[0];
        return { data: row ? { id: row.id, status: row.status } : null, error: null };
      },
      then(resolve) { resolve({ data: rows().map(row => ({ id: row.id, status: row.status })), error: null }); }
    };
  }
  return { select: () => build([]) };
}

// A separate, correctly-shaped fake for the lead_proofs table: rows carry
// `state`, not `status` — conflating the two with fakePlayers is exactly the
// kind of fixture bug that would silently prove nothing.
function fakeLeadProofs(proofs) {
  return {
    select: () => ({
      eq: (col1, val1) => ({
        eq: (col2, val2) => ({
          async maybeSingle() {
            const fields = { [col1]: val1, [col2]: val2 };
            const row = proofs.find(p => p.player_id === fields.player_id && p.state === fields.state);
            return { data: row || null, error: null };
          }
        })
      })
    })
  };
}

function fakeCashierClient(store, proofs, cashierId, revealOutcome = 'revealed') {
  const pendingProofPlayerId = new Map(); // proofId -> playerId, set at request time, consumed at confirm time.
  return {
    auth: {
      signInWithPassword: async () => ({ data: { session: { access_token: 'cashier-token' }, user: { id: cashierId } }, error: null }),
      signOut: async () => ({ error: null })
    },
    from: table => {
      if (table === 'players') return fakePlayers(store, cashierId);
      if (table === 'lead_proofs') return fakeLeadProofs(proofs);
      throw new Error(`unexpected table: ${table}`);
    },
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }) }) },
    rpc: async (name, params) => {
      if (name === 'change_player_status_atomic') {
        const row = store.find(r => r.id === params.p_player_id);
        if (row) row.status = params.p_next_status;
        return { data: null, error: null };
      }
      if (name === 'reveal_player_contacts') {
        // Mirrors supabase/migrations/20260802000200_contact_reveal_rpc.sql
        // exactly: the successful path returns outcome 'revealed', not
        // 'granted' (that string is only the internal audit event_type for
        // this same path, never the value returned to the caller).
        return { data: [{ player_id: params.p_player_id, outcome: revealOutcome, phone: '', email: '', messenger: '', revealed_at: new Date().toISOString(), request_id: params.p_request_id, access_event_id: 'evt' }], error: null };
      }
      if (name === 'request_lead_proof_upload') {
        pendingProofPlayerId.set(params.p_proof_id, params.p_player_id);
        return { data: { storage_path: 'lead-proofs/x.png' }, error: null };
      }
      if (name === 'confirm_lead_proof') {
        const playerId = pendingProofPlayerId.get(params.p_proof_id);
        proofs.push({ id: params.p_proof_id, player_id: playerId, state: 'active' });
        return { data: { state: 'active' }, error: null };
      }
      throw new Error(`unexpected rpc: ${name}`);
    }
  };
}

function fakeAdminClient(store, proofs) {
  return {
    auth: {
      signInWithPassword: async () => ({ data: { session: { access_token: 'admin-token' }, user: { id: 'admin-id' } }, error: null }),
      signOut: async () => ({ error: null })
    },
    from: table => {
      if (table === 'players') return fakePlayers(store);
      if (table === 'lead_proofs') return fakeLeadProofs(proofs);
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: async (name, params) => {
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
      if (name === 'cleanup_smoke_test_run_atomic') return { data: { deleted_players: 1 }, error: null };
      throw new Error(`unexpected admin rpc: ${name}`);
    }
  };
}

function makeDeps({ isolationLeaks = false, revealOutcome = 'revealed' } = {}) {
  const store = [{ id: 'demo_lead_01', status: 'new', agent_id: null }];
  const proofs = [];
  const adminClient = fakeAdminClient(store, proofs);
  const cashierId = 'cashier-verify-id';
  const cashierClient = fakeCashierClient(store, proofs, cashierId, revealOutcome);
  if (isolationLeaks) {
    // Simulate an RLS defect: the cashier can also see the negative-control lead.
    const originalFrom = cashierClient.from;
    cashierClient.from = table => {
      if (table === 'players') {
        return { select: () => ({ in: (column, ids) => Promise.resolve({ data: ids.map(id => ({ id })), error: null }) }) };
      }
      return originalFrom(table);
    };
  }

  const teamManagementCalls = [];
  let nextClient = adminClient;
  const createClient = () => { const c = nextClient; nextClient = cashierClient; return c; };
  const fetchTeamManagement = async (functionsUrl, token, body) => {
    teamManagementCalls.push(body);
    if (body.action === 'create-member') return { status: 200, body: { ok: true, data: { member: { id: cashierId, role: 'agent' } } } };
    if (body.action === 'list-members') return { status: 200, body: { ok: true, data: [{ id: cashierId, username: `smoke_test_${RUN_ID}_dv`, is_active: true }] } };
    if (body.action === 'set-member-active') return { status: 200, body: { ok: true, data: {} } };
    throw new Error(`unexpected action: ${body.action}`);
  };
  return { store, teamManagementCalls, deps: { createClient, fetchTeamManagement, buildRunId: () => RUN_ID, log() {}, emit() {} } };
}

test('missing configuration fails closed before any network call', async () => {
  const status = await verify.main([], {
    createClient: () => { throw new Error('must not be called'); },
    buildRunId: () => RUN_ID, log() {}, emit() {}
  });
  assert.equal(status, 1);
});

test('a full successful run walks every required step and cleans up the disposable identity', async () => {
  const { deps, teamManagementCalls } = makeDeps();
  process.env = { ...process.env, ...ENV };
  let emitted = null;
  const status = await verify.main(['--json'], { ...deps, emit: line => { emitted = line; } });
  assert.equal(status, 0, emitted);
  const result = JSON.parse(emitted);
  assert.equal(result.ok, true);
  for (const step of [
    'admin_login', 'cashier_created', 'lead_assigned', 'cashier_login',
    'assigned_lead_isolation_verified', 'in_work', 'contact_reveal_granted',
    'proof_uploaded_and_confirmed', 'closed_with_proof',
    'admin_final_result_and_proof_visible', 'analytics_source_confirmed'
  ]) {
    assert.ok(result.steps.includes(step), `missing step: ${step}`);
  }
  // Cleanup: the disposable cashier is deactivated via existing team-management action.
  assert.ok(teamManagementCalls.some(body => body.action === 'set-member-active' && body.isActive === false));
});

test('regression: only outcome "revealed" is accepted as a granted contact reveal, reproducing GitHub Actions run 31311284116', async () => {
  // reveal_player_contacts's successful path returns outcome 'revealed'
  // (supabase/migrations/20260802000200_contact_reveal_rpc.sql line 200);
  // 'granted' is only the internal contact_reveal_events audit event_type
  // for that path (line 195), never a value the RPC itself returns. A live
  // run failed with CONTACT_REVEAL_NOT_GRANTED:revealed because this script
  // checked for 'granted' instead.
  const { deps } = makeDeps({ revealOutcome: 'granted' });
  process.env = { ...process.env, ...ENV };
  const logs = [];
  const status = await verify.main([], { ...deps, log: line => logs.push(line) });
  assert.equal(status, 1);
  assert.ok(logs.some(line => line.includes('CONTACT_REVEAL_NOT_GRANTED:granted')));
});

test('an isolation leak (RLS defect) is refused, not silently reported as success', async () => {
  const { deps } = makeDeps({ isolationLeaks: true });
  process.env = { ...process.env, ...ENV };
  const logs = [];
  const status = await verify.main([], { ...deps, log: line => logs.push(line) });
  assert.equal(status, 1);
  assert.ok(logs.some(line => line.includes('ISOLATION_CHECK_FAILED')));
});

test('the disposable identity always uses the existing SMOKE_TEST_<runId> convention, never demo_*', () => {
  const identities = verify.buildIdentities(RUN_ID);
  assert.match(identities.cashier.username, /^smoke_test_/);
  assert.match(identities.playerId, /^SMOKE_TEST_/);
  assert.ok(!identities.cashier.username.startsWith('demo_'));
  assert.ok(!identities.playerId.startsWith('demo_'));
});

test('no secret value ever appears in log or emit output, even on failure', async () => {
  const { deps } = makeDeps({ isolationLeaks: true });
  process.env = { ...process.env, ...ENV };
  const outputs = [];
  await verify.main([], { ...deps, log: l => outputs.push(l), emit: l => outputs.push(l) });
  const joined = outputs.join('\n');
  assert.ok(!joined.includes(ENV.DEMO_PREP_ADMIN_PASSWORD));
  assert.ok(!/sb_secret_/i.test(joined));
});
