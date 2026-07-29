const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/supabase-auth-service.js');

function clientWith(options = {}) {
  const calls = { signIn: [], signOut: 0, getSession: 0 };
  const client = {
    auth: {
      async signInWithPassword(credentials) { calls.signIn.push(credentials); return options.signInResult; },
      async getSession() { calls.getSession += 1; return options.sessionResult; },
      async signOut() { calls.signOut += 1; return { error: null }; }
    },
    from(table) {
      assert.equal(table, 'profiles');
      return { select: () => ({ eq: () => ({ maybeSingle: async () => options.profileResult }) }) };
    }
  };
  return { client, calls };
}

test('signs in with email and password and returns compatible currentUser', async () => {
  const fixture = clientWith({
    signInResult: { data: { user: { id: 'u1', email: 'admin@example.com' } }, error: null },
    profileResult: { data: { username: 'admin', name: 'Admin', role: 'admin', lang: 'es', is_active: true }, error: null }
  });
  const result = await new auth.SupabaseAuthService(fixture.client).signIn('admin@example.com', 'password');
  assert.deepEqual(result, { id: 'u1', email: 'admin@example.com', username: 'admin', name: 'Admin', role: 'admin', lang: 'es' });
  assert.deepEqual(fixture.calls.signIn, [{ email: 'admin@example.com', password: 'password' }]);
});

test('restores an existing session and loads its profile', async () => {
  const fixture = clientWith({
    sessionResult: { data: { session: { user: { id: 'u1', email: 'a@example.com' } } }, error: null },
    profileResult: { data: { username: 'a', name: 'Agent', role: 'agent' }, error: null }
  });
  assert.equal((await new auth.SupabaseAuthService(fixture.client).getCurrentUser()).id, 'u1');
});

test('returns null when no session exists', async () => {
  const fixture = clientWith({ sessionResult: { data: { session: null }, error: null } });
  assert.equal(await new auth.SupabaseAuthService(fixture.client).getCurrentUser(), null);
});

test('rejects missing and inactive profiles without destroying a successful auth session', async () => {
  for (const [profile, code] of [[null, 'profile_missing'], [{ is_active: false }, 'profile_inactive']]) {
    const fixture = clientWith({
      signInResult: { data: { user: { id: 'u1', email: 'a@example.com' } }, error: null },
      profileResult: { data: profile, error: null }
    });
    await assert.rejects(() => new auth.SupabaseAuthService(fixture.client).signIn('a@example.com', 'pw'), error => error.code === code);
    assert.equal(fixture.calls.signOut, 0);
  }
});

test('reports profile query failures separately and preserves the auth session', async () => {
  const cause = Object.assign(new Error('permission denied for table profiles'), { code: '42501', status: 403 });
  const fixture = clientWith({
    signInResult: { data: { user: { id: 'u1', email: 'a@example.com' } }, error: null },
    profileResult: { data: null, error: cause }
  });
  await assert.rejects(
    () => new auth.SupabaseAuthService(fixture.client).signIn('a@example.com', 'pw'),
    error => error.code === 'profile_load_error' && error.cause === cause
  );
  assert.equal(fixture.calls.signOut, 0);
});

test('rejects a profile whose id does not match auth.users.id', async () => {
  const fixture = clientWith({
    signInResult: { data: { user: { id: 'auth-id', email: 'a@example.com' } }, error: null },
    profileResult: { data: { id: 'other-id', is_active: true }, error: null }
  });
  await assert.rejects(() => new auth.SupabaseAuthService(fixture.client).signIn('a@example.com', 'pw'),
    error => error.code === 'profile_load_error');
});

test('normalizes a trailing slash but rejects REST endpoints and non-Supabase project URLs', () => {
  assert.deepEqual(auth.normalizeConfig({
    projectUrl: ' https://example.supabase.co/ ', publishableKey: ' publishable '
  }), { projectUrl: 'https://example.supabase.co', publishableKey: 'publishable' });
  for (const projectUrl of [
    'https://example.supabase.co/rest/v1/',
    'https://example.supabase.co/auth/v1',
    'https://wrong.example.com'
  ]) {
    assert.throws(() => auth.normalizeConfig({ projectUrl, publishableKey: 'publishable' }),
      error => error.code === 'config_invalid');
  }
});

test('classifies invalid credentials and network failures', async () => {
  let fixture = clientWith({ signInResult: { data: {}, error: new Error('Invalid login credentials') } });
  await assert.rejects(() => new auth.SupabaseAuthService(fixture.client).signIn('a@example.com', 'bad'), error => error.code === 'invalid_credentials');
  fixture = clientWith({ signInResult: { data: {}, error: new TypeError('Failed to fetch') } });
  await assert.rejects(() => new auth.SupabaseAuthService(fixture.client).signIn('a@example.com', 'pw'), error => error.code === 'network_error');
});

test('creates official client with persistent session options', () => {
  let received;
  const storage = { getItem() {}, setItem() {}, removeItem() {} };
  const service = auth.createBrowserAuthService({ projectUrl: 'https://example.supabase.co', publishableKey: 'publishable' }, {
    createClient(...args) { received = args; return { auth: {} }; }
  }, storage);
  assert.ok(service instanceof auth.SupabaseAuthService);
  assert.deepEqual(received[2].auth, {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: auth.AUTH_STORAGE_KEY,
    storage
  });
});

test('restores currentUser after sign-in through a new client and service instance', async () => {
  const stored = new Map();
  const storage = {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, value); },
    removeItem(key) { stored.delete(key); }
  };
  const profile = { username: 'admin', name: 'Admin', role: 'admin', lang: 'ru', is_active: true };
  function fakeSupabaseApi() {
    return {
      createClient(_url, _key, options) {
        const sessionKey = options.auth.storageKey;
        return {
          auth: {
            async signInWithPassword({ email }) {
              const user = { id: 'u1', email };
              options.auth.storage.setItem(sessionKey, JSON.stringify({ user }));
              return { data: { user }, error: null };
            },
            async getSession() {
              const raw = options.auth.storage.getItem(sessionKey);
              return { data: { session: raw ? JSON.parse(raw) : null }, error: null };
            },
            async signOut() { options.auth.storage.removeItem(sessionKey); return { error: null }; }
          },
          from() { return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) }; }
        };
      }
    };
  }

  const config = { projectUrl: 'https://example.supabase.co', publishableKey: 'publishable' };
  const firstService = auth.createBrowserAuthService(config, fakeSupabaseApi(), storage);
  await firstService.signIn('admin@example.com', 'password');
  assert.equal(stored.has(auth.AUTH_STORAGE_KEY), true);

  const reloadedService = auth.createBrowserAuthService(config, fakeSupabaseApi(), storage);
  assert.deepEqual(await reloadedService.getCurrentUser(), {
    id: 'u1', email: 'admin@example.com', username: 'admin', name: 'Admin', role: 'admin', lang: 'ru'
  });
});
