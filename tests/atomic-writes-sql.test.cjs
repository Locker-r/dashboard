const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname,'..','supabase','atomic-writes.sql'),'utf8');

test('atomic migration is one explicit transaction with five scoped RPCs',()=>{
  assert.match(sql,/^--[\s\S]*\bbegin;/i);
  assert.match(sql,/commit;\s*$/i);
  assert.equal((sql.match(/create or replace function public\.(?:create_players|assign_players|change_player_status|add_player_comment|set_player_follow_up)_atomic/g)||[]).length,5);
});

test('RPCs are hardened and never granted to anon',()=>{
  assert.equal((sql.match(/security definer/g)||[]).length,6);
  assert.equal((sql.match(/set search_path/g)||[]).length,6);
  assert.match(sql,/revoke all on function[\s\S]+from public,anon;/i);
  assert.match(sql,/grant execute on function[\s\S]+to authenticated;/i);
  assert.doesNotMatch(sql,/service_role|publishableKey|secret/i);
});

test('status mutation locks the player and writes audit history',()=>{
  assert.match(sql,/where id=p_player_id for update/);
  assert.match(sql,/insert into public\.player_status_history/);
  assert.match(sql,/CONFIRMATION_REQUIRED/);
  assert.match(sql,/NOT_OWNER/);
  assert.equal((sql.match(/agent_id is distinct from v_actor\.id/g)||[]).length,3);
});
