(function exposeSupabaseDataService(root, factory) {
  const dependencies = typeof module === 'object' && module.exports
    ? require('./data-service.js')
    : root.ReactivationData;
  const api = factory(dependencies);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationData = Object.assign(root.ReactivationData || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSupabaseDataService(dependencies) {
  'use strict';

  const DataService = dependencies.DataService;

  class ReadOnlyDataError extends Error {
    constructor() {
      super('READ_ONLY');
      this.name = 'ReadOnlyDataError';
      this.code = 'READ_ONLY';
    }
  }

  function list(value) { return Array.isArray(value) ? value : []; }
  function stringOrEmpty(value) { return value == null ? '' : String(value); }

  function mapProfile(row) {
    return {
      id: row.id,
      username: stringOrEmpty(row.username),
      name: stringOrEmpty(row.name),
      role: row.role || 'agent',
      lang: row.lang || 'ru',
      isActive: row.is_active !== false,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }

  function mapComment(row) {
    return {
      id: row.id,
      text: stringOrEmpty(row.text),
      createdAt: row.created_at || null,
      authorId: row.author_id || '',
      authorName: stringOrEmpty(row.author_name),
      authorRole: row.author_role || 'agent'
    };
  }

  function mapHistory(row) {
    return {
      id: row.id,
      fromStatus: row.from_status || '',
      toStatus: row.to_status || '',
      changedAt: row.changed_at || null,
      userId: row.user_id || '',
      userName: stringOrEmpty(row.user_name),
      userRole: row.user_role || 'agent'
    };
  }

  function mapPlayer(row, comments, history) {
    return {
      id: row.id,
      phone: stringOrEmpty(row.phone),
      email: stringOrEmpty(row.email),
      messenger: stringOrEmpty(row.messenger),
      status: row.status || 'new',
      agentId: row.agent_id || null,
      importedAt: row.imported_at || null,
      updatedAt: row.updated_at || null,
      followUpAt: row.follow_up_at || null,
      comments: list(comments).map(mapComment),
      statusHistory: list(history).map(mapHistory)
    };
  }

  async function unwrap(query) {
    const result = await query;
    if (result.error) throw result.error;
    return list(result.data);
  }

  class SupabaseDataService extends DataService {
    constructor(client) {
      super();
      if (!client || typeof client.from !== 'function' || !client.auth) throw new Error('SUPABASE_CLIENT_REQUIRED');
      this.client = client;
    }

    async loadUsers() {
      const rows = await unwrap(this.client.from('profiles').select('id,username,name,role,lang,is_active,created_at,updated_at'));
      return rows.filter(row => row && row.id).map(mapProfile);
    }

    async loadPlayers() {
      const [players, comments, history] = await Promise.all([
        unwrap(this.client.from('players').select('id,phone,email,messenger,status,agent_id,imported_at,updated_at,follow_up_at')),
        unwrap(this.client.from('player_comments').select('id,player_id,text,created_at,author_id,author_name,author_role').order('created_at', { ascending: false })),
        unwrap(this.client.from('player_status_history').select('id,player_id,from_status,to_status,changed_at,user_id,user_name,user_role').order('changed_at', { ascending: false }))
      ]);
      const commentsByPlayer = new Map(), historyByPlayer = new Map();
      comments.forEach(row => {
        if (!row || !row.player_id) return;
        if (!commentsByPlayer.has(row.player_id)) commentsByPlayer.set(row.player_id, []);
        commentsByPlayer.get(row.player_id).push(row);
      });
      history.forEach(row => {
        if (!row || !row.player_id) return;
        if (!historyByPlayer.has(row.player_id)) historyByPlayer.set(row.player_id, []);
        historyByPlayer.get(row.player_id).push(row);
      });
      return players.filter(row => row && row.id).map(row => mapPlayer(row, commentsByPlayer.get(row.id), historyByPlayer.get(row.id)));
    }

    async saveUsers() { throw new ReadOnlyDataError(); }
    async savePlayers() { throw new ReadOnlyDataError(); }
    async saveCurrentUser() { throw new ReadOnlyDataError(); }
    canInitializeUsers() { return false; }

    async getCurrentUser() {
      const sessionResult = await this.client.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      const user = sessionResult.data && sessionResult.data.session && sessionResult.data.session.user;
      if (!user) return null;
      const result = await this.client.from('profiles').select('id,username,name,role,lang,is_active,created_at,updated_at').eq('id', user.id).maybeSingle();
      if (result.error) throw result.error;
      return result.data ? mapProfile(result.data) : null;
    }

    async clearSession() {
      const result = await this.client.auth.signOut();
      if (result && result.error) throw result.error;
    }
  }

  return { ReadOnlyDataError, SupabaseDataService, mapProfile, mapComment, mapHistory, mapPlayer };
});
