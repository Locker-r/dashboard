'use strict';
// Runtime verification for the Contact Reveal frontend integration (PR C).
//
// PR B's smoke proves the database contract. This one proves the code path the BROWSER actually runs:
// SupabaseDataService.revealPlayerContacts + ContactRevealStore + RevealRequestLedger, against a live local
// Supabase. It exists to catch the failure PR B cannot see -- a raw contact escaping the transient store
// into players[], the masked search text, the CSV export or the analytics label.
//
// The reveal flow below mirrors requestContactReveal() in index.html. It is a deliberate re-statement: the
// page's copy lives in an inline <script> and cannot be imported, so the invariant is verified against the
// same modules the page loads, driven by the same sequence.
const { createClient } = require('@supabase/supabase-js');
const { normalizeUrl, isLoopback, buildPlan } = require('./runtime-smoke.cjs');
const { SupabaseDataService } = require('../src/data/supabase-data-service.js');
const revealApi = require('../src/contact-reveal.js');
const randomId = () => require('node:crypto').randomUUID();

const RAW = Object.freeze({
  phone: '+59178889992',
  phoneDigits: '59178889992',
  emailLocal: 'uirevealprobe',
  messengerHandle: 'uirevealhandle'
});

const failures = [];
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return true; }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`); console.log(`  FAIL  ${name} :: ${detail || ''}`); return false;
}
// The core assertion of this harness: a raw contact must not appear in the given payload.
function noRaw(name, payload) {
  const text = JSON.stringify(payload == null ? null : payload);
  const hits = [];
  if (text.includes(RAW.phoneDigits)) hits.push('raw phone');
  if (text.includes(RAW.emailLocal)) hits.push('raw email local part');
  if (text.includes(RAW.messengerHandle)) hits.push('raw messenger handle');
  return check(name, hits.length === 0, hits.join(', '));
}

async function signIn(url, key, email, password) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const r = await client.auth.signInWithPassword({ email, password });
  if (r.error || !r.data.session) throw r.error || new Error('SIGN_IN_FAILED');
  return { client, user: r.data.user, data: new SupabaseDataService(client) };
}

// Counts reveal RPCs so "no RPC was sent" can be asserted rather than assumed.
function countingClient(client, counter) {
  const inner = client.rpc.bind(client);
  client.rpc = (name, parameters) => {
    if (name === 'reveal_player_contacts') counter.reveals += 1;
    return inner(name, parameters);
  };
  return client;
}

/* Mirrors index.html requestContactReveal(): guard, ledger, RPC, classify, store. Returns the outcome so
   each scenario can assert both the decision and what the store holds afterwards. */
async function revealFlow(session, context, playerId) {
  const player = context.players.find(item => item.id === playerId);
  if (!revealApi.canRequestContactReveal(context.user, player, 'supabase')) return 'not_eligible';
  if (context.cooldown.isActive()) return 'cooldown';
  const attempt = context.ledger.begin(playerId);
  if (!attempt.started) return 'in_flight';

  let row = null;
  try {
    row = await session.data.revealPlayerContacts(playerId, attempt.requestId);
  } catch (error) {
    if (error && error.code === revealApi.CONTRACT_VIOLATION) context.ledger.resolve(playerId);
    else context.ledger.fail(playerId); // transport failure: keep the id for an idempotent retry
    context.lastError = error;
    return 'transport_error';
  }

  const outcome = revealApi.classifyRevealOutcome(row);
  context.ledger.resolve(playerId);
  if (outcome === revealApi.REVEAL_OUTCOMES.REVEALED) {
    const revealedAt = Date.parse(row.revealedAt);
    context.store.put(playerId, {
      phone: row.phone, email: row.email, messenger: row.messenger,
      revealedAt: Number.isFinite(revealedAt) ? revealedAt : Date.now(),
      accessEventId: row.accessEventId
    });
  }
  if (outcome === revealApi.REVEAL_OUTCOMES.RATE_LIMITED) context.cooldown.start();
  context.lastRow = row;
  return outcome;
}

// The masked presentation paths from index.html, restated so this harness proves what a user would see.
const contactText = (player, field) => String(player[`${field}Display`] || '');
const csvRow = player => [contactText(player, 'phone'), contactText(player, 'email'), contactText(player, 'messenger')];
const searchText = player => `${contactText(player, 'phone')} ${contactText(player, 'email')} ${contactText(player, 'messenger')}`.toLowerCase();
const analyticsLabel = player => contactText(player, 'phone') || contactText(player, 'email') || contactText(player, 'messenger') || player.id || '-';

async function main() {
  const url = normalizeUrl(process.env.SMOKE_TEST_PROJECT_URL);
  const key = process.env.SMOKE_TEST_PUBLISHABLE_KEY;
  const runId = process.argv[2];
  const plan = buildPlan(runId);
  if (!isLoopback(url) || !key) throw new Error('LOCAL_REVEAL_UI_SMOKE_CONFIG_REQUIRED');

  const admin = await signIn(url, key, process.env.SMOKE_TEST_ADMIN_EMAIL, process.env.SMOKE_TEST_ADMIN_PASSWORD);
  const agentA = await signIn(url, key, process.env.SMOKE_TEST_AGENT_A_EMAIL, process.env.SMOKE_TEST_AGENT_A_PASSWORD);
  const playerId = plan.assignedPlayerId;
  const otherId = plan.otherPlayerId;

  const counter = { reveals: 0 };
  countingClient(agentA.client, counter);
  countingClient(admin.client, counter);

  const agentContext = {
    user: null, players: [],
    store: new revealApi.ContactRevealStore({ ttlMs: revealApi.REVEAL_TTL_MS }),
    ledger: new revealApi.RevealRequestLedger({ randomSource: require('node:crypto').webcrypto }),
    cooldown: new revealApi.RevealCooldown({ durationMs: revealApi.RATE_LIMIT_COOLDOWN_MS })
  };

  try {
    // Repeated harness runs would otherwise exhaust the shipped per-hour quota and mask real failures.
    const headroom = await admin.client.rpc('set_contact_reveal_limits', { p_per_minute: 1000, p_per_hour: 10000 });
    if (headroom.error) throw headroom.error;

    let r = await admin.client.rpc('create_players_atomic', { p_players: [
      { id: playerId, phone: RAW.phone, email: `${RAW.emailLocal}@example.invalid`, messenger: `${plan.markerPrefix}:${RAW.messengerHandle}`, imported_at: null },
      { id: otherId, phone: '+59177770002', email: `other_${runId}@example.invalid`, messenger: `${plan.markerPrefix}:other`, imported_at: null }
    ] });
    if (r.error) throw r.error;
    r = await admin.client.rpc('assign_players_atomic', { p_player_ids: [playerId, otherId], p_agent_ids: [agentA.user.id], p_confirm_final: false });
    if (r.error) throw r.error;

    agentContext.user = await agentA.data.getCurrentUser();
    agentContext.players = await agentA.data.loadPlayers();

    console.log('\n[1] the masked list the browser loads carries no raw contact');
    noRaw('loadPlayers() payload is masked', agentContext.players);
    const target = agentContext.players.find(p => p.id === playerId);
    check('player is visible to its agent', Boolean(target), 'player missing from the agent projection');
    check('assigned player is not yet eligible', target.contactAccessState === 'locked', target && target.contactAccessState);
    check('eligibility predicate refuses a non-in_work player',
      revealApi.canRequestContactReveal(agentContext.user, target, 'supabase') === false);

    console.log('\n[4] a denied reveal leaves the store empty');
    let outcome = await revealFlow(agentA, agentContext, playerId);
    check('assigned player is not offered reveal at all', outcome === 'not_eligible', outcome);
    check('no RPC was issued for an ineligible player', counter.reveals === 0, `${counter.reveals} calls`);
    // Force the server-side denial path explicitly, bypassing the client guard the way a tampered page would.
    const forcedDenial = await agentA.data.revealPlayerContacts(playerId, randomId());
    check('server denies a non-in_work reveal', forcedDenial.outcome === 'denied', forcedDenial.outcome);
    check('denial carries no contact value',
      forcedDenial.phone === '' && forcedDenial.email === '' && forcedDenial.messenger === '', JSON.stringify(forcedDenial));
    check('store is still empty after a denial', agentContext.store.size() === 0, `${agentContext.store.size()} entries`);
    noRaw('denial response has no raw contact', forcedDenial);

    console.log('\n[1] eligible agent reveal succeeds through the browser code path');
    r = await agentA.client.rpc('change_player_status_atomic', { p_player_id: playerId, p_next_status: 'in_work', p_history_id: `${plan.prefix}uirh1`, p_confirm_reopen: false });
    if (r.error) throw r.error;
    agentContext.players = await agentA.data.loadPlayers();
    agentContext.store.revalidate(agentContext.players, agentContext.user);
    const eligible = agentContext.players.find(p => p.id === playerId);
    check('projection reports eligible once in_work', eligible.contactAccessState === 'eligible', eligible.contactAccessState);
    check('eligibility predicate now allows reveal',
      revealApi.canRequestContactReveal(agentContext.user, eligible, 'supabase') === true);
    const before = counter.reveals;
    outcome = await revealFlow(agentA, agentContext, playerId);
    check('reveal succeeds', outcome === 'revealed', `${outcome} ${JSON.stringify(agentContext.lastRow)}`);
    check('exactly one reveal RPC was issued', counter.reveals === before + 1, `${counter.reveals - before} calls`);

    console.log('\n[2] raw values entered only the transient store');
    const entry = agentContext.store.get(playerId);
    check('store holds the raw phone', Boolean(entry) && entry.phone === RAW.phone, entry && entry.phone);
    check('store holds the raw email', Boolean(entry) && entry.email.startsWith(RAW.emailLocal));
    check('store holds the raw messenger', Boolean(entry) && entry.messenger.includes(RAW.messengerHandle));
    check('store stamps the approved five-minute TTL',
      Boolean(entry) && entry.expiresAt - entry.revealedAt === revealApi.REVEAL_TTL_MS, entry && String(entry.expiresAt - entry.revealedAt));
    check('store records the audit event id', Boolean(entry) && entry.accessEventId.length > 0);

    console.log('\n[3] players[] serialization contains no raw contact');
    noRaw('players[] after a successful reveal', agentContext.players);
    const revealedPlayer = agentContext.players.find(p => p.id === playerId);
    check('no raw contact key was added to the player object',
      !('phone' in revealedPlayer) && !('email' in revealedPlayer) && !('messenger' in revealedPlayer),
      Object.keys(revealedPlayer).join(','));
    check('masked display values are unchanged by the reveal',
      revealedPlayer.phoneDisplay === eligible.phoneDisplay, `${eligible.phoneDisplay} -> ${revealedPlayer.phoneDisplay}`);

    console.log('\n[8] search, CSV and analytics remain masked while a reveal is live');
    check('a reveal is live for this assertion', agentContext.store.has(playerId));
    noRaw('CSV export rows', agentContext.players.map(csvRow));
    noRaw('search index text', agentContext.players.map(searchText));
    noRaw('analytics contact labels', agentContext.players.map(analyticsLabel));
    check('search cannot find the revealed phone',
      agentContext.players.every(p => !searchText(p).includes(RAW.phoneDigits)));
    check('analytics label is the masked value, not the bare id',
      analyticsLabel(revealedPlayer) !== revealedPlayer.id, analyticsLabel(revealedPlayer));

    console.log('\n[7] a lost response is retried with the same request_id and yields one canonical decision');
    const retryPlayer = otherId;
    r = await agentA.client.rpc('change_player_status_atomic', { p_player_id: retryPlayer, p_next_status: 'in_work', p_history_id: `${plan.prefix}uirh2`, p_confirm_reopen: false });
    if (r.error) throw r.error;
    agentContext.players = await agentA.data.loadPlayers();
    // The call reaches the database and commits; only the response is lost, exactly as a dropped connection
    // would appear to the page.
    const realRpc = agentA.client.rpc.bind(agentA.client);
    let dropped = null;
    agentA.client.rpc = async (name, parameters) => {
      if (name === 'reveal_player_contacts' && !dropped) {
        dropped = parameters.p_request_id;
        counter.reveals += 1;
        await realRpc(name, parameters);
        throw Object.assign(new Error('Network request failed'), { code: 'TRANSPORT' });
      }
      return realRpc(name, parameters);
    };
    outcome = await revealFlow(agentA, agentContext, retryPlayer);
    check('a dropped response surfaces as a transport error', outcome === 'transport_error', outcome);
    check('the request_id is retained for retry', agentContext.ledger.retryableId(retryPlayer) === dropped,
      `${agentContext.ledger.retryableId(retryPlayer)} vs ${dropped}`);
    check('store is empty after a transport failure', agentContext.store.get(retryPlayer) === null);
    outcome = await revealFlow(agentA, agentContext, retryPlayer);
    check('the retry succeeds', outcome === 'revealed', `${outcome} ${JSON.stringify(agentContext.lastRow)}`);
    check('the retry reused the same request_id', agentContext.lastRow.requestId === dropped,
      `${agentContext.lastRow.requestId} vs ${dropped}`);
    const retryEvents = await admin.client.from('contact_reveal_events').select('event_type').eq('request_id', dropped);
    if (retryEvents.error) throw retryEvents.error;
    const canonical = retryEvents.data.filter(e => e.event_type === 'reveal_succeeded' || e.event_type === 'reveal_denied');
    check('exactly one canonical server decision for the retried request_id', canonical.length === 1,
      JSON.stringify(retryEvents.data.map(e => e.event_type)));
    check('the retry is recorded as a replay, not a second decision',
      retryEvents.data.some(e => e.event_type === 'replay_succeeded'), JSON.stringify(retryEvents.data.map(e => e.event_type)));
    check('the ledger consumed the id once the outcome arrived', agentContext.ledger.retryableId(retryPlayer) === null);

    console.log('\n[6] a status change out of in_work clears the store on revalidation');
    check('two reveals are live before the transition', agentContext.store.size() === 2, `${agentContext.store.size()}`);
    r = await agentA.client.rpc('change_player_status_atomic', { p_player_id: playerId, p_next_status: 'no_answer', p_history_id: `${plan.prefix}uirh3`, p_confirm_reopen: false });
    if (r.error) throw r.error;
    agentContext.players = await agentA.data.loadPlayers();
    const droppedIds = agentContext.store.revalidate(agentContext.players, agentContext.user);
    check('revalidation dropped exactly the transitioned player', droppedIds.length === 1 && droppedIds[0] === playerId, JSON.stringify(droppedIds));
    check('the transitioned player has no store entry', agentContext.store.get(playerId) === null);
    check('the still-in_work player keeps its entry', agentContext.store.get(retryPlayer) !== null);
    check('the server also refuses a fresh reveal now',
      (await agentA.data.revealPlayerContacts(playerId, randomId())).outcome === 'denied');
    check('clearAll empties the store on logout', agentContext.store.clearAll() === 1 && agentContext.store.size() === 0);

    console.log('\n[5] an admin is refused by the predicate and sends no reveal RPC');
    const adminUser = await admin.data.getCurrentUser();
    const adminPlayers = await admin.data.loadPlayers();
    noRaw('admin projection is masked too', adminPlayers);
    const adminEligible = adminPlayers.filter(p => p.contactAccessState === 'eligible');
    check('admin sees at least one row the projection calls eligible', adminEligible.length > 0, 'no eligible row to test with');
    check('admin is refused on every eligible row',
      adminEligible.every(p => revealApi.canRequestContactReveal(adminUser, p, 'supabase') === false));
    const adminContext = {
      user: adminUser, players: adminPlayers,
      store: new revealApi.ContactRevealStore({}),
      ledger: new revealApi.RevealRequestLedger({ randomSource: require('node:crypto').webcrypto }),
      cooldown: new revealApi.RevealCooldown({})
    };
    const adminBefore = counter.reveals;
    for (const p of adminEligible) {
      const adminOutcome = await revealFlow(admin, adminContext, p.id);
      check(`admin flow refuses ${p.id} without an RPC`, adminOutcome === 'not_eligible', adminOutcome);
    }
    check('no reveal RPC was sent for any admin attempt', counter.reveals === adminBefore, `${counter.reveals - adminBefore} calls`);
    check('admin store stayed empty', adminContext.store.size() === 0);
    check('admin ledger minted no request id', adminContext.ledger.size() === 0);
  } finally {
    await admin.client.rpc('set_contact_reveal_limits', { p_per_minute: 15, p_per_hour: 150 });
    const cleanup = await admin.client.rpc('cleanup_smoke_test_run_atomic', { p_run_id: plan.runId, p_confirmation: plan.cleanupConfirmation });
    if (cleanup.error) console.log(`  WARN  cleanup: ${cleanup.error.message}`);
    await Promise.allSettled([admin, agentA].map(s => s.client.auth.signOut({ scope: 'local' })));
  }

  if (failures.length) { console.error(`\nContact reveal UI FAILED (${failures.length}):\n- ${failures.join('\n- ')}`); process.exitCode = 1; }
  else console.log('\nContact reveal frontend runtime verification passed.');
}

if (require.main === module) main().catch(error => {
  console.error(`Contact reveal UI smoke failed: ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
