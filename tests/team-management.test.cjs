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
test('every mutation stores and compares a canonical request plus its original result', () => {
  assert.equal((sql.match(/details->'request' is distinct from v_request/g) || []).length, 4);
  assert.equal((sql.match(/'request',v_request,'result'/g) || []).length, 4);
  assert.equal((sql.match(/return v_existing\.details->'result'/g) || []).length, 2);
  assert.equal((sql.match(/jsonb_populate_record\(null::public\.profiles,v_existing\.details->'result'\)/g) || []).length, 2);
  assert.match(sql, /'scope','all','player_ids',null/);
  assert.match(sql, /array_agg\(normalized\.player_id order by normalized\.player_id\)[\s\S]*select distinct trim\(requested\.player_id\)/);
  assert.equal((sql.match(/pg_advisory_xact_lock\(hashtextextended\(p_request_id::text,0\)\)/g) || []).length, 4);
});
test('invitation never updates an existing profile', () => {
  assert.doesNotMatch(sql, /on conflict\s*\(id\)\s*do update/i);
  assert.match(sql, /exists\(select 1 from public\.profiles where id=p_target_id\)[\s\S]*message='PROFILE_ALREADY_EXISTS'/);
  assert.match(sql, /insert into public\.profiles\(id,username,name,role,lang,is_active\)[\s\S]*returning \* into v_target/);
});
test('explicit reassignment locks all requested rows and enforces exact all-or-nothing count', () => {
  const lockAt = sql.indexOf('where p.id=any(v_ids) order by p.id for update');
  const updateAt = sql.indexOf('where agent_id=p_from_agent_id and id=any(v_ids)');
  assert.ok(lockAt > 0 && updateAt > lockAt);
  assert.match(sql, /cardinality\(v_locked_ids\) <> v_expected/);
  assert.match(sql, /get diagnostics v_count = row_count;[\s\S]*v_count <> v_expected[\s\S]*REASSIGNMENT_COUNT_MISMATCH/);
  assert.ok(sql.indexOf('REASSIGNMENT_COUNT_MISMATCH') < sql.indexOf("'reassign_players',v_actor.id"));
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
test('browser CORS uses one exact configured origin and never a wildcard', () => {
  assert.match(edge, /Deno\.env\.get\('TEAM_ALLOWED_ORIGIN'\)/);
  assert.match(edge, /requestOrigin === allowedOrigin/);
  assert.doesNotMatch(edge, /access-control-allow-origin['"]?\s*[:=]\s*['"]\*/i);
});
test('reassignment count mismatch is returned as a safe 409, not a masked DATABASE_40001/500', () => {
  const startMarker = "const code = typeof error === 'object' && error && 'message' in error ? String(error.message) : 'INTERNAL_ERROR';";
  const endMarker = "return response(safeCodes.has(code) ? 409 : 500, { ok: false, error: { code: safe, message: safe } }, corsOrigin);";
  const startAt = edge.indexOf(startMarker);
  const endAt = edge.indexOf(endMarker);
  assert.ok(startAt > -1 && endAt > startAt, 'edge error-mapping block not found in expected shape');
  const mapErrorBody = edge.slice(startAt, endAt + endMarker.length);
  const mapError = new Function('error', 'response', 'corsOrigin', mapErrorBody);
  const response = (status, body) => ({ status, body });

  const countMismatch = mapError({ message: 'REASSIGNMENT_COUNT_MISMATCH', code: '40001' }, response, undefined);
  assert.equal(countMismatch.status, 409);
  assert.equal(countMismatch.body.error.code, 'REASSIGNMENT_COUNT_MISMATCH');

  const unknownDbError = mapError({ message: 'unexpected constraint violation', code: '99999' }, response, undefined);
  assert.equal(unknownDbError.status, 500);
  assert.equal(unknownDbError.body.error.code, 'DATABASE_99999');
});
test('team list follows admin authorization and direct profile RLS remains restricted', () => {
  assert.ok(edge.indexOf("actor.role !== 'admin'") < edge.indexOf("action === 'list-members'"));
  const foundation = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260729000100_dashboard_foundation.sql'), 'utf8');
  assert.match(foundation, /profiles_select_own_or_admin[\s\S]*id = auth\.uid\(\) or public\.is_admin\(\)/);
});
