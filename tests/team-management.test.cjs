const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260729000400_team_management.sql'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'team-management', 'index.ts'), 'utf8');

test('team migration is transactional and creates immutable audit storage', () => {
  assert.match(sql, /^--[^\n]*\nbegin;/i); assert.match(sql, /create table if not exists public\.admin_audit_events/);
  assert.match(sql, /unique \(request_id, action\)/); assert.match(sql, /on delete restrict/g);
  assert.match(sql, /revoke all on public\.admin_audit_events from public, anon, authenticated/); assert.match(sql, /commit;\s*$/i);
});
test('team RPCs are service-role only and require an active admin', () => {
  assert.match(sql, /auth\.role\(\) <> 'service_role'/); assert.match(sql, /where id = p_actor_id and is_active and role = 'admin'/);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/); assert.match(sql, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to authenticated/);
  assert.match(sql, /grant select on public\.profiles to service_role/);
});
test('last active admin changes are serialized and protected', () => {
  assert.equal((sql.match(/pg_advisory_xact_lock\(746326824991\)/g) || []).length, 2);
  assert.equal((sql.match(/message='LAST_ACTIVE_ADMIN'/g) || []).length, 2);
});
test('self-promotion and assignment to inactive agents are rejected', () => {
  assert.match(sql, /p_target_id = v_actor\.id and p_role = 'admin'/); assert.match(sql, /message='SELF_PROMOTION_FORBIDDEN'/);
  assert.equal((sql.match(/role='agent' and is_active/g) || []).length, 2); assert.equal((sql.match(/message='INVALID_REASSIGNMENT_AGENT'/g) || []).length, 2);
});
test('deactivation with players requires atomic safe reassignment', () => {
  assert.match(sql, /not p_is_active and exists\(select 1 from public\.players where agent_id=p_target_id\)/);
  assert.match(sql, /message='REASSIGNMENT_REQUIRED'/); assert.match(sql, /update public\.players set agent_id=p_reassign_to where agent_id=p_target_id/);
});
test('mutations use idempotent audit keys and never delete users or history', () => {
  for (const action of ['invite_member','update_member_role','set_member_active','reassign_players']) assert.match(sql, new RegExp(`action='${action}'|,'${action}',`));
  assert.doesNotMatch(sql, /delete\s+from/i); assert.doesNotMatch(sql, /auth\.users/);
});
test('edge verifies JWT and loads the caller profile instead of trusting actor input', () => {
  assert.match(edge, /auth\.getUser\(match\[1\]\)/);
  assert.match(edge, /\.from\('profiles'\)\.select\('id,role,is_active'\)\.eq\('id', authData\.user\.id\)/);
  assert.match(edge, /!actor\.is_active \|\| actor\.role !== 'admin'/); assert.doesNotMatch(edge, /body\.actor|body\.actorId|body\.actorRole/);
});
test('edge exposes only the approved action allowlist', () => {
  for (const action of ['list-members','invite-member','update-member-role','set-member-active','reassign-players']) assert.match(edge, new RegExp(`'${action}'`));
  assert.doesNotMatch(edge, /delete-member|deleteUser|resend-invitation/);
});
test('edge keeps elevated secrets server-side and returns safe errors', () => {
  assert.match(edge, /Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/); assert.doesNotMatch(edge, /console\.(log|error)/);
  assert.match(edge, /\{ ok: false, error: \{ code:/); assert.match(edge, /safeCodes\.has\(code\) \? code : \(databaseCode \|\| 'INTERNAL_ERROR'\)/);
});
test('team list follows admin authorization and direct profile RLS remains restricted', () => {
  assert.ok(edge.indexOf("actor.role !== 'admin'") < edge.indexOf("action === 'list-members'"));
  const foundation = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260729000100_dashboard_foundation.sql'), 'utf8');
  assert.match(foundation, /profiles_select_own_or_admin[\s\S]*id = auth\.uid\(\) or public\.is_admin\(\)/);
});
