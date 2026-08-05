(function exposeTeamAdmin(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationTeamAdmin = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTeamAdmin() {
  'use strict';

  // Browser client for the team-management Edge Function.
  //
  // Every operation here is privileged. None of that privilege lives in this
  // file: the function verifies the caller's bearer token, re-reads their
  // profile from the database, and refuses anything that is not an active
  // admin. This module cannot grant itself rights by sending extra fields, and
  // deliberately never sends a role or an actor id -- the server decides both.
  const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
  const USERNAME_MIN = 2;
  const USERNAME_MAX = 50;
  const NAME_MIN = 1;
  const NAME_MAX = 100;
  const PASSWORD_MIN = 8;
  const PASSWORD_MAX = 200;
  const CONTROL_CHARACTERS = new RegExp('[\\x00-\\x1f\\x7f]', 'g');

  function cleanText(value) {
    return String(value == null ? '' : value).replace(CONTROL_CHARACTERS, '').trim();
  }

  function normalizeCountry(value) {
    return cleanText(value).toUpperCase();
  }

  // Client-side form validation, mirrored by the Edge Function and again by the
  // database. It shortens the feedback loop; it does not decide anything.
  function validateMemberForm(input) {
    const form = input || {};
    const email = cleanText(form.email).toLowerCase();
    const name = cleanText(form.name);
    const username = cleanText(form.username);
    const country = normalizeCountry(form.country);
    const password = String(form.temporaryPassword == null ? '' : form.temporaryPassword);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: 'team_invalid_email' };
    if (name.length < NAME_MIN || name.length > NAME_MAX) return { ok: false, reason: 'team_invalid_name' };
    if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) return { ok: false, reason: 'team_invalid_username' };
    if (!COUNTRY_PATTERN.test(country)) return { ok: false, reason: 'team_invalid_country' };
    if (password && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) {
      return { ok: false, reason: 'team_invalid_password' };
    }
    return { ok: true, value: { email, name, username, country, temporaryPassword: password || null } };
  }

  // Maps a server error code onto a stable UI reason. Anything unrecognised
  // becomes a generic reason, so a database or Auth message never reaches the
  // screen and the existence of an account is not disclosed beyond the explicit
  // duplicate codes the server already returns to an authenticated admin.
  function teamErrorReason(code) {
    const known = {
      ADMIN_REQUIRED: 'team_admin_required',
      ACTIVE_ADMIN_REQUIRED: 'team_admin_required',
      AUTH_REQUIRED: 'team_auth_required',
      INVALID_TOKEN: 'team_auth_required',
      USER_ALREADY_EXISTS: 'team_user_exists',
      PROFILE_ALREADY_EXISTS: 'team_user_exists',
      USERNAME_ALREADY_EXISTS: 'team_username_exists',
      INVALID_EMAIL: 'team_invalid_email',
      INVALID_COUNTRY: 'team_invalid_country',
      INVALID_PASSWORD: 'team_invalid_password',
      INVALID_INPUT: 'team_invalid_input',
      MEMBER_NOT_FOUND: 'team_member_not_found',
      LAST_ACTIVE_ADMIN: 'team_last_admin',
      SELF_PROMOTION_FORBIDDEN: 'team_self_forbidden',
      REASSIGNMENT_REQUIRED: 'team_reassignment_required',
      INVALID_REASSIGNMENT_AGENT: 'team_invalid_destination',
      INACTIVE_AGENT_HAS_PLAYERS: 'team_reassignment_required',
      REQUEST_ID_REUSE: 'team_request_reuse',
      CREATE_USER_FAILED: 'team_create_user_failed',
      CREATE_PROFILE_FAILED: 'team_create_profile_failed',
      CREATE_PROFILE_FAILED_ORPHAN_USER: 'team_create_orphan',
      ORIGIN_FORBIDDEN: 'team_origin_forbidden',
      SERVER_NOT_CONFIGURED: 'team_not_configured'
    };
    return known[String(code || '').trim()] || 'team_operation_failed';
  }

  function createTeamAdminClient(options) {
    const config = options || {};
    const functionsUrl = String(config.functionsUrl || '').replace(/\/+$/, '');
    const getAccessToken = config.getAccessToken;
    const fetchImpl = config.fetch;
    if (!functionsUrl || typeof getAccessToken !== 'function' || typeof fetchImpl !== 'function') {
      throw new Error('TEAM_ADMIN_CONFIG_REQUIRED');
    }
    const newRequestId = typeof config.newRequestId === 'function'
      ? config.newRequestId
      : () => globalThis.crypto.randomUUID();

    async function call(action, payload) {
      const token = await getAccessToken();
      if (!token) throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' });
      let response;
      try {
        response = await fetchImpl(`${functionsUrl}/team-management`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ action }, payload))
        });
      } catch (_networkError) {
        throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' });
      }
      let body = null;
      try { body = await response.json(); } catch (_parseError) { body = null; }
      // A success is only a success when the server said so. A non-ok response,
      // a missing envelope, or ok:false all raise -- there is no path where a
      // caller can render a confirmation without a confirmed server result.
      if (!response.ok || !body || body.ok !== true) {
        const code = body && body.error && body.error.code ? body.error.code : `HTTP_${response.status}`;
        throw Object.assign(new Error(code), { code });
      }
      return body.data;
    }

    return {
      listMembers: () => call('list-members', {}),
      createMember: member => call('create-member', {
        email: member.email, username: member.username, name: member.name,
        country: member.country,
        temporaryPassword: member.temporaryPassword || undefined,
        requestId: newRequestId()
      }),
      updateMemberCountry: (memberId, country) => call('update-member-country', {
        memberId, country: normalizeCountry(country), requestId: newRequestId()
      }),
      setMemberActive: (memberId, isActive, reassignTo) => call('set-member-active', {
        memberId, isActive, reassignTo: reassignTo || undefined, requestId: newRequestId()
      }),
      updateMemberRole: (memberId, role) => call('update-member-role', {
        memberId, role, requestId: newRequestId()
      })
    };
  }

  return Object.freeze({
    COUNTRY_PATTERN,
    cleanText,
    normalizeCountry,
    validateMemberForm,
    teamErrorReason,
    createTeamAdminClient
  });
});
