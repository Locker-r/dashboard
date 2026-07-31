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
test('response contract is exactly the approved eight columns', () => {
  const signature = rpcSql.slice(rpcSql.indexOf('returns table('), rpcSql.indexOf(')\nlanguage plpgsql security definer'));
  for (const column of ['player_id text','outcome text','phone text','email text','messenger text','revealed_at timestamptz','request_id uuid','access_event_id uuid']) {
    assert.match(signature, new RegExp(column.replace(/[[\]]/g, '\\$&')));
  }
  assert.doesNotMatch(signature, /reason_code|player_status|agent_id|per_minute|per_hour|channels/);
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
