(function exposeSupabaseAuth(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationSupabaseAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSupabaseAuthModule() {
  'use strict';

  const AUTH_STORAGE_KEY = 'reactivation-desk-supabase-auth';

  // Exactly two project roots are accepted, and nothing else:
  //   - a hosted project root, https://<ref>.supabase.co
  //   - a local development root on an http loopback origin
  // The loopback form exists so the documented local workflow (npm run dev:local
  // against http://127.0.0.1:54321) can sign in with the real auth service. It is
  // restricted to literal loopback hosts, so this rule can never send credentials
  // off the machine, and it matches classifyProjectUrl in scripts/dev/doctor.cjs
  // so the diagnostic and the browser cannot disagree about what "local" means.
  // The published Pages artifact stays pinned to the hosted form independently,
  // by scripts/build-pages-artifact.cjs.
  const LITERAL_LOOPBACK_ROOTS = Object.freeze([
    Object.freeze({ origin: 'http://127.0.0.1', hostname: '127.0.0.1' }),
    Object.freeze({ origin: 'http://localhost', hostname: 'localhost' }),
    Object.freeze({ origin: 'http://[::1]', hostname: '[::1]' })
  ]);

  class AuthServiceError extends Error {
    constructor(code, cause) {
      super(code);
      this.name = 'AuthServiceError';
      this.code = code;
      this.cause = cause;
    }
  }

  function literalLoopbackHostname(raw) {
    // URL is still the semantic parser, but it cannot be the lexical authority:
    // WHATWG parsing erases alternate IPv4 spellings, backslashes, empty URL
    // components, dot segments, case differences, and other input distinctions.
    // Keep the deliberately tiny raw language authoritative despite parsing;
    // the only regex parses the optional canonical decimal port, not the URL or hostname.
    for (const candidate of LITERAL_LOOPBACK_ROOTS) {
      if (raw === candidate.origin) return candidate.hostname;
      const portPrefix = `${candidate.origin}:`;
      if (raw.startsWith(portPrefix) && /^(?:0|[1-9][0-9]{0,4})$/.test(raw.slice(portPrefix.length))) {
        return candidate.hostname;
      }
    }
    return null;
  }

  function isProjectRoot(raw, parsed) {
    // A project root carries no path, query, fragment, or credentials in either form.
    if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash ||
        parsed.username || parsed.password) {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol === 'https:') return /^[a-z0-9]+\.supabase\.co$/.test(hostname);
    return parsed.protocol === 'http:' && literalLoopbackHostname(raw) === hostname;
  }

  function normalizeConfig(config) {
    if (!config || typeof config.projectUrl !== 'string' || typeof config.publishableKey !== 'string' ||
        !config.projectUrl.trim() || !config.publishableKey.trim()) {
      throw new AuthServiceError('config_missing');
    }
    const projectUrlInput = config.projectUrl;
    const projectUrl = projectUrlInput.trim();
    const publishableKey = config.publishableKey.trim();
    let parsed;
    try { parsed = new URL(projectUrl); } catch (error) { throw new AuthServiceError('config_invalid', error); }
    if (!isProjectRoot(projectUrlInput, parsed)) throw new AuthServiceError('config_invalid');
    return { projectUrl: parsed.origin, publishableKey };
  }

  function isInactiveProfile(profile) {
    return profile.is_active === false || profile.active === false || profile.status === 'inactive';
  }

  function toCurrentUser(authUser, profile) {
    const email = String(authUser.email || '').trim();
    const username = String(profile.username || email.split('@')[0] || '').trim();
    return {
      id: authUser.id,
      email,
      username,
      name: String(profile.name || profile.full_name || profile.display_name || username).trim(),
      role: String(profile.role || 'agent'),
      lang: String(profile.lang || 'ru')
    };
  }

  function classifyError(error) {
    if (error instanceof AuthServiceError) return error;
    const message = String(error && error.message || '').toLowerCase();
    if (message.includes('invalid login credentials') || message.includes('invalid credentials')) {
      return new AuthServiceError('invalid_credentials', error);
    }
    if (error instanceof TypeError || message.includes('failed to fetch') || message.includes('network')) {
      return new AuthServiceError('network_error', error);
    }
    return new AuthServiceError('auth_error', error);
  }

  class SupabaseAuthService {
    constructor(client) {
      this.client = client;
    }

    async loadProfile(authUser) {
      try {
        if (!authUser || !authUser.id) throw new AuthServiceError('auth_error');
        const { data, error } = await this.client.from('profiles').select('*').eq('id', authUser.id).maybeSingle();
        if (error) throw new AuthServiceError('profile_load_error', error);
        if (!data) throw new AuthServiceError('profile_missing');
        if (data.id && data.id !== authUser.id) throw new AuthServiceError('profile_load_error');
        if (isInactiveProfile(data)) throw new AuthServiceError('profile_inactive');
        return toCurrentUser(authUser, data);
      } catch (error) {
        throw classifyError(error);
      }
    }

    async signIn(email, password) {
      try {
        const result = await this.client.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
        return await this.loadProfile(result.data.user);
      } catch (error) {
        const classified = classifyError(error);
        throw classified;
      }
    }

    async getCurrentUser() {
      try {
        const result = await this.client.auth.getSession();
        if (result.error) throw result.error;
        const session = result.data && result.data.session;
        if (!session || !session.user) return null;
        return await this.loadProfile(session.user);
      } catch (error) {
        const classified = classifyError(error);
        throw classified;
      }
    }

    async signOut() {
      try {
        const result = await this.client.auth.signOut();
        if (result.error) throw result.error;
      } catch (error) {
        throw classifyError(error);
      }
    }
  }

  function createBrowserAuthService(config, supabaseApi, storage) {
    const normalized = normalizeConfig(config);
    if (!supabaseApi || typeof supabaseApi.createClient !== 'function') {
      throw new AuthServiceError('client_missing');
    }
    const client = supabaseApi.createClient(normalized.projectUrl, normalized.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: AUTH_STORAGE_KEY,
        storage
      }
    });
    return new SupabaseAuthService(client);
  }

  return Object.freeze({ AUTH_STORAGE_KEY, AuthServiceError, SupabaseAuthService, classifyError, normalizeConfig, isInactiveProfile, toCurrentUser, createBrowserAuthService });
});
