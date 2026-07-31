const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root,'supabase','migrations','20260731000100_secure_contact_boundary.sql'),'utf8');

test('secure projection exposes only explicit masked contact columns',()=>{
  assert.match(migration,/create or replace view public\.players_secure/i);
  assert.doesNotMatch(migration,/players_secure[\s\S]{0,100}select\s+\*/i);
  assert.match(migration,/phone_display[\s\S]*email_display[\s\S]*messenger_display/i);
  assert.match(migration,/contact_access_state/i);
});
test('raw players select is revoked and secure projection is granted',()=>{
  assert.match(migration,/revoke select on public\.players from authenticated/i);
  assert.match(migration,/grant select on public\.players_secure to authenticated/i);
});
test('duplicate check is admin-authorized and returns safe metadata only',()=>{
  const duplicateFunction = migration.match(/create or replace function public\.check_player_duplicates_atomic[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(duplicateFunction,/v_actor\.role <> 'admin'/);
  assert.match(duplicateFunction,/returns table\(row_index integer, duplicate boolean, matched_player_id text, matched_fields text\[\]\)/i);
  assert.doesNotMatch(duplicateFunction,/returns setof public\.players/i);
});
test('ordinary player RPC wrappers scrub contact values',()=>{
  assert.match(migration,/secure_player_result/);
  assert.match(migration,/row\(p\.id,'','',''/);
  assert.match(migration,/raw_legacy[\s\S]*revoke all/i);
});
