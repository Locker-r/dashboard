'use strict';
// Runtime security verification for the Secure Contact Boundary (PR A).
// Proves at runtime, against a live local stack, that stored contacts never reach an authenticated caller
// through PostgREST, GraphQL, the secure projection or any ordinary RPC response, for agents and admins alike.
const { createClient } = require('@supabase/supabase-js');
const { normalizeUrl, isLoopback, buildPlan } = require('./runtime-smoke.cjs');
const randomId = () => require('node:crypto').randomUUID();

// Distinctive synthetic values. Every assertion checks these never appear in any response payload.
const RAW = Object.freeze({ phone: '+59171234567', phoneDigits: '59171234567', emailLocal: 'johnqcontact' });
const MASK = Object.freeze({ phone: '*******4567', email: 'j***@' });

const failures = [];
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return true; }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`); console.log(`  FAIL  ${name} :: ${detail || ''}`); return false;
}
function noRawContacts(name, payload) {
  const text = JSON.stringify(payload == null ? null : payload);
  const hits = [];
  if (text.includes(RAW.phoneDigits)) hits.push('raw phone digits');
  if (text.includes(RAW.emailLocal)) hits.push('raw email local part');
  if (/"(phone|email|messenger)"\s*:/.test(text)) hits.push('raw contact key present');
  return check(name, hits.length === 0, hits.join(', '));
}

async function signIn(url, key, email, password) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error || !result.data.session) throw result.error || new Error('SIGN_IN_FAILED');
  return { client, user: result.data.user, token: result.data.session.access_token };
}

async function main() {
  const url = normalizeUrl(process.env.SMOKE_TEST_PROJECT_URL);
  const key = process.env.SMOKE_TEST_PUBLISHABLE_KEY;
  const runId = process.argv[2];
  const plan = buildPlan(runId);
  if (!isLoopback(url) || !key) throw new Error('LOCAL_SECURITY_SMOKE_CONFIG_REQUIRED');

  const admin = await signIn(url, key, process.env.SMOKE_TEST_ADMIN_EMAIL, process.env.SMOKE_TEST_ADMIN_PASSWORD);
  const agentA = await signIn(url, key, process.env.SMOKE_TEST_AGENT_A_EMAIL, process.env.SMOKE_TEST_AGENT_A_PASSWORD);
  const agentB = await signIn(url, key, process.env.SMOKE_TEST_AGENT_B_EMAIL, process.env.SMOKE_TEST_AGENT_B_PASSWORD);
  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const playerId = plan.assignedPlayerId;
  const columns = 'id,status,agent_id,imported_at,updated_at,follow_up_at,phone_display,email_display,messenger_display,has_phone,has_email,has_messenger,contact_access_state';

  try {
    // Seed one assigned player carrying the distinctive raw contacts.
    const created = await admin.client.rpc('create_players_atomic', { p_players: [{
      id: playerId, phone: RAW.phone, email: `${RAW.emailLocal}@example.invalid`,
      messenger: `${plan.markerPrefix}:secure`, imported_at: null }] });
    if (created.error) throw created.error;
    noRawContacts('create_players_atomic response carries no raw contacts', created.data);

    const assigned = await admin.client.rpc('assign_players_atomic', { p_player_ids: [playerId], p_agent_ids: [agentA.user.id], p_confirm_final: false });
    if (assigned.error) throw assigned.error;
    noRawContacts('assign_players_atomic response carries no raw contacts', assigned.data);

    console.log('\n[1] assigned agent, status assigned');
    let row = await agentA.client.from('players_secure').select(columns).eq('id', playerId).single();
    if (row.error) throw row.error;
    check('agent receives the assigned row', row.data && row.data.id === playerId);
    check('phone is masked to trailing digits', row.data.phone_display === MASK.phone, `got ${row.data.phone_display}`);
    check('email exposes only first local character', String(row.data.email_display || '').startsWith(MASK.email), `got ${row.data.email_display}`);
    check('messenger is masked', !String(row.data.messenger_display || '').includes(plan.runId), `got ${row.data.messenger_display}`);
    check('has_phone reported', row.data.has_phone === true);
    check('contact_access_state is locked before in_work', row.data.contact_access_state === 'locked', `got ${row.data.contact_access_state}`);
    noRawContacts('agent projection row carries no raw contacts', row.data);

    console.log('\n[2] same agent after transition to in_work');
    const toWork = await agentA.client.rpc('change_player_status_atomic', { p_player_id: playerId, p_next_status: 'in_work', p_history_id: `${plan.prefix}h1`, p_confirm_reopen: false });
    if (toWork.error) throw toWork.error;
    noRawContacts('change_player_status_atomic response carries no raw contacts', toWork.data);
    row = await agentA.client.from('players_secure').select(columns).eq('id', playerId).single();
    if (row.error) throw row.error;
    check('in_work still returns a masked phone', row.data.phone_display === MASK.phone, `got ${row.data.phone_display}`);
    check('in_work marks eligibility only', row.data.contact_access_state === 'eligible', `got ${row.data.contact_access_state}`);
    noRawContacts('in_work projection row carries no raw contacts', row.data);

    const followUp = await agentA.client.rpc('set_player_follow_up_atomic', { p_player_id: playerId, p_follow_up_at: plan.followUpAt });
    if (followUp.error) throw followUp.error;
    noRawContacts('set_player_follow_up_atomic response carries no raw contacts', followUp.data);

    console.log('\n[3] unrelated agent');
    const unrelated = await agentB.client.from('players_secure').select(columns).eq('id', playerId);
    check('unrelated agent receives zero rows', !unrelated.error && Array.isArray(unrelated.data) && unrelated.data.length === 0,
      unrelated.error ? unrelated.error.message : `rows=${unrelated.data && unrelated.data.length}`);

    console.log('\n[4] anonymous caller');
    const anonRows = await anon.from('players_secure').select(columns).eq('id', playerId);
    check('anonymous receives no rows', Boolean(anonRows.error) || (anonRows.data || []).length === 0,
      anonRows.error ? `denied: ${anonRows.error.code || anonRows.error.message}` : `rows=${(anonRows.data || []).length}`);

    console.log('\n[5] admin list');
    const adminRow = await admin.client.from('players_secure').select(columns).eq('id', playerId).single();
    if (adminRow.error) throw adminRow.error;
    check('admin phone is masked too', adminRow.data.phone_display === MASK.phone, `got ${adminRow.data.phone_display}`);
    noRawContacts('admin projection row carries no raw contacts', adminRow.data);

    console.log('\n[6] direct PostgREST raw contact columns');
    for (const column of ['phone', 'email', 'messenger']) {
      for (const [label, session] of [['agent', agentA], ['admin', admin]]) {
        const denied = await session.client.from('players').select(column).limit(1);
        check(`${label} PostgREST select ${column} denied`, Boolean(denied.error), denied.error ? '' : `returned ${JSON.stringify(denied.data)}`);
      }
    }
    const safe = await agentA.client.from('players').select('id,status,agent_id').eq('id', playerId);
    check('non-contact columns still readable through RLS', !safe.error, safe.error && safe.error.message);

    console.log('\n[7] GraphQL');
    const gql = await fetch(`${url}/graphql/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${agentA.token}` },
      body: JSON.stringify({ query: '{ playersCollection { edges { node { phone email messenger } } } }' }),
    });
    const gqlBody = await gql.json();
    const gqlText = JSON.stringify(gqlBody);
    check('GraphQL raw contact query denied or field absent',
      Boolean(gqlBody.errors) || !gqlText.includes(RAW.phoneDigits),
      gqlText.slice(0, 160));
    noRawContacts('GraphQL response carries no raw contacts', gqlBody);

    console.log('\n[8] duplicate detection contract');
    const dup = await admin.client.rpc('check_player_duplicates', { p_candidates: [
      { id: 'no-such-id', phone: RAW.phone }, { phone: '+10000000000', email: 'fresh@example.invalid' } ] });
    if (dup.error) throw dup.error;
    check('admin duplicate check runs', Array.isArray(dup.data) && dup.data.length === 2, JSON.stringify(dup.data));
    check('known contact reported duplicate', dup.data[0].duplicate === true && dup.data[0].matched_player_id === playerId, JSON.stringify(dup.data[0]));
    check('matched_fields names the matching channel', (dup.data[0].matched_fields || []).includes('phone'), JSON.stringify(dup.data[0].matched_fields));
    check('unknown contact reported clean', dup.data[1].duplicate === false, JSON.stringify(dup.data[1]));
    noRawContacts('duplicate response carries no raw contacts', dup.data);

    const agentDup = await agentA.client.rpc('check_player_duplicates', { p_candidates: [{ phone: RAW.phone }] });
    check('agent cannot execute duplicate check', Boolean(agentDup.error), agentDup.error ? '' : JSON.stringify(agentDup.data));
    const anonDup = await anon.rpc('check_player_duplicates', { p_candidates: [{ phone: RAW.phone }] });
    check('anonymous cannot execute duplicate check', Boolean(anonDup.error), anonDup.error ? '' : JSON.stringify(anonDup.data));
    const malformed = await admin.client.rpc('check_player_duplicates', { p_candidates: { not: 'an array' } });
    check('malformed input fails safely', Boolean(malformed.error), malformed.error ? '' : JSON.stringify(malformed.data));
  } finally {
    const cleanup = await admin.client.rpc('cleanup_smoke_test_run_atomic', { p_run_id: plan.runId, p_confirmation: plan.cleanupConfirmation });
    if (cleanup.error) console.log(`  WARN  cleanup failed: ${cleanup.error.message}`);
    await Promise.allSettled([admin, agentA, agentB].map(s => s.client.auth.signOut({ scope: 'local' })));
  }

  if (failures.length) { console.error(`\nSecure contact boundary FAILED (${failures.length}):\n- ${failures.join('\n- ')}`); process.exitCode = 1; }
  else console.log('\nSecure contact boundary runtime verification passed.');
}

if (require.main === module) main().catch(error => {
  console.error(`Secure contact boundary smoke failed: ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
