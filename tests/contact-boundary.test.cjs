const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const projection = read('supabase/migrations/20260801000100_secure_contact_projection.sql');
const revoke = read('supabase/migrations/20260801000200_revoke_raw_contacts.sql');
const dataService = read('src/data/supabase-data-service.js');
const page = read('index.html');
const preflight = read('src/migration-preflight.js');

test('both contact migrations are transactional', () => {
  for (const sql of [projection, revoke]) { assert.match(sql, /begin;/i); assert.match(sql, /commit;\s*$/i); }
});
test('projection never selects raw contact columns and uses an explicit column list', () => {
  const view = projection.slice(projection.indexOf('create or replace view public.players_secure'), projection.indexOf('revoke all on public.players_secure'));
  assert.doesNotMatch(view, /select\s+\*/i);
  assert.doesNotMatch(view, /^\s*p\.(phone|email|messenger)\s*,/mi);
  for (const column of ['phone_display', 'email_display', 'messenger_display', 'has_phone', 'has_email', 'has_messenger', 'contact_access_state']) {
    assert.match(view, new RegExp(column));
  }
});
test('masking is unconditional and contact_access_state only reports eligibility', () => {
  const view = projection.slice(projection.indexOf('create or replace view public.players_secure'), projection.indexOf('revoke all on public.players_secure'));
  // The only in_work branch decides eligibility, never which value is returned.
  assert.match(view, /case when p\.status = 'in_work' then 'eligible' else 'locked' end as contact_access_state/);
  assert.equal((view.match(/in_work/g) || []).length, 1);
  for (const column of ['phone_display', 'email_display', 'messenger_display']) {
    const line = view.split('\n').find(row => row.includes(`as ${column}`));
    assert.ok(line && /mask_contact_/.test(line), `${column} must be produced by a masking function`);
  }
});
test('projection carries an explicit row predicate because it runs with definer rights', () => {
  assert.doesNotMatch(projection, /security_invoker\s*=\s*true/i);
  assert.match(projection, /security_barrier = true/);
  assert.match(projection, /from public\.players p\s*\nwhere public\.can_read_player\(p\.agent_id\)/);
});
test('authorization helper requires an active actor and restricts agents to their own rows', () => {
  const helper = projection.slice(projection.indexOf('create or replace function public.can_read_player'), projection.indexOf('revoke all on function public.normalize_contact_phone'));
  assert.match(helper, /actor\.id = auth\.uid\(\)/);
  assert.match(helper, /actor\.is_active/);
  assert.match(helper, /actor\.role = 'admin' or actor\.id = p_agent_id/);
});
test('every new function pins search_path and is denied to public and anon', () => {
  const names = ['normalize_contact_phone','normalize_contact_email','normalize_contact_messenger',
    'mask_contact_phone','mask_contact_email','mask_contact_messenger','can_read_player','check_player_duplicates'];
  for (const name of names) assert.match(projection, new RegExp(`revoke all on function[\\s\\S]*public\\.${name}`), `${name} must be revoked`);
  const definitions = projection.match(/create or replace function public\.\w+[\s\S]*?as \$\$/g) || [];
  for (const definition of definitions) assert.match(definition, /set search_path = pg_catalog, public/);
  assert.doesNotMatch(projection, /execute\s+format|execute\s+'/i);
});
test('duplicate contract returns only metadata and never a players rowtype', () => {
  const fn = projection.slice(projection.indexOf('create or replace function public.check_player_duplicates'), projection.indexOf('revoke all on function public.check_player_duplicates'));
  assert.match(fn, /returns table\(row_index integer, duplicate boolean, matched_player_id text, matched_fields text\[\]\)/);
  assert.doesNotMatch(fn, /returns\s+(setof\s+)?public\.players\b/);
  assert.match(fn, /message = 'ADMIN_REQUIRED'/);
  assert.match(fn, /security definer/);
  assert.match(projection, /grant execute on function public\.check_player_duplicates\(jsonb\) to authenticated/);
});
test('mutation RPCs return the masked projection instead of the raw players rowtype', () => {
  for (const name of ['create_players_atomic','assign_players_atomic','change_player_status_atomic','set_player_follow_up_atomic']) {
    assert.match(projection, new RegExp(`drop function if exists public\\.${name}`), `${name} must be dropped before retyping`);
  }
  assert.match(projection, /create function public\.create_players_atomic\(p_players jsonb\)\s*\nreturns setof public\.players_secure/);
  assert.match(projection, /create function public\.change_player_status_atomic\([\s\S]*?\)\s*\nreturns public\.players_secure/);
  assert.match(projection, /create function public\.set_player_follow_up_atomic\([\s\S]*?\)\s*\nreturns public\.players_secure/);
  assert.doesNotMatch(projection, /returns setof public\.players\b/);
});
test('cut-over replaces the table grant with a column list that omits contacts', () => {
  assert.match(revoke, /revoke select on public\.players from authenticated/);
  const grant = revoke.slice(revoke.indexOf('grant select (id'));
  for (const column of ['id','status','agent_id','created_by','imported_at','updated_at','follow_up_at']) assert.match(grant, new RegExp(`\\b${column}\\b`));
  for (const column of ['phone','email','messenger']) assert.doesNotMatch(grant.split('\n')[0], new RegExp(`\\b${column}\\b`));
});
test('rollback scripts exist and reverse both phases', () => {
  const one = read('supabase/rollback/20260801000100_secure_contact_projection_rollback.sql');
  const two = read('supabase/rollback/20260801000200_revoke_raw_contacts_rollback.sql');
  assert.match(two, /grant select on public\.players to authenticated/);
  assert.match(one, /drop view if exists public\.players_secure/);
  assert.match(one, /returns setof public\.players\b/);
});
test('data service reads the projection and never maps a raw contact onto a player', () => {
  assert.match(dataService, /from\('players_secure'\)/);
  assert.doesNotMatch(dataService, /from\('players'\)\.select/);
  const mapper = dataService.slice(dataService.indexOf('function mapPlayer'), dataService.indexOf('async function unwrap'));
  for (const key of ['phoneDisplay','emailDisplay','messengerDisplay','contactAccessState']) assert.match(mapper, new RegExp(key));
  assert.doesNotMatch(mapper, /\bphone:|\bemail:|\bmessenger:/);
  assert.match(dataService, /check_player_duplicates/);
});
test('browser never selects or renders a raw stored contact field', () => {
  assert.doesNotMatch(page, /select\('id,phone,email,messenger'\)/);
  assert.doesNotMatch(page, /\$\{escapeHtml\(p\.(phone|email|messenger)/);
  assert.doesNotMatch(page, /p\.phone\s*\|\|\s*p\.email/);
  assert.match(page, /function contactText\(player, field\)/);
});
test('import preflight consumes server duplicate metadata instead of stored contacts', () => {
  assert.match(preflight, /source\.remoteDuplicates/);
  assert.match(preflight, /row\.duplicate !== true/);
  assert.doesNotMatch(preflight, /remoteContacts\.set/);
  assert.match(page, /checkPlayerDuplicates\(players\)/);
});
