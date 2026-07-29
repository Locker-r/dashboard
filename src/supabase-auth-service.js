(function exposeSupabaseAuth(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationSupabaseAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSupabaseAuthModule() {
  'use strict';

  const AUTH_STORAGE_KEY = 'reactivation-desk-supabase-auth';

  class AuthServiceError extends Error {
    constructor(code, cause) {
      super(code);
      this.name = 'AuthServiceError';
      this.code = code;
      this.cause = cause;
    }
  }

  function normalizeConfig(config) {
    if (!config || typeof config.projectUrl !== 'string' || typeof config.publishableKey !== 'string' ||
        !config.projectUrl.trim() || !config.publishableKey.trim()) {
      throw new AuthServiceError('config_missing');
    }
    const projectUrl = config.projectUrl.trim();
    const publishableKey = config.publishableKey.trim();
    let parsed;
    try { parsed = new URL(projectUrl); } catch (error) { throw new AuthServiceError('config_invalid', error); }
    const isProjectRoot = parsed.protocol === 'https:' &&
      /^[a-z0-9]+\.supabase\.co$/i.test(parsed.hostname) &&
      (parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash;
    if (!isProjectRoot) throw new AuthServiceError('config_invalid');
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
