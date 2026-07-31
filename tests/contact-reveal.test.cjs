const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const auditSql = read('supabase/migrations/20260802000100_contact_reveal_audit.sql');
const rpcSql = read('supabase/migrations/20260802000200_contact_reveal_rpc.sql');
const rollbackAudit = read('supabase/rollback/20260802000100_contact_reveal_audit_rollback.sql');
const rollbackRpc = read('supabase/rollback/20260802000200_contact_reveal_rpc_rollback.sql');

test('reveal migrations are transactional and additive', () => {
  for (const sql of [auditSql, rpcSql]) { assert.match(sql, /begin;/i); assert.match(sql, /commit;\s*$/i); }
  // PR A objects must not be touched.
  for (const sql of [auditSql, rpcSql]) {
    assert.doesNotMatch(sql, /drop\s+view|alter\s+view|create\s+or\s+replace\s+view/i);
    assert.doesNotMatch(sql, /players_secure|can_read_player|mask_contact_|check_player_duplicates/);
    assert.doesNotMatch(sql, /alter table public\.players\b/i);
  }
});
test('audit is append-only: no update path exists', () => {
  const trigger = auditSql.slice(auditSql.indexOf('create or replace function public.contact_reveal_events_immutable'), auditSql.indexOf('revoke all on function public.contact_reveal_events_immutable'));
  assert.match(trigger, /if tg_op = 'UPDATE' then\s*\n\s*raise exception/);
  assert.doesNotMatch(trigger, /replay_count|last_replay/);
  assert.match(auditSql, /before update on public\.contact_reveal_events/);
  assert.match(auditSql, /before delete on public\.contact_reveal_events/);
  assert.doesNotMatch(auditSql, /replay_count|last_replay_at|last_replay_outcome/);
  // Only SELECT is ever granted to browser roles.
  assert.match(auditSql, /revoke all on public\.contact_reveal_events from public, anon, authenticated;/);
  assert.match(auditSql, /grant select on public\.contact_reveal_events to authenticated;/);
  assert.doesNotMatch(auditSql, /grant (insert|update|delete)[^;]*contact_reveal_events[^;]*authenticated/i);
});
test('exactly one canonical decision per request_id is enforced by a partial unique index', () => {
  assert.match(auditSql, /create unique index if not exists contact_reveal_canonical_request_idx\s*\n\s*on public\.contact_reveal_events\(request_id\)\s*\n\s*where event_type in \('reveal_succeeded','reveal_denied'\)/);
});
test('reason codes are a constrained enum, not free text', () => {
  assert.match(auditSql, /create type public\.contact_reveal_reason as enum/);
  assert.match(auditSql, /reason_code public\.contact_reveal_reason not null/);
  assert.doesNotMatch(auditSql, /safe_reason/);
  for (const code of ['granted','actor_not_agent','player_not_found','not_assigned','status_not_in_work','prior_denial','request_id_conflict','rate_limited']) {
    assert.match(auditSql, new RegExp(`'${code}'`));
  }
});
test('audit stores channel names but never contact values', () => {
  assert.match(auditSql, /channels text\[\] not null default '\{\}'::text\[\]\s*\n\s*check \(channels <@ array\['phone','email','messenger'\]::text\[\]\)/);
  const table = auditSql.slice(auditSql.indexOf('create table if not exists public.contact_reveal_events'), auditSql.indexOf('create unique index'));
  assert.doesNotMatch(table, /\bphone text\b|\bemail text\b|\bmessenger text\b/);
});
test('rate limits are seeded as data at the approved defaults', () => {
  assert.match(auditSql, /insert into public\.contact_reveal_limits\(id, per_minute, per_hour\)\s*\n\s*values \(true, 15, 150\)/);
  assert.match(auditSql, /revoke all on public\.contact_reveal_limits from public, anon, authenticated;/);
});
test('reveal returns for controlled outcomes and never raises them', () => {
  const fn = rpcSql.slice(rpcSql.indexOf('create or replace function public.reveal_player_contacts'), rpcSql.indexOf('create or replace function public.purge_contact_reveal_events'));
  for (const outcome of ['revealed', 'denied', 'rate_limited', 'request_id_conflict']) {
    assert.match(fn, new RegExp(`outcome := '${outcome}'`), `${outcome} must be returned, not raised`);
  }
  // The only raises are pre-audit guards and a missing-config invariant.
  const raises = fn.match(/raise exception using errcode = '[^']+', message = '([A-Z_]+)'/g) || [];
  const messages = raises.map(r => r.match(/message = '([A-Z_]+)'/)[1]);
  assert.deepEqual([...new Set(messages)].sort(), ['CONTACT_REVEAL_LIMITS_MISSING', 'INVALID_REQUEST_ID']);
  assert.doesNotMatch(fn, /message = 'REVEAL_DENIED'/);
});
test('a lost canonical-insert race still audits and returns the contract outcome', () => {
  const fn = rpcSql.slice(rpcSql.indexOf('create or replace function public.reveal_player_contacts'), rpcSql.indexOf('create or replace function public.purge_contact_reveal_events'));
  // The per-actor advisory lock does not serialize two different actors sharing a request_id, so the
  // partial unique index can fire. Without this handler the loser aborts with a raw 23505 and no event.
  assert.match(fn, /exception when unique_violation then/);
  const handler = fn.slice(fn.indexOf('exception when unique_violation then'));
  assert.match(handler, /event_type[\s\S]*'request_id_conflict'|'request_id_conflict', 'request_id_conflict'/);
  assert.match(handler, /outcome := 'request_id_conflict'/);
  assert.match(handler, /phone := null; email := null; messenger := null; revealed_at := null;/);
  assert.match(handler, /access_event_id := v_event_id/);
  // The handler must not swallow anything else.
  assert.doesNotMatch(fn, /exception when others/i);
});
// The public response contract is the RETURNS TABLE declaration and nothing else. Identifiers such as
// reason_code, channels, player_status, per_minute and per_hour are legitimate inside the function body and
// must never influence this check. An earlier version sliced from 'returns table(' to a literal
// ')\nlanguage plpgsql security definer'; that marker is line-ending dependent, so on a CRLF checkout it
// returned -1 and slice(start, -1) silently captured the whole file, making the body fail the assertion.
// Parse the declaration structurally instead: scan balanced parentheses and split on depth-zero commas.
function parseReturnsTable(sql, functionName) {
  const fnAt = sql.indexOf(`create or replace function public.${functionName}`);
  if (fnAt === -1) throw new Error(`function ${functionName} not found`);
  const declAt = sql.toLowerCase().indexOf('returns table', fnAt);
  if (declAt === -1) throw new Error(`RETURNS TABLE not found for ${functionName}`);
  const open = sql.indexOf('(', declAt);
  if (open === -1) throw new Error('malformed RETURNS TABLE');
  let depth = 0, close = -1;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') { depth -= 1; if (depth === 0) { close = i; break; } }
  }
  if (close === -1) throw new Error('unbalanced RETURNS TABLE parentheses');
  const columns = [];
  let buffer = ''; depth = 0;
  for (const character of sql.slice(open + 1, close)) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) { columns.push(buffer); buffer = ''; continue; }
    buffer += character;
  }
  if (buffer.trim()) columns.push(buffer);
  // Whitespace-normalised, so CR, LF and indentation cannot affect the result.
  return columns.map(column => column.trim().split(/\s+/)[0]);
}

const APPROVED_RESPONSE = ['player_id','outcome','phone','email','messenger','revealed_at','request_id','access_event_id'];

test('response contract is exactly the approved eight columns, in order', () => {
  const columns = parseReturnsTable(rpcSql, 'reveal_player_contacts');
  // deepEqual on an ordered array asserts names, order, count and absence of extras in one comparison.
  assert.deepEqual(columns, APPROVED_RESPONSE);
  assert.equal(columns.length, 8);
});

test('the contract parser rejects any expansion, reordering or leakage of the response', () => {
  const body = `
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.contact_reveal_events(reason_code, channels, player_status, player_agent_id)
    values ('granted', '{}', 'in_work', null);
  select per_minute, per_hour from public.contact_reveal_limits;
end $$;`;
  const fixture = declaration => `create or replace function public.reveal_player_contacts(p_player_id text, p_request_id uuid)\r\nreturns table(${declaration})\r\n${body}`;
  const approved = 'player_id text, outcome text, phone text, email text, messenger text, revealed_at timestamptz, request_id uuid, access_event_id uuid';

  // A body full of internal identifiers must not affect the parsed contract, on CRLF input.
  assert.deepEqual(parseReturnsTable(fixture(approved), 'reveal_player_contacts'), APPROVED_RESPONSE);

  // Leaking an internal column into the response must fail.
  assert.notDeepEqual(parseReturnsTable(fixture(`${approved}, reason_code public.contact_reveal_reason`), 'reveal_player_contacts'), APPROVED_RESPONSE);

  // A ninth column must fail even when it looks harmless.
  assert.notDeepEqual(parseReturnsTable(fixture(`${approved}, extra text`), 'reveal_player_contacts'), APPROVED_RESPONSE);

  // Reordering must fail even though the set of names is unchanged.
  const swapped = 'outcome text, player_id text, phone text, email text, messenger text, revealed_at timestamptz, request_id uuid, access_event_id uuid';
  const reordered = parseReturnsTable(fixture(swapped), 'reveal_player_contacts');
  assert.equal(reordered.length, 8);
  assert.deepEqual([...reordered].sort(), [...APPROVED_RESPONSE].sort(), 'same names');
  assert.notDeepEqual(reordered, APPROVED_RESPONSE, 'but order must still fail');

  // Dropping a column must fail.
  assert.notDeepEqual(parseReturnsTable(fixture(approved.replace(', access_event_id uuid', '')), 'reveal_player_contacts'), APPROVED_RESPONSE);
});
test('every non-revealed outcome nulls all contact fields', () => {
  const fn = rpcSql.slice(rpcSql.indexOf('create or replace function public.reveal_player_contacts'), rpcSql.indexOf('create or replace function public.purge_contact_reveal_events'));
  const nulled = fn.match(/phone := null; email := null; messenger := null; revealed_at := null;/g) || [];
  // rate_limited, actor_not_agent, request_id_conflict, prior-denial replay, and the shared denial tail.
  assert.ok(nulled.length >= 5, `expected every refusal path to null contacts, found ${nulled.length}`);
  assert.match(fn, /outcome := 'revealed';\s*\n\s*phone := v_player\.phone/);
});
test('authorization is revalidated on locked rows in the approved order', () => {
  const fn = rpcSql.slice(rpcSql.indexOf('create or replace function public.reveal_player_contacts'));
  const profileLock = fn.indexOf('from public.profiles p where p.id = v_actor.id for share');
  const playerLock = fn.indexOf('from public.players pl where pl.id = v_player_key for share');
  assert.ok(profileLock > 0 && playerLock > profileLock, 'profiles must be locked before players');
  // No lock statement may use FOR KEY SHARE: it does not block a plain status UPDATE.
  assert.doesNotMatch(fn, /for key share\s*;/i);
  assert.match(fn, /v_player\.agent_id is distinct from v_actor\.id/);
  assert.match(fn, /v_player\.status <> 'in_work'/);
  assert.match(fn, /v_locked_actor\.is_active/);
  assert.match(fn, /v_locked_actor\.role <> 'agent'/);
});
test('rate check is bounded, precedes any audit write, and counts replays', () => {
  const fn = rpcSql.slice(rpcSql.indexOf('create or replace function public.reveal_player_contacts'));
  assert.match(fn, /limit v_limits\.per_hour \+ 1/);
  assert.match(fn, /order by e\.created_at desc/);
  assert.match(fn, /e\.event_type <> 'rate_limited'/);
  assert.doesNotMatch(fn, /event_type in \('reveal_succeeded'[^)]*\)\s*\n\s*and e\.actor_id/);
  // Advisory lock makes the count exact under concurrency, and must precede the count.
  const lock = fn.indexOf('pg_advisory_xact_lock');
  const count = fn.indexOf('interval \'1 hour\'');
  const firstInsert = fn.indexOf('insert into public.contact_reveal_events');
  assert.ok(lock > 0 && lock < count && count < firstInsert, 'lock -> count -> audit write ordering');
});
test('every new function pins search_path and uses no dynamic SQL', () => {
  for (const sql of [auditSql, rpcSql]) {
    const definitions = sql.match(/create or replace function public\.\w+[\s\S]*?as \$\$/g) || [];
    assert.ok(definitions.length > 0);
    for (const definition of definitions) assert.match(definition, /set search_path = pg_catalog, public/);
    assert.doesNotMatch(sql, /execute\s+format|execute\s+'/i);
  }
});
test('grants follow least privilege', () => {
  assert.match(rpcSql, /revoke all on function public\.reveal_player_contacts\(text, uuid\) from public, anon;/);
  assert.match(rpcSql, /grant execute on function public\.reveal_player_contacts\(text, uuid\) to authenticated;/);
  assert.match(rpcSql, /revoke all on function public\.purge_contact_reveal_events\(timestamptz\) from public, anon, authenticated;/);
  assert.match(rpcSql, /grant execute on function public\.purge_contact_reveal_events\(timestamptz\) to service_role;/);
  assert.doesNotMatch(rpcSql, /grant execute on function public\.purge_contact_reveal_events[^;]*authenticated/);
});
test('response is marked no-store', () => {
  assert.match(rpcSql, /set_config\('response\.headers', '\[\{"Cache-Control": "no-store"\}\]', true\)/);
});
test('rollback removes only PR B objects and demands an audit export first', () => {
  assert.match(rollbackRpc, /drop function if exists public\.reveal_player_contacts\(text, uuid\)/);
  assert.doesNotMatch(rollbackRpc, /drop table/i);
  assert.match(rollbackAudit, /MANDATORY PRECONDITION/);
  assert.match(rollbackAudit, /encrypted company archive/i);
  assert.match(rollbackAudit, /drop table if exists public\.contact_reveal_events/);
  for (const sql of [rollbackAudit, rollbackRpc]) assert.doesNotMatch(sql, /players_secure|public\.players\b/);
});
