import { createClient } from 'npm:@supabase/supabase-js@2.53.0';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['list-members', 'invite-member', 'create-member', 'update-member-role', 'set-member-active', 'reassign-players', 'update-member-country']);
// ISO 3166-1 alpha-2. The database enforces the same shape; this is the early,
// cheap rejection so a malformed value never reaches an Auth write.
const COUNTRY = /^[A-Za-z]{2}$/;

class ApiError extends Error {
  constructor(public status: number, public code: string, message = code) { super(message); }
}

function response(status: number, body: unknown, origin?: string) {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (origin) headers['access-control-allow-origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

function text(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new ApiError(400, 'INVALID_INPUT', `Invalid ${field}`);
  return value.trim();
}
function uuid(value: unknown, field: string) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApiError(400, 'INVALID_INPUT', `Invalid ${field}`);
  return value;
}
function role(value: unknown) {
  if (value !== 'admin' && value !== 'agent') throw new ApiError(400, 'INVALID_INPUT', 'Invalid role');
  return value;
}
function country(value: unknown) {
  if (typeof value !== 'string' || !COUNTRY.test(value.trim())) throw new ApiError(400, 'INVALID_COUNTRY', 'Invalid country');
  return value.trim().toUpperCase();
}
function email(value: unknown) {
  const normalized = text(value, 'email', 3, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new ApiError(400, 'INVALID_EMAIL', 'Invalid email');
  return normalized;
}
// A temporary password is optional. When absent the member is invited by email
// instead. The value is read here, handed straight to the Auth admin API, and
// never logged, echoed, or persisted to a profile.
function optionalPassword(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new ApiError(400, 'INVALID_PASSWORD', 'Invalid temporary password');
  }
  return value;
}
function optionalPlayerIds(value: unknown) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 500 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) throw new ApiError(400, 'INVALID_INPUT', 'Invalid playerIds');
  return [...new Set(value.map(id => id.trim()))];
}

async function findAuthUserByEmail(admin: ReturnType<typeof createClient>, email: string) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find(user => user.email?.toLowerCase() === email);
    if (found) return found;
    if (data.users.length < 1000) return null;
  }
  throw new ApiError(409, 'USER_LOOKUP_LIMIT', 'User lookup limit reached');
}

Deno.serve(async request => {
  const allowedOrigin = Deno.env.get('TEAM_ALLOWED_ORIGIN') || '';
  const requestOrigin = request.headers.get('origin') || '';
  const corsOrigin = allowedOrigin && requestOrigin === allowedOrigin ? requestOrigin : undefined;
  if (request.method === 'OPTIONS') {
    if (!corsOrigin) return response(403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin forbidden' } });
    return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': corsOrigin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST',
      'access-control-max-age': '600',
    } });
  }
  try {
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 32768) throw new ApiError(413, 'REQUEST_TOO_LARGE');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceKey) throw new ApiError(503, 'SERVER_NOT_CONFIGURED');
    const authorization = request.headers.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new ApiError(401, 'AUTH_REQUIRED');

    const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await authClient.auth.getUser(match[1]);
    if (authError || !authData.user) throw new ApiError(401, 'INVALID_TOKEN');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: actor, error: actorError } = await admin.from('profiles').select('id,role,is_active').eq('id', authData.user.id).maybeSingle();
    if (actorError) throw actorError;
    if (!actor || !actor.is_active || actor.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED');

    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { throw new ApiError(400, 'INVALID_JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !ACTIONS.has(String(body.action))) throw new ApiError(400, 'INVALID_ACTION');
    const action = String(body.action);
    let result: unknown;

    if (action === 'list-members') {
      const { data, error } = await admin.rpc('team_list_members', { p_actor_id: actor.id });
      if (error) throw error;
      result = data;
    } else if (action === 'invite-member') {
      const email = text(body.email, 'email', 3, 320).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'INVALID_INPUT', 'Invalid email');
      const requestId = uuid(body.requestId, 'requestId');
      let user = await findAuthUserByEmail(admin, email);
      if (!user) {
        const invited = await admin.auth.admin.inviteUserByEmail(email, { data: { invitation_source: 'dashboard_team' } });
        if (invited.error || !invited.data.user) throw invited.error || new ApiError(502, 'INVITATION_FAILED');
        user = invited.data.user;
      }
      const { data, error } = await admin.rpc('team_register_invitation', {
        p_actor_id: actor.id, p_target_id: user.id, p_username: text(body.username, 'username', 2, 50),
        p_name: text(body.name, 'name', 1, 100), p_role: role(body.role), p_request_id: requestId,
      });
      if (error) throw error;
      result = data;
    } else if (action === 'create-member') {
      // Creates a cashier: one Auth user plus one profile, with the profile's
      // role forced to `agent` inside the database function. The client cannot
      // request any other role here or anywhere upstream.
      const memberEmail = email(body.email);
      const requestId = uuid(body.requestId, 'requestId');
      const username = text(body.username, 'username', 2, 50);
      const name = text(body.name, 'name', 1, 100);
      const memberCountry = country(body.country);
      const temporaryPassword = optionalPassword(body.temporaryPassword);

      const existing = await findAuthUserByEmail(admin, memberEmail);
      if (existing) {
        // An Auth user already exists. Report it rather than adopting the
        // account: silently attaching a profile to an unrelated identity is how
        // an account takeover starts.
        throw new ApiError(409, 'USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS');
      }

      const created = temporaryPassword
        ? await admin.auth.admin.createUser({ email: memberEmail, password: temporaryPassword, email_confirm: true })
        : await admin.auth.admin.inviteUserByEmail(memberEmail, { data: { invitation_source: 'dashboard_team' } });
      if (created.error || !created.data.user) throw new ApiError(502, 'CREATE_USER_FAILED', 'CREATE_USER_FAILED');
      const createdUser = created.data.user;

      let profile;
      try {
        const { data, error } = await admin.rpc('team_register_member', {
          p_actor_id: actor.id, p_target_id: createdUser.id, p_username: username,
          p_name: name, p_country: memberCountry, p_request_id: requestId,
        });
        if (error) throw error;
        profile = data;
      } catch (profileError) {
        // Compensation: this request created the Auth user, so this request
        // removes it. Without this the account would exist with no profile and
        // could never sign in, while the admin saw only an error.
        const removal = await admin.auth.admin.deleteUser(createdUser.id);
        const code = typeof profileError === 'object' && profileError && 'message' in profileError
          ? String(profileError.message) : 'CREATE_PROFILE_FAILED';
        const known = new Set(['PROFILE_ALREADY_EXISTS', 'USERNAME_ALREADY_EXISTS', 'INVALID_COUNTRY', 'INVALID_INVITATION', 'REQUEST_ID_REUSE', 'ACTIVE_ADMIN_REQUIRED']);
        if (removal.error) {
          // The orphan could not be cleaned up. Say so explicitly instead of
          // returning a generic failure that hides recoverable state.
          throw new ApiError(500, 'CREATE_PROFILE_FAILED_ORPHAN_USER', 'CREATE_PROFILE_FAILED_ORPHAN_USER');
        }
        throw new ApiError(known.has(code) ? 409 : 502, known.has(code) ? code : 'CREATE_PROFILE_FAILED');
      }
      result = { member: profile, invited: !temporaryPassword };
    } else if (action === 'update-member-country') {
      const { data, error } = await admin.rpc('team_update_member_country', {
        p_actor_id: actor.id, p_target_id: uuid(body.memberId, 'memberId'),
        p_country: country(body.country), p_request_id: uuid(body.requestId, 'requestId'),
      });
      if (error) throw error; result = data;
    } else if (action === 'update-member-role') {
      const { data, error } = await admin.rpc('team_update_member_role', {
        p_actor_id: actor.id, p_target_id: uuid(body.memberId, 'memberId'), p_role: role(body.role), p_request_id: uuid(body.requestId, 'requestId'),
      });
      if (error) throw error; result = data;
    } else if (action === 'set-member-active') {
      if (typeof body.isActive !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Invalid isActive');
      const { data, error } = await admin.rpc('team_set_member_active', {
        p_actor_id: actor.id, p_target_id: uuid(body.memberId, 'memberId'), p_is_active: body.isActive,
        p_reassign_to: body.reassignTo == null ? null : uuid(body.reassignTo, 'reassignTo'), p_request_id: uuid(body.requestId, 'requestId'),
      });
      if (error) throw error; result = data;
    } else {
      const { data, error } = await admin.rpc('team_reassign_players', {
        p_actor_id: actor.id, p_from_agent_id: uuid(body.fromAgentId, 'fromAgentId'), p_to_agent_id: uuid(body.toAgentId, 'toAgentId'),
        p_player_ids: optionalPlayerIds(body.playerIds), p_request_id: uuid(body.requestId, 'requestId'),
      });
      if (error) throw error; result = data;
    }
    return response(200, { ok: true, data: result }, corsOrigin);
  } catch (error) {
    if (error instanceof ApiError) return response(error.status, { ok: false, error: { code: error.code, message: error.message } }, corsOrigin);
    const code = typeof error === 'object' && error && 'message' in error ? String(error.message) : 'INTERNAL_ERROR';
    const safeCodes = new Set(['SERVICE_ROLE_REQUIRED','ACTIVE_ADMIN_REQUIRED','SELF_PROMOTION_FORBIDDEN','LAST_ACTIVE_ADMIN','REASSIGNMENT_REQUIRED','INVALID_REASSIGNMENT_AGENT','MEMBER_NOT_FOUND','REQUEST_ID_REUSE','PROFILE_ALREADY_EXISTS','USERNAME_ALREADY_EXISTS','INVALID_COUNTRY','INVALID_COUNTRY_CHANGE','INACTIVE_AGENT_HAS_PLAYERS','PLAYER_ASSIGNMENT_MISMATCH','REASSIGNMENT_COUNT_MISMATCH']);
    const databaseCode = typeof error === 'object' && error && 'code' in error && /^[A-Z0-9]{5,12}$/.test(String(error.code)) ? `DATABASE_${String(error.code)}` : null;
    const safe = safeCodes.has(code) ? code : (databaseCode || 'INTERNAL_ERROR');
    return response(safeCodes.has(code) ? 409 : 500, { ok: false, error: { code: safe, message: safe } }, corsOrigin);
  }
});
