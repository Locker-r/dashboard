const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reveal = require('../src/contact-reveal.js');
const contract = require('../src/data/data-service.js');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const page = read('index.html');
const moduleSource = read('src/contact-reveal.js');

const RAW = Object.freeze({ phone: '+59178889991', email: 'lead@example.invalid', messenger: '@leadhandle' });

function agent(overrides) { return Object.assign({ id: 'agent-1', role: 'agent', isActive: true }, overrides || {}); }
function player(overrides) {
  return Object.assign({ id: 'player-1', agentId: 'agent-1', status: 'in_work', contactAccessState: 'eligible' }, overrides || {});
}
function fixedRandom(byte) {
  return { getRandomValues(target) { target.fill(byte); return target; } };
}
// Deterministic clock so TTL behaviour is asserted directly instead of being timing-dependent.
function clock(start) {
  const state = { value: start };
  return { now: () => state.value, advance(ms) { state.value += ms; } };
}
function storeAt(time, options) {
  const time0 = clock(time);
  const store = new reveal.ContactRevealStore(Object.assign({ now: time0.now }, options || {}));
  return { store, time: time0 };
}
function revealedRow(overrides) {
  return Object.assign({ playerId: 'player-1', outcome: 'revealed', phone: RAW.phone, email: RAW.email,
    messenger: RAW.messenger, revealedAt: '2026-08-01T10:00:00Z', requestId: 'r', accessEventId: 'e' }, overrides || {});
}

/* Strips comments and string bodies so a "this API is never reached" assertion inspects executable code
   only. Without it, a comment explaining why an API is avoided would itself fail the check -- and, worse, a
   real call could be hidden from a reviewer by an assertion that only ever matched prose. */
function executableCode(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (two === '/*') { const end = source.indexOf('*/', index + 2); index = end === -1 ? source.length : end + 2; continue; }
    const character = source[index];
    if (character === "'" || character === '"' || character === '`') {
      output += character;
      index += 1;
      while (index < source.length && source[index] !== character) {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
      output += character;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/* Slices a top-level function body out of index.html by brace balancing, so a structural assertion targets
   exactly that function and cannot be satisfied by an unrelated part of the page. */
function sliceFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found in index.html`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `${marker} has no body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') { depth -= 1; if (depth === 0) return source.slice(start, index + 1); }
  }
  throw new Error(`unbalanced body for ${marker}`);
}

/* ==================== uuidV4 ==================== */

test('uuidV4 produces an RFC-4122 v4 shape with the correct version and variant nibbles', () => {
  const value = reveal.uuidV4(fixedRandom(0xff));
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(value[14], '4', 'version nibble must be 4');
  assert.ok(['8', '9', 'a', 'b'].includes(value[19]), `variant nibble must be 8|9|a|b, got ${value[19]}`);
  // All-zero entropy must still carry the version and variant bits.
  const zeroed = reveal.uuidV4(fixedRandom(0x00));
  assert.equal(zeroed, '00000000-0000-4000-8000-000000000000');
  assert.equal(reveal.uuidV4(fixedRandom(0xff)), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('uuidV4 uses getRandomValues and refuses to invent randomness', () => {
  let calls = 0;
  reveal.uuidV4({ getRandomValues(target) { calls += 1; return target; } });
  assert.equal(calls, 1);
  assert.throws(() => reveal.uuidV4(null), /RANDOM_SOURCE_REQUIRED/);
  assert.throws(() => reveal.uuidV4({}), /RANDOM_SOURCE_REQUIRED/);
  // crypto.randomUUID needs a secure context and is absent over file://, so it must not be the source.
  assert.doesNotMatch(executableCode(moduleSource), /randomUUID/);
});

test('two consecutive uuids from real entropy differ', () => {
  const source = require('node:crypto').webcrypto;
  assert.notEqual(reveal.uuidV4(source), reveal.uuidV4(source));
});

/* ==================== eligibility ==================== */

test('eligibility truth table: every condition is necessary', () => {
  const cases = [
    ['all conditions hold', agent(), player(), 'supabase', true],
    ['admin is never offered reveal', agent({ role: 'admin' }), player({ agentId: 'agent-1' }), 'supabase', false],
    ['local mode has no reveal path', agent(), player(), 'local', false],
    ['player assigned to someone else', agent(), player({ agentId: 'agent-2' }), 'supabase', false],
    ['player not in_work', agent(), player({ status: 'assigned', contactAccessState: 'locked' }), 'supabase', false],
    ['projection reports locked', agent(), player({ contactAccessState: 'locked' }), 'supabase', false],
    ['deactivated agent', agent({ isActive: false }), player(), 'supabase', false],
    ['no session', null, player(), 'supabase', false],
    ['no player', agent(), null, 'supabase', false]
  ];
  for (const [name, user, target, mode, expected] of cases) {
    assert.equal(reveal.canRequestContactReveal(user, target, mode), expected, name);
  }
});

test('an admin viewing an eligible row is still refused, because contact_access_state is per row not per viewer', () => {
  const inWorkRow = player({ agentId: 'agent-9', contactAccessState: 'eligible' });
  assert.equal(inWorkRow.contactAccessState, 'eligible');
  assert.equal(reveal.canRequestContactReveal(agent({ id: 'admin-1', role: 'admin' }), inWorkRow, 'supabase'), false);
});

/* ==================== outcome classification ==================== */

test('classifyRevealOutcome maps each controlled outcome and never guesses', () => {
  assert.equal(reveal.classifyRevealOutcome(revealedRow()), 'revealed');
  assert.equal(reveal.classifyRevealOutcome({ outcome: 'denied' }), 'denied');
  assert.equal(reveal.classifyRevealOutcome({ outcome: 'rate_limited' }), 'rate_limited');
  assert.equal(reveal.classifyRevealOutcome({ outcome: 'request_id_conflict' }), 'request_id_conflict');
});

test('a malformed or empty response is never treated as a successful reveal', () => {
  for (const bad of [null, undefined, {}, [], 'revealed', { outcome: '' }, { outcome: 'REVEALED' }, { outcome: 'surprise' }]) {
    assert.equal(reveal.classifyRevealOutcome(bad), 'malformed', JSON.stringify(bad));
  }
  // outcome=revealed with no channel at all is off-contract, not an empty success.
  assert.equal(reveal.classifyRevealOutcome(revealedRow({ phone: '', email: '', messenger: '' })), 'malformed');
  // A single channel is a legitimate reveal.
  assert.equal(reveal.classifyRevealOutcome(revealedRow({ phone: '', messenger: '' })), 'revealed');
});

/* ==================== transient store ==================== */

test('store holds the approved shape and stamps expiry from the reveal time', () => {
  const { store } = storeAt(1000, { ttlMs: 5000 });
  const entry = store.put('player-1', { phone: RAW.phone, email: RAW.email, messenger: RAW.messenger, revealedAt: 1000, accessEventId: 'event-1' });
  assert.deepEqual(Object.keys(entry).sort(), ['accessEventId', 'email', 'expiresAt', 'messenger', 'phone', 'playerId', 'revealedAt'].sort());
  assert.equal(entry.expiresAt, 6000);
  assert.equal(store.get('player-1').phone, RAW.phone);
});

test('TTL default is the approved five minutes', () => {
  assert.equal(reveal.REVEAL_TTL_MS, 5 * 60 * 1000);
  assert.equal(reveal.RATE_LIMIT_COOLDOWN_MS, 60 * 1000);
  assert.equal(reveal.PRUNE_INTERVAL_MS, 15 * 1000);
});

test('lazy expiry in get() is authoritative even when no timer ever runs', () => {
  const { store, time } = storeAt(0, { ttlMs: 1000 });
  store.put('player-1', { phone: RAW.phone });
  time.advance(999);
  assert.equal(store.get('player-1').phone, RAW.phone);
  time.advance(1);
  assert.equal(store.get('player-1'), null, 'expired exactly at the boundary');
  assert.equal(store.size(), 0, 'the expired entry is dropped, not just hidden');
  assert.equal(store.has('player-1'), false);
});

test('remainingMs counts down and reports zero once gone', () => {
  const { store, time } = storeAt(0, { ttlMs: 1000 });
  store.put('player-1', { phone: RAW.phone });
  time.advance(400);
  assert.equal(store.remainingMs('player-1'), 600);
  time.advance(600);
  assert.equal(store.remainingMs('player-1'), 0);
});

test('prune drops only expired entries and reports which', () => {
  const { store, time } = storeAt(0, { ttlMs: 1000 });
  store.put('old', { phone: RAW.phone });
  time.advance(600);
  store.put('fresh', { phone: RAW.phone });
  time.advance(500);
  assert.deepEqual(store.prune(), ['old']);
  assert.equal(store.size(), 1);
  assert.deepEqual(store.prune(), []);
});

test('forget and clearAll remove the transient copy', () => {
  const { store } = storeAt(0);
  store.put('a', { phone: RAW.phone });
  store.put('b', { phone: RAW.phone });
  assert.equal(store.forget('a'), true);
  assert.equal(store.get('a'), null);
  assert.equal(store.clearAll(), 1);
  assert.equal(store.size(), 0);
});

test('revalidate drops an entry when the disclosure grounds disappear', () => {
  const cases = [
    ['player deleted', []],
    ['player reassigned', [player({ agentId: 'agent-2' })]],
    ['status left in_work', [player({ status: 'success' })]],
    ['status returned to assigned', [player({ status: 'assigned' })]]
  ];
  for (const [name, players] of cases) {
    const { store } = storeAt(0);
    store.put('player-1', { phone: RAW.phone });
    assert.deepEqual(store.revalidate(players, agent()), ['player-1'], name);
    assert.equal(store.size(), 0, name);
  }
  // Grounds intact: the entry survives.
  const { store } = storeAt(0);
  store.put('player-1', { phone: RAW.phone });
  assert.deepEqual(store.revalidate([player()], agent()), []);
  assert.equal(store.size(), 1);
});

test('revalidate clears everything when the actor is no longer an active agent', () => {
  for (const user of [null, agent({ role: 'admin' }), agent({ isActive: false }), agent({ id: '' })]) {
    const { store } = storeAt(0);
    store.put('player-1', { phone: RAW.phone });
    store.put('player-2', { phone: RAW.phone });
    assert.equal(store.revalidate([player(), player({ id: 'player-2' })], user).length, 2);
    assert.equal(store.size(), 0);
  }
});

test('revalidate also expires by TTL in the same pass', () => {
  const { store, time } = storeAt(0, { ttlMs: 1000 });
  store.put('player-1', { phone: RAW.phone });
  time.advance(1001);
  assert.deepEqual(store.revalidate([player()], agent()), ['player-1']);
});

test('a revealed value never reaches the players array that is persisted, exported and searched', () => {
  const { store } = storeAt(0);
  const players = [player()];
  store.put('player-1', { phone: RAW.phone, email: RAW.email, messenger: RAW.messenger });
  const serialized = JSON.stringify(players);
  for (const value of [RAW.phone, RAW.email, RAW.messenger, '59178889991']) {
    assert.equal(serialized.includes(value), false, `${value} must not appear in players[]`);
  }
  assert.equal('phone' in players[0], false);
  assert.equal(store.get('player-1').phone, RAW.phone, 'the value lives only in the store');
});

test('the module never reaches a persistence API', () => {
  const code = executableCode(moduleSource);
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|IDBDatabase/i);
  assert.doesNotMatch(code, /JSON\.stringify/);
  assert.doesNotMatch(code, /console\./);
  // Pure logic: the clock, the timers and the randomness are injected, never reached as globals. A member
  // call such as this.setInterval(...) is the injection point and is expected; a bare global call is not.
  assert.doesNotMatch(code, /(^|[^.\w])(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/m);
  assert.doesNotMatch(code, /(^|[^.\w])crypto\s*\./m);
  assert.match(code, /this\.setInterval\(/, 'the timer must call the injected scheduler');
  // Date.now() is permitted only as the injectable clock default, never inside business logic.
  const defaults = moduleSource.match(/typeof config\.now === 'function' \? config\.now : \(\) => Date\.now\(\)/g) || [];
  assert.equal(defaults.length, 2, 'ContactRevealStore and RevealCooldown each take an injectable clock');
  assert.equal((code.match(/Date\.now\(\)/g) || []).length, defaults.length,
    'Date.now() must appear only in the injected-clock default position');
});

/* ==================== request-id ledger ==================== */

test('one deliberate click mints exactly one request id', () => {
  const ledger = new reveal.RevealRequestLedger({ randomSource: require('node:crypto').webcrypto });
  const first = ledger.begin('player-1');
  assert.equal(first.started, true);
  assert.equal(first.retried, false);
  assert.match(first.requestId, /^[0-9a-f]{8}-/);
  assert.equal(ledger.isInFlight('player-1'), true);
});

test('additional clicks while in flight issue no RPC and mint no new id', () => {
  const ledger = new reveal.RevealRequestLedger({ newId: () => 'id-1' });
  const first = ledger.begin('player-1');
  const second = ledger.begin('player-1');
  const third = ledger.begin('player-1');
  assert.equal(first.started, true);
  assert.equal(second.started, false, 'a second click must not start a second request');
  assert.equal(third.started, false);
  assert.equal(second.requestId, first.requestId);
  assert.equal(ledger.size(), 1);
});

test('a structured outcome consumes the request id, so the next reveal mints a new one', () => {
  let counter = 0;
  const ledger = new reveal.RevealRequestLedger({ newId: () => `id-${++counter}` });
  const first = ledger.begin('player-1');
  ledger.resolve('player-1');
  assert.equal(ledger.size(), 0);
  assert.equal(ledger.retryableId('player-1'), null);
  const second = ledger.begin('player-1');
  // A denied request_id is permanently spent server-side (reason_code = prior_denial); reusing it would only
  // append a replay_denied event and could never succeed.
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(second.retried, false);
});

test('a transport failure retains the request id so the retry is idempotent', () => {
  let counter = 0;
  const ledger = new reveal.RevealRequestLedger({ newId: () => `id-${++counter}` });
  const first = ledger.begin('player-1');
  assert.equal(ledger.fail('player-1'), first.requestId);
  assert.equal(ledger.isInFlight('player-1'), false);
  assert.equal(ledger.retryableId('player-1'), first.requestId);
  const retry = ledger.begin('player-1');
  assert.equal(retry.requestId, first.requestId, 'the retry must replay the same canonical decision');
  assert.equal(retry.started, true);
  assert.equal(retry.retried, true);
  assert.equal(counter, 1, 'no new id was minted');
});

test('ledger ids are per player and clearAll drops them all', () => {
  let counter = 0;
  const ledger = new reveal.RevealRequestLedger({ newId: () => `id-${++counter}` });
  const a = ledger.begin('player-1');
  const b = ledger.begin('player-2');
  assert.notEqual(a.requestId, b.requestId);
  assert.equal(ledger.begin('').started, false);
  assert.equal(ledger.clearAll(), 2);
  assert.equal(ledger.size(), 0);
});

/* ==================== cooldown ==================== */

test('rate-limit cooldown blocks for the approved 60 seconds and then lapses', () => {
  const time = clock(0);
  const cooldown = new reveal.RevealCooldown({ now: time.now });
  assert.equal(cooldown.isActive(), false);
  cooldown.start();
  assert.equal(cooldown.isActive(), true);
  assert.equal(cooldown.remainingMs(), 60000);
  time.advance(59999);
  assert.equal(cooldown.isActive(), true);
  time.advance(1);
  assert.equal(cooldown.isActive(), false);
  assert.equal(cooldown.remainingMs(), 0);
});

test('cooldown clear releases immediately', () => {
  const time = clock(0);
  const cooldown = new reveal.RevealCooldown({ now: time.now, durationMs: 1000 });
  cooldown.start();
  cooldown.clear();
  assert.equal(cooldown.isActive(), false);
});

/* ==================== prune timer ==================== */

test('the prune timer is a singleton: repeated starts never accumulate intervals', () => {
  const calls = { set: 0, cleared: [] };
  let ticks = 0;
  const timer = new reveal.PruneTimer({
    setInterval: () => { calls.set += 1; return `handle-${calls.set}`; },
    clearInterval: handle => calls.cleared.push(handle),
    onTick: () => { ticks += 1; }
  });
  assert.equal(timer.start(), true);
  assert.equal(timer.start(), false, 're-render must not create a second interval');
  assert.equal(timer.start(), false);
  assert.equal(calls.set, 1);
  assert.equal(timer.isRunning(), true);
  assert.equal(ticks, 0);
});

test('the prune timer stops cleanly and can restart after teardown', () => {
  const calls = { set: 0, cleared: [] };
  const timer = new reveal.PruneTimer({
    setInterval: () => { calls.set += 1; return `handle-${calls.set}`; },
    clearInterval: handle => calls.cleared.push(handle)
  });
  timer.start();
  assert.equal(timer.stop(), true);
  assert.deepEqual(calls.cleared, ['handle-1']);
  assert.equal(timer.isRunning(), false);
  assert.equal(timer.stop(), false, 'stopping twice must be harmless');
  timer.start();
  assert.equal(calls.set, 2, 'a stopped timer can be restarted after re-authentication');
  assert.equal(timer.isRunning(), true);
});

test('the prune timer invokes the tick it was given, at the configured interval', () => {
  let scheduled = null;
  let intervalMs = 0;
  let ticks = 0;
  const timer = new reveal.PruneTimer({
    intervalMs: 15000,
    setInterval: (fn, ms) => { scheduled = fn; intervalMs = ms; return 'handle'; },
    clearInterval: () => {},
    onTick: () => { ticks += 1; }
  });
  timer.start();
  assert.equal(intervalMs, 15000);
  scheduled();
  scheduled();
  assert.equal(ticks, 2);
});

/* ==================== data-service contract ==================== */

test('the base data-service contract exposes reveal and refuses to implement it', async () => {
  const service = new contract.DataService();
  await assert.rejects(() => service.revealPlayerContacts('player-1', 'request-1'), /revealPlayerContacts\(\) is not implemented/);
});

test('the localStorage prototype inherits the refusal and grows no reveal path', async () => {
  const local = require('../src/data/local-storage-data-service.js');
  const service = new local.LocalStorageDataService({});
  await assert.rejects(() => service.revealPlayerContacts('player-1', 'request-1'), /revealPlayerContacts\(\) is not implemented/);
  assert.doesNotMatch(read('src/data/local-storage-data-service.js'), /reveal/i);
});

/* ==================== structural guarantees in index.html ==================== */

test('the page loads the reveal module and builds one store, ledger, cooldown and timer', () => {
  assert.match(page, /<script src="\.\/src\/contact-reveal\.js"><\/script>/);
  assert.equal((page.match(/new revealApi\.ContactRevealStore\(/g) || []).length, 1);
  assert.equal((page.match(/new revealApi\.RevealRequestLedger\(/g) || []).length, 1);
  assert.equal((page.match(/new revealApi\.PruneTimer\(/g) || []).length, 1);
});

test('no revealed value is ever assigned onto a player object', () => {
  const handler = sliceFunction(page, 'async function requestContactReveal(');
  assert.match(handler, /revealStore\.put\(/, 'the reveal must land in the store');
  assert.doesNotMatch(handler, /\b(player|p)\.(phone|email|messenger)\s*=[^=]/);
  assert.doesNotMatch(handler, /savePlayers|saveData\(|saveUsers\(/);
  assert.doesNotMatch(handler, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(handler, /console\./);
  // Nowhere on the page does a raw contact get written back onto a player.
  assert.doesNotMatch(page, /\b(player|p)\.(phone|email|messenger)\s*=[^=]/);
  // The raw columns of the reveal response are read exactly once each, and only to fill the store.
  for (const field of ['phone', 'email', 'messenger']) {
    assert.equal((handler.match(new RegExp(`row\\.${field}\\b`, 'g')) || []).length, 1, `row.${field}`);
  }
  const put = handler.slice(handler.indexOf('revealStore.put('), handler.indexOf('startRevealTimer()'));
  for (const field of ['phone', 'email', 'messenger']) assert.match(put, new RegExp(`row\\.${field}\\b`));
});

test('the reveal path performs no persistence of any kind', () => {
  for (const marker of ['async function requestContactReveal(', 'function hideRevealedContacts(', 'function clearRevealedContacts(', 'function onRevealPruneTick(']) {
    const body = sliceFunction(page, marker);
    assert.doesNotMatch(body, /localStorage|sessionStorage|indexedDB|IDBDatabase/i, marker);
  }
});

test('CSV export stays masked and never consults the reveal store', () => {
  const exportHandler = page.slice(page.indexOf("document.getElementById('exportBtn')"), page.indexOf('/* ==================== Render: distribute'));
  assert.match(exportHandler, /contactText\(p,'phone'\)/);
  assert.doesNotMatch(exportHandler, /revealStore|revealApi|revealed/);
});

test('worklist search stays masked and never consults the reveal store', () => {
  const filter = sliceFunction(page, 'function filteredWorklistPlayers(');
  assert.match(filter, /contactText\(p,'phone'\)/);
  assert.doesNotMatch(filter, /revealStore|revealApi|revealed/);
});

test('analytics stays masked, never consults the reveal store, and no longer degrades to bare ids', () => {
  const label = sliceFunction(page, 'function analyticsContactLabel(');
  assert.match(label, /contactText\(player,'phone'\)/);
  assert.doesNotMatch(label, /revealStore|revealApi/);
  // The pre-PR-A raw fallback is gone: player.phone has not existed on the player object since players_secure.
  assert.doesNotMatch(label, /player\.phone\s*\|\|/);
  const detail = sliceFunction(page, 'function renderAnalyticsDetail(');
  assert.doesNotMatch(detail, /revealStore|revealApi/);
});

test('the reveal control is rendered only behind canRequestContactReveal', () => {
  const control = sliceFunction(page, 'function revealControl(');
  assert.match(control, /if\(!canRevealPlayer\(player\)\) return '';/);
  const guard = sliceFunction(page, 'function canRevealPlayer(');
  assert.match(guard, /revealApi\.canRequestContactReveal\(currentUser, player, dataMode\)/);
  // The same guard opens the handler, so a synthesized click cannot bypass the rendering check.
  assert.match(sliceFunction(page, 'async function requestContactReveal('), /if\(!canRevealPlayer\(player\)\) return false;/);
  assert.equal((page.match(/class="btn btn-teal btn-sm reveal-show"/g) || []).length, 1, 'exactly one reveal button template');
});

test('the copy control carries the player id and channel name, never the contact value', () => {
  const cell = sliceFunction(page, 'function contactCell(');
  assert.match(cell, /data-copy-id="\$\{escapeHtml\(player\.id\)\}"/);
  assert.match(cell, /data-copy-field="\$\{escapeHtml\(field\)\}"/);
  assert.doesNotMatch(cell, /data-copy-value|data-phone|data-email|data-messenger/);
});

test('reveal is exposed on the worklist only, never from analytics, distribution, import or admin screens', () => {
  for (const marker of ['function renderAnalytics(', 'function renderDistribute(', 'function renderManualResults(', 'function renderAccessView(', 'function renderFileImportPreview(']) {
    assert.doesNotMatch(sliceFunction(page, marker), /reveal-show|requestContactReveal|revealControl|revealStore/, marker);
  }
});

test('a countdown node that outlives its store entry forces a re-render', () => {
  // Regression: lazy expiry in get() removes the entry as a side effect of reading it. When that read
  // happens outside a render, the later prune() finds nothing to drop, returns [], and skips the re-render
  // -- leaving raw contacts on screen after the store has forgotten them. Observed in the browser pass.
  const countdowns = sliceFunction(page, 'function updateRevealCountdowns(');
  assert.match(countdowns, /const stale = nodes\.some\(node => !revealStore\.get\(node\.dataset\.revealCountdown\)\);/);
  assert.match(countdowns, /if\(stale\)\{ showToast\(t\('reveal_expired'\)\); renderWorklist\(\); return; \}/);
  // The tick must still reach this backstop on the path where prune() reports nothing.
  const tick = sliceFunction(page, 'function onRevealPruneTick(');
  assert.match(tick, /else updateRevealCountdowns\(\);/);
});

test('every clearing hook is wired', () => {
  assert.match(sliceFunction(page, 'function showLogin('), /clearRevealedContacts\(\);/);
  assert.match(sliceFunction(page, 'async function logout('), /finally\{\s*clearRevealedContacts\(\);\s*\}/);
  assert.match(sliceFunction(page, 'async function loadData('), /revealStore\.revalidate\(players, currentUser\);/);
  assert.match(sliceFunction(page, 'async function requestPlayerStatusTransition('), /if\(nextStatus!=='in_work'\) revealStore\.forget\(playerId\);/);
  const teardown = sliceFunction(page, 'function clearRevealedContacts(');
  for (const call of [/revealStore\.clearAll\(\)/, /revealLedger\.clearAll\(\)/, /revealCooldown\.clear\(\)/, /stopRevealTimer\(\)/]) {
    assert.match(teardown, call);
  }
  // Regression: logout hides the app shell without clearing it, so the rendered row kept the raw values in
  // the document after the store was emptied. Observed in the browser pass.
  assert.match(teardown, /getElementById\('worklistTableWrap'\)/);
  assert.match(teardown, /wrap\.innerHTML = '';/);
});

test('the lock icon reflects what this viewer can actually unlock', () => {
  const worklist = sliceFunction(page, 'function renderWorklist(');
  assert.match(worklist, /const locked = dataMode==='supabase'\s*\n?\s*\? \(!revealed && !canRevealPlayer\(p\)\)/);
  // The offline prototype keeps its original heuristic untouched.
  assert.match(worklist, /: \(isMine && p\.status==='assigned'\);/);
  assert.match(sliceFunction(page, 'function lockedHintText('), /locked_hint_admin/);
});

/* ==================== i18n parity ==================== */

// Extracts the I18N object literal by brace balancing while skipping single-quoted strings, so an apostrophe
// or a brace inside a translation cannot break the scan.
function extractI18N(source) {
  const start = source.indexOf('const I18N = {');
  assert.notEqual(start, -1, 'I18N literal not found');
  const open = source.indexOf('{', start);
  let depth = 0;
  let quoted = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '\\') { index += 1; continue; }
      if (character === "'") quoted = false;
      continue;
    }
    if (character === "'") { quoted = true; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') { depth -= 1; if (depth === 0) return source.slice(open, index + 1); }
  }
  throw new Error('unbalanced I18N literal');
}

const REVEAL_KEYS = ['reveal_btn', 'reveal_hide_btn', 'reveal_loading', 'reveal_retry_btn', 'reveal_copy_btn',
  'reveal_shown', 'reveal_denied', 'reveal_rate_limited', 'reveal_conflict', 'reveal_error', 'reveal_expired',
  'reveal_expires_in', 'reveal_revealed_at', 'reveal_cooldown', 'locked_hint_admin'];

test('every locale defines every reveal string', () => {
  const translations = new Function(`return ${extractI18N(page)};`)();
  const locales = Object.keys(translations);
  assert.deepEqual(locales.sort(), ['en', 'es', 'ru']);
  for (const locale of locales) {
    for (const key of REVEAL_KEYS) {
      const value = translations[locale][key];
      assert.equal(typeof value, 'string', `${locale}.${key} must exist`);
      assert.ok(value.trim().length > 0, `${locale}.${key} must not be blank`);
    }
  }
});

test('no locale drifts: all three define exactly the same key set', () => {
  const translations = new Function(`return ${extractI18N(page)};`)();
  const reference = Object.keys(translations.ru).sort();
  for (const locale of ['en', 'es']) {
    assert.deepEqual(Object.keys(translations[locale]).sort(), reference, `${locale} key set must match ru`);
  }
});

test('translations are not accidental copies of each other', () => {
  const translations = new Function(`return ${extractI18N(page)};`)();
  for (const key of REVEAL_KEYS) {
    assert.notEqual(translations.ru[key], translations.en[key], `${key} must be translated into Russian`);
    assert.notEqual(translations.en[key], translations.es[key], `${key} must be translated into Spanish`);
  }
});
