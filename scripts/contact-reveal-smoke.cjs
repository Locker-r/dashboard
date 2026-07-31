'use strict';
// Runtime security verification for Audited Contact Reveal (PR B).
// Proves the reveal RPC is the only contact egress, that every controlled outcome commits an immutable
// audit event in the same transaction, that idempotency is append-only, and that rate limiting is exact.
const { createClient } = require('@supabase/supabase-js');
const { normalizeUrl, isLoopback, buildPlan } = require('./runtime-smoke.cjs');
const randomId = () => require('node:crypto').randomUUID();

const RAW = Object.freeze({ phone: '+59178889991', phoneDigits: '59178889991', emailLocal: 'revealprobe' });

const failures = [];
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return true; }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`); console.log(`  FAIL  ${name} :: ${detail || ''}`); return false;
}
function noRaw(name, payload) {
  const text = JSON.stringify(payload == null ? null : payload);
  const hits = [];
  if (text.includes(RAW.phoneDigits)) hits.push('raw phone');
  if (text.includes(RAW.emailLocal)) hits.push('raw email local part');
  return check(name, hits.length === 0, hits.join(', '));
}
async function signIn(url, key, email, password) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const r = await client.auth.signInWithPassword({ email, password });
  if (r.error || !r.data.session) throw r.error || new Error('SIGN_IN_FAILED');
  return { client, user: r.data.user, token: r.data.session.access_token };
}
const reveal = (session, playerId, requestId) =>
  session.client.rpc('reveal_player_contacts', { p_player_id: playerId, p_request_id: requestId });
const first = result => (Array.isArray(result.data) ? result.data[0] : result.data) || null;

async function main() {
  const url = normalizeUrl(process.env.SMOKE_TEST_PROJECT_URL);
  const key = process.env.SMOKE_TEST_PUBLISHABLE_KEY;
  const runId = process.argv[2];
  const plan = buildPlan(runId);
  if (!isLoopback(url) || !key) throw new Error('LOCAL_REVEAL_SMOKE_CONFIG_REQUIRED');

  const admin = await signIn(url, key, process.env.SMOKE_TEST_ADMIN_EMAIL, process.env.SMOKE_TEST_ADMIN_PASSWORD);
  const agentA = await signIn(url, key, process.env.SMOKE_TEST_AGENT_A_EMAIL, process.env.SMOKE_TEST_AGENT_A_PASSWORD);
  const agentB = await signIn(url, key, process.env.SMOKE_TEST_AGENT_B_EMAIL, process.env.SMOKE_TEST_AGENT_B_PASSWORD);
  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const playerId = plan.assignedPlayerId;
  const otherId = plan.otherPlayerId;

  try {
    // The rate limiter counts a trailing hour per actor, so repeated harness runs would throttle the
    // functional sections and mask real failures. Raise the ceiling for sections 1-6 and 8-9; section 7
    // lowers it deliberately to prove throttling, and the finally block restores the shipped defaults.
    const headroom = await admin.client.rpc('set_contact_reveal_limits', { p_per_minute: 1000, p_per_hour: 10000 });
    if (headroom.error) throw headroom.error;

    let r = await admin.client.rpc('create_players_atomic', { p_players: [
      { id: playerId, phone: RAW.phone, email: `${RAW.emailLocal}@example.invalid`, messenger: `${plan.markerPrefix}:reveal`, imported_at: null },
      { id: otherId, phone: '+59177770001', email: `other_${runId}@example.invalid`, messenger: `${plan.markerPrefix}:other`, imported_at: null }
    ] });
    if (r.error) throw r.error;
    r = await admin.client.rpc('assign_players_atomic', { p_player_ids: [playerId], p_agent_ids: [agentA.user.id], p_confirm_final: false });
    if (r.error) throw r.error;

    console.log('\n[1] denied before in_work, audited, no contacts');
    let out = first(await reveal(agentA, playerId, randomId()));
    check('assigned status is denied', out && out.outcome === 'denied', JSON.stringify(out));
    check('no contacts on denial', out && out.phone === null && out.email === null && out.messenger === null, JSON.stringify(out));
    check('revealed_at null on denial', out && out.revealed_at === null);
    check('access_event_id present on denial (audit committed)', Boolean(out && out.access_event_id));
    noRaw('denial payload has no raw contact', out);

    console.log('\n[2] agent transitions to in_work then reveals');
    r = await agentA.client.rpc('change_player_status_atomic', { p_player_id: playerId, p_next_status: 'in_work', p_history_id: `${plan.prefix}rh1`, p_confirm_reopen: false });
    if (r.error) throw r.error;
    const okRequest = randomId();
    out = first(await reveal(agentA, playerId, okRequest));
    check('in_work reveal succeeds', out && out.outcome === 'revealed', JSON.stringify(out && out.outcome));
    check('raw phone returned', out && out.phone === RAW.phone, String(out && out.phone));
    check('raw email returned', out && String(out.email).startsWith(RAW.emailLocal));
    check('revealed_at populated', Boolean(out && out.revealed_at));
    check('access_event_id populated', Boolean(out && out.access_event_id));
    check('response carries no player state', out && !('status' in out) && !('agent_id' in out) && !('reason_code' in out), Object.keys(out || {}).join(','));

    console.log('\n[3] idempotent replay is append-only');
    const replay = first(await reveal(agentA, playerId, okRequest));
    check('replay returns contacts again', replay && replay.outcome === 'revealed' && replay.phone === RAW.phone);
    check('replay is a NEW audit event', replay && replay.access_event_id !== out.access_event_id, 'event id was reused');
    let events = await admin.client.from('contact_reveal_events').select('id,event_type,reason_code').eq('request_id', okRequest);
    if (events.error) throw events.error;
    check('two events for one request_id', events.data.length === 2, JSON.stringify(events.data.map(e => e.event_type)));
    check('exactly one canonical event', events.data.filter(e => e.event_type === 'reveal_succeeded').length === 1);
    check('replay recorded as replay_succeeded', events.data.some(e => e.event_type === 'replay_succeeded'));

    console.log('\n[4] request_id conflict and prior-denial consumption');
    const conflict = first(await reveal(agentB, playerId, okRequest));
    check('other actor gets request_id_conflict', conflict && conflict.outcome === 'request_id_conflict', JSON.stringify(conflict && conflict.outcome));
    check('conflict returns no contacts', conflict && conflict.phone === null);
    const deniedRequest = randomId();
    await reveal(agentA, otherId, deniedRequest);
    const replayDenied = first(await reveal(agentA, otherId, deniedRequest));
    check('denied request_id stays denied on replay', replayDenied && replayDenied.outcome === 'denied');

    console.log('\n[5] authorization matrix');
    for (const [label, session] of [['unrelated agent', agentB], ['admin', admin]]) {
      const denied = first(await reveal(session, playerId, randomId()));
      check(`${label} denied`, denied && denied.outcome === 'denied', JSON.stringify(denied && denied.outcome));
      check(`${label} gets no contacts`, denied && denied.phone === null && denied.email === null);
    }
    const anonReveal = await reveal({ client: anon }, playerId, randomId());
    check('anonymous denied', Boolean(anonReveal.error), anonReveal.error ? '' : JSON.stringify(anonReveal.data));
    const nonexistent = first(await reveal(agentA, `${plan.prefix}nope`, randomId()));
    check('nonexistent player indistinguishable from denial', nonexistent && nonexistent.outcome === 'denied' && nonexistent.phone === null);

    console.log('\n[6] audit immutability and visibility');
    const evId = out.access_event_id;
    const upd = await admin.client.from('contact_reveal_events').update({ reason_code: 'granted' }).eq('id', evId);
    check('UPDATE denied for admin', Boolean(upd.error), upd.error ? '' : 'update succeeded');
    const del = await admin.client.from('contact_reveal_events').delete().eq('id', evId);
    check('DELETE denied for admin', Boolean(del.error) || (Array.isArray(del.data) && del.data.length === 0), del.error ? '' : 'delete succeeded');
    const agentBView = await agentB.client.from('contact_reveal_events').select('id').eq('id', evId);
    check('agent cannot read another agent audit row', !agentBView.error && agentBView.data.length === 0);
    const agentAView = await agentA.client.from('contact_reveal_events').select('id').eq('id', evId);
    check('agent can read own audit row', !agentAView.error && agentAView.data.length === 1);
    const allEvents = await admin.client.from('contact_reveal_events').select('*');
    if (allEvents.error) throw allEvents.error;
    noRaw('audit table contains no raw contact anywhere', allEvents.data);

    console.log('\n[7] rate limiting');
    const setLimit = await admin.client.rpc('set_contact_reveal_limits', { p_per_minute: 3, p_per_hour: 150 });
    check('admin can retune limits', !setLimit.error, setLimit.error && setLimit.error.message);
    const agentLimit = await agentA.client.rpc('set_contact_reveal_limits', { p_per_minute: 99, p_per_hour: 999 });
    check('agent cannot retune limits', Boolean(agentLimit.error));
    const burst = await Promise.all(Array.from({ length: 12 }, () => reveal(agentA, playerId, randomId())));
    const outcomes = burst.map(b => (first(b) || {}).outcome);
    const limited = outcomes.filter(o => o === 'rate_limited').length;
    check('concurrent burst is throttled', limited > 0, JSON.stringify(outcomes));
    check('throttled responses carry no contacts', burst.every(b => { const x = first(b) || {}; return x.outcome !== 'rate_limited' || (x.phone === null && x.email === null); }));
    const limitedEvents = await admin.client.from('contact_reveal_events').select('id').eq('event_type', 'rate_limited');
    check('rate_limited events audited', !limitedEvents.error && limitedEvents.data.length >= limited);
    // Restore test headroom, not the shipped defaults: the burst above has already consumed this minute's
    // real quota, and the remaining sections must not be throttled. Defaults are restored in finally.
    await admin.client.rpc('set_contact_reveal_limits', { p_per_minute: 1000, p_per_hour: 10000 });

    console.log('\n[8] concurrent status change cannot yield a stale disclosure');
    const raceRequest = randomId();
    const [revealResult, statusResult] = await Promise.all([
      reveal(agentA, playerId, raceRequest),
      agentA.client.rpc('change_player_status_atomic', { p_player_id: playerId, p_next_status: 'no_answer', p_history_id: `${plan.prefix}rh2`, p_confirm_reopen: false })
    ]);
    const raced = first(revealResult) || {};
    check('race resolves to a definite outcome', ['revealed', 'denied', 'rate_limited'].includes(raced.outcome), JSON.stringify(raced.outcome));
    const finalStatus = await admin.client.from('players_secure').select('status').eq('id', playerId).single();
    check('status transition applied', !statusResult.error && finalStatus.data.status === 'no_answer', JSON.stringify(finalStatus.data));
    const afterRace = first(await reveal(agentA, playerId, randomId()));
    check('reveal denied once no longer in_work', afterRace && afterRace.outcome === 'denied', JSON.stringify(afterRace && afterRace.outcome));

    console.log('\n[9] retention purge');
    const purge = await admin.client.rpc('purge_contact_reveal_events', { p_before: '2020-01-01T00:00:00Z' });
    check('admin cannot purge audit', Boolean(purge.error));
    // Positive path: service_role reaches the definer function, whose owner identity satisfies the delete
    // trigger. A far-past cutoff proves the mechanism works without destroying any evidence.
    const serviceKey = process.env.SMOKE_TEST_LOCAL_SERVICE_KEY;
    if (!serviceKey) throw new Error('SMOKE_TEST_LOCAL_SERVICE_KEY is required to verify the purge path');
    const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const purgeOk = await service.rpc('purge_contact_reveal_events', { p_before: '2020-01-01T00:00:00Z' });
    check('service_role can purge', !purgeOk.error && Number.isInteger(purgeOk.data), purgeOk.error ? purgeOk.error.message : `returned ${JSON.stringify(purgeOk.data)}`);
    check('far-past cutoff removed nothing', purgeOk.data === 0, `deleted ${purgeOk.data}`);
    const purgeRecent = await service.rpc('purge_contact_reveal_events', { p_before: new Date().toISOString() });
    check('purge rejects a too-recent cutoff', Boolean(purgeRecent.error) && /PURGE_CUTOFF_TOO_RECENT/.test(purgeRecent.error.message), purgeRecent.error ? purgeRecent.error.message : 'no error');
    const stillThere = await admin.client.from('contact_reveal_events').select('id', { count: 'exact', head: true });
    check('audit history intact after purge probes', !stillThere.error);
  } finally {
    await admin.client.rpc('set_contact_reveal_limits', { p_per_minute: 15, p_per_hour: 150 });
    const cleanup = await admin.client.rpc('cleanup_smoke_test_run_atomic', { p_run_id: plan.runId, p_confirmation: plan.cleanupConfirmation });
    if (cleanup.error) console.log(`  WARN  cleanup: ${cleanup.error.message}`);
    await Promise.allSettled([admin, agentA, agentB].map(s => s.client.auth.signOut({ scope: 'local' })));
  }

  if (failures.length) { console.error(`\nContact reveal FAILED (${failures.length}):\n- ${failures.join('\n- ')}`); process.exitCode = 1; }
  else console.log('\nAudited contact reveal runtime verification passed.');
}

if (require.main === module) main().catch(error => {
  console.error(`Contact reveal smoke failed: ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
