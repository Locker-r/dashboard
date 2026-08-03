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

function urlSecurityView(value) {
  const parsed = new URL(value);
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    username: parsed.username,
    password: parsed.password
  };
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

test('accepts only the three literal http loopback hosts with an optional port', () => {
  for (const projectUrl of [
    'http://127.0.0.1',
    'http://127.0.0.1:54321',
    'http://localhost',
    'http://localhost:54321',
    'http://[::1]',
    'http://[::1]:54321'
  ]) {
    const normalized = auth.normalizeConfig({ projectUrl, publishableKey: 'publishable' });
    assert.equal(normalized.projectUrl, new URL(projectUrl).origin);
    assert.equal(normalized.publishableKey, 'publishable');
  }
});

test('a widened loopback rule still refuses to send credentials off the machine', () => {
  for (const projectUrl of [
    'http://example.supabase.co',            // plaintext to a remote host
    'http://127.0.0.1.evil.com:54321',       // loopback-looking hostname, remote host
    'http://evil.com/127.0.0.1',             // loopback only in the path
    'https://127.0.0.1:54321',               // loopback is http-only, matching doctor
    'http://127.0.0.1:54321/rest/v1',        // not a project root
    'http://127.0.0.1:54321?apikey=x',
    'http://user:pw@127.0.0.1:54321',        // embedded credentials
    'http://[::2]:54321'
  ]) {
    assert.throws(() => auth.normalizeConfig({ projectUrl, publishableKey: 'publishable' }),
      error => error.code === 'config_invalid', `expected ${projectUrl} to be refused`);
  }
});

test('rejects raw loopback spellings whose evidence URL parsing erases', () => {
  const canonicalizingInputs = [
    ['decimal IPv4', 'http://2130706433:54321', 'http://127.0.0.1:54321'],
    ['hexadecimal IPv4', 'http://0x7f000001:54321', 'http://127.0.0.1:54321'],
    ['octal IPv4', 'http://017700000001:54321', 'http://127.0.0.1:54321'],
    ['mixed IPv4', 'http://0x7f.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['short IPv4', 'http://127.1:54321', 'http://127.0.0.1:54321'],
    ['zero-padded IPv4', 'http://127.000.000.001:54321', 'http://127.0.0.1:54321'],
    ['percent-encoded IPv4', 'http://%31%32%37.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['Unicode IPv4 separators', 'http://127。0。0。1:54321', 'http://127.0.0.1:54321'],
    ['extra authority slashes', 'http:////127.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['backslash authority', 'http:\\\\127.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['mixed separators', 'http:/\\127.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['trailing backslash', 'http://127.0.0.1:54321\\', 'http://127.0.0.1:54321'],
    ['empty userinfo', 'http://@127.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['empty username and password', 'http://:@127.0.0.1:54321', 'http://127.0.0.1:54321'],
    ['dot-segment path', 'http://127.0.0.1:54321/a/..', 'http://127.0.0.1:54321'],
    ['encoded dot-segment path', 'http://127.0.0.1:54321/%2e', 'http://127.0.0.1:54321'],
    ['empty query', 'http://127.0.0.1:54321?', 'http://127.0.0.1:54321'],
    ['empty fragment', 'http://127.0.0.1:54321#', 'http://127.0.0.1:54321'],
    ['empty query and fragment', 'http://127.0.0.1:54321?#', 'http://127.0.0.1:54321'],
    ['expanded IPv6', 'http://[0:0:0:0:0:0:0:1]:54321', 'http://[::1]:54321'],
    ['fullwidth localhost', 'http://ｌｏｃａｌｈｏｓｔ:54321', 'http://localhost:54321'],
    ['control-character stripping', 'http://local\thost:54321', 'http://localhost:54321'],
    ['case normalization', 'HTTP://LOCALHOST:54321', 'http://localhost:54321'],
    ['empty port', 'http://127.0.0.1:', 'http://127.0.0.1'],
    ['leading-zero port', 'http://127.0.0.1:05432', 'http://127.0.0.1:5432'],
    ['trailing root slash', 'http://127.0.0.1:54321/', 'http://127.0.0.1:54321'],
    ['surrounding whitespace', ' http://127.0.0.1:54321 ', 'http://127.0.0.1:54321']
  ];

  for (const [name, projectUrl, canonicalProjectUrl] of canonicalizingInputs) {
    assert.notEqual(projectUrl, canonicalProjectUrl, name + ' must mutate the literal input');
    assert.deepEqual(
      urlSecurityView(projectUrl),
      urlSecurityView(canonicalProjectUrl),
      name + ' must reproduce the parse-only validation weakness'
    );
    assert.throws(() => auth.normalizeConfig({ projectUrl, publishableKey: 'publishable' }),
      error => error.code === 'config_invalid', name + ' must be rejected despite canonicalization');
  }
});

test('the documented local workflow signs in, restores a session, and signs out', async () => {
  // The whole point of the local origin: the real service, built from the real
  // local configuration, drives sign-in, session restore and sign-out.
  const localConfig = { projectUrl: 'http://127.0.0.1:54321', publishableKey: 'publishable' };
  const fixture = clientWith({
    signInResult: { data: { user: { id: 'u1', email: 'smoke_test_admin@local.invalid' } }, error: null },
    sessionResult: { data: { session: { user: { id: 'u1', email: 'smoke_test_admin@local.invalid' } } }, error: null },
    profileResult: { data: { username: 'SMOKE_TEST_admin', name: 'Admin', role: 'admin', lang: 'ru', is_active: true }, error: null }
  });
  let received;
  const service = auth.createBrowserAuthService(localConfig, {
    createClient(...args) { received = args; return fixture.client; }
  }, { getItem() {}, setItem() {}, removeItem() {} });

  assert.equal(received[0], 'http://127.0.0.1:54321');
  assert.equal(received[2].auth.persistSession, true);

  const signedIn = await service.signIn('smoke_test_admin@local.invalid', 'password');
  assert.equal(signedIn.role, 'admin');
  assert.equal((await service.getCurrentUser()).id, 'u1');
  await service.signOut();
  assert.equal(fixture.calls.signOut, 1);
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
