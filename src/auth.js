(function exposeAuth(root, factory) {
  const auth = factory();
  if (typeof module === 'object' && module.exports) module.exports = auth;
  root.ReactivationAuth = auth;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAuth() {
  'use strict';

  function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase();
  }

  function findUser(users, username) {
    const normalized = normalizeUsername(username);
    if (!normalized) return null;
    return (Array.isArray(users) ? users : []).find(user => user && normalizeUsername(user.username) === normalized) || null;
  }

  function usernameExists(users, username) {
    return Boolean(findUser(users, username));
  }

  async function hashValue(value, salt, cryptoApi) {
    if (!cryptoApi || !cryptoApi.subtle || typeof salt !== 'string') return null;
    const encoded = new TextEncoder().encode(`${salt}:${value}`);
    const digest = await cryptoApi.subtle.digest('SHA-256', encoded);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function authenticateUser(users, username, password, cryptoApi) {
    const user = findUser(users, username);
    if (!user) return { ok: false, reason: 'unknown_user' };
    if (typeof user.salt !== 'string' || typeof user.passwordHash !== 'string') {
      return { ok: false, reason: 'unsupported_user_format' };
    }
    const passwordHash = await hashValue(password, user.salt, cryptoApi);
    return passwordHash === user.passwordHash
      ? { ok: true, user }
      : { ok: false, reason: 'wrong_password' };
  }

  function appendUser(users, user) {
    return [...(Array.isArray(users) ? users : []), user];
  }

  function roleForRegistration(users, storageAllowsInitialization) {
    return Array.isArray(users) && users.length === 0 && storageAllowsInitialization ? 'admin' : 'agent';
  }

  return Object.freeze({ normalizeUsername, findUser, usernameExists, hashValue, authenticateUser, appendUser, roleForRegistration });
});
