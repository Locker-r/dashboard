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

  function list(value) { return Array.isArray(value) ? value : []; }
  function stringOrEmpty(value) { return value == null ? '' : String(value); }

  function mapProfile(row) {
    return {
      id: row.id,
      username: stringOrEmpty(row.username),
      name: stringOrEmpty(row.name),
      role: row.role || 'agent',
      lang: row.lang || 'ru',
      country: stringOrEmpty(row.country),
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

  // Contacts arrive already masked from public.players_secure. Raw phone/email/messenger are never
  // selected and are never placed on the player object, so no browser collection can hold them.
  function mapPlayer(row, comments, history) {
    return {
      id: row.id,
      phoneDisplay: stringOrEmpty(row.phone_display),
      emailDisplay: stringOrEmpty(row.email_display),
      messengerDisplay: stringOrEmpty(row.messenger_display),
      hasPhone: row.has_phone === true,
      hasEmail: row.has_email === true,
      hasMessenger: row.has_messenger === true,
      contactAccessState: row.contact_access_state === 'eligible' ? 'eligible' : 'locked',
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

  async function callRpc(client, name, parameters) {
    const result = await client.rpc(name, parameters);
    if (result.error) throw result.error;
    return result.data;
  }

  // Maps ONLY the eight approved columns of reveal_player_contacts. Nothing else is read -- not reason_code,
  // not channels, not player_status -- so a future widening of the RPC cannot start flowing into the browser
  // unnoticed. `outcome` is preserved verbatim: a transport success is not a reveal, and the caller decides.
  // Deliberately kept out of the mapPlayer..unwrap region: that span is the contact-boundary test's proof
  // that no raw contact is ever mapped onto a player object, and this is the one mapper that carries them.
  function mapReveal(row) {
    return {
      playerId: stringOrEmpty(row.player_id),
      outcome: stringOrEmpty(row.outcome),
      phone: stringOrEmpty(row.phone),
      email: stringOrEmpty(row.email),
      messenger: stringOrEmpty(row.messenger),
      revealedAt: row.revealed_at || null,
      requestId: stringOrEmpty(row.request_id),
      accessEventId: stringOrEmpty(row.access_event_id)
    };
  }

  // Proof rows carry no contact value, so they map outside the mapPlayer..unwrap
  // region that the contact-boundary test treats as its no-raw-contact span.
  function mapProof(row) {
    return {
      id: row.id,
      playerId: stringOrEmpty(row.player_id),
      uploadedBy: row.uploaded_by || '',
      storageBucket: stringOrEmpty(row.storage_bucket),
      storagePath: stringOrEmpty(row.storage_path),
      originalFilename: stringOrEmpty(row.original_filename),
      mimeType: stringOrEmpty(row.mime_type),
      fileSize: row.verified_file_size == null ? Number(row.declared_file_size) || 0 : Number(row.verified_file_size),
      state: row.state === 'active' ? 'active' : (row.state === 'discarded' ? 'discarded' : 'pending'),
      createdAt: row.created_at || null,
      confirmedAt: row.confirmed_at || null
    };
  }

  class SupabaseDataService extends DataService {
    constructor(client) {
      super();
      if (!client || typeof client.from !== 'function' || !client.auth) throw new Error('SUPABASE_CLIENT_REQUIRED');
      this.client = client;
    }

    async loadUsers() {
      const rows = await unwrap(this.client.from('profiles').select('id,username,name,role,lang,country,is_active,created_at,updated_at'));
      return rows.filter(row => row && row.id).map(mapProfile);
    }

    async loadPlayers() {
      const [players, comments, history] = await Promise.all([
        unwrap(this.client.from('players_secure').select('id,status,agent_id,imported_at,updated_at,follow_up_at,phone_display,email_display,messenger_display,has_phone,has_email,has_messenger,contact_access_state')),
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

    async saveUsers() { throw Object.assign(new Error('RPC_REQUIRED'), { code: 'RPC_REQUIRED' }); }
    async savePlayers() { throw Object.assign(new Error('RPC_REQUIRED'), { code: 'RPC_REQUIRED' }); }
    async saveCurrentUser() { throw Object.assign(new Error('RPC_REQUIRED'), { code: 'RPC_REQUIRED' }); }
    canInitializeUsers() { return false; }

    async createPlayers(items) {
      return callRpc(this.client, 'create_players_atomic', { p_players: list(items).map(player => ({
        id: player.id, phone: stringOrEmpty(player.phone), email: stringOrEmpty(player.email),
        messenger: stringOrEmpty(player.messenger), imported_at: player.importedAt ? new Date(player.importedAt).toISOString() : null
      })) });
    }

    async assignPlayers(playerIds, agentIds, options) {
      return callRpc(this.client, 'assign_players_atomic', {
        p_player_ids: list(playerIds), p_agent_ids: list(agentIds),
        p_confirm_final: Boolean(options && options.adminConfirmed)
      });
    }

    async changePlayerStatus(playerId, nextStatus, historyId, options) {
      return callRpc(this.client, 'change_player_status_atomic', {
        p_player_id: playerId, p_next_status: nextStatus, p_history_id: historyId,
        p_confirm_reopen: Boolean(options && options.adminConfirmed)
      });
    }

    async addPlayerComment(playerId, commentId, text) {
      return callRpc(this.client, 'add_player_comment_atomic', {
        p_player_id: playerId, p_comment_id: commentId, p_text: text
      });
    }

    // Import duplicate detection runs inside PostgreSQL and returns only match metadata.
    async checkPlayerDuplicates(candidates) {
      return callRpc(this.client, 'check_player_duplicates', { p_candidates: list(candidates).map(item => ({
        id: item && item.id != null ? String(item.id) : null,
        phone: stringOrEmpty(item && item.phone),
        email: stringOrEmpty(item && item.email),
        messenger: stringOrEmpty(item && item.messenger)
      })) });
    }

    async setPlayerFollowUp(playerId, followUpAt) {
      return callRpc(this.client, 'set_player_follow_up_atomic', {
        p_player_id: playerId, p_follow_up_at: followUpAt || null
      });
    }

    // The audited reveal. Errors propagate untouched (they carry no contact value); every controlled
    // business outcome arrives as a normal row and is classified by the caller, never here.
    async revealPlayerContacts(playerId, requestId) {
      const data = await callRpc(this.client, 'reveal_player_contacts', {
        p_player_id: playerId, p_request_id: requestId
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== 'object' || !row.outcome) {
        throw Object.assign(new Error('REVEAL_CONTRACT_VIOLATION'), { code: 'REVEAL_CONTRACT_VIOLATION' });
      }
      return mapReveal(row);
    }

    // Proof rows are readable only through RLS: an admin, or the agent the lead
    // is assigned to. Discarded rows are filtered here for display; the server
    // still refuses to let one authorise a close.
    async loadProofs() {
      const rows = await unwrap(this.client.from('lead_proofs')
        .select('id,player_id,uploaded_by,storage_bucket,storage_path,original_filename,mime_type,declared_file_size,verified_file_size,state,created_at,confirmed_at')
        .neq('state', 'discarded')
        .order('created_at', { ascending: false }));
      return rows.filter(row => row && row.id).map(mapProof);
    }

    // Step 1 of the upload: the server decides whether this caller may attach a
    // proof to this lead and returns the only storage path it will accept.
    async requestProofUpload(playerId, proofId, filename, mimeType, fileSize) {
      const data = await callRpc(this.client, 'request_lead_proof_upload', {
        p_player_id: playerId, p_proof_id: proofId, p_filename: filename,
        p_mime_type: mimeType, p_file_size: fileSize
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== 'object' || !row.storage_path) {
        throw Object.assign(new Error('PROOF_CONTRACT_VIOLATION'), { code: 'PROOF_CONTRACT_VIOLATION' });
      }
      return mapProof(row);
    }

    // Step 2: the bytes. The path came from the server, never from the caller.
    async uploadProofObject(proof, file) {
      const result = await this.client.storage.from(proof.storageBucket).upload(proof.storagePath, file, {
        contentType: proof.mimeType, upsert: true
      });
      if (result.error) throw result.error;
      return true;
    }

    // Step 3: the server re-reads the stored object and only then activates the
    // proof. Until this succeeds the lead cannot be closed.
    async confirmProof(proofId) {
      const data = await callRpc(this.client, 'confirm_lead_proof', { p_proof_id: proofId });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== 'object' || row.state !== 'active') {
        throw Object.assign(new Error('PROOF_NOT_READY'), { code: 'PROOF_NOT_READY' });
      }
      return mapProof(row);
    }

    async discardProof(proofId) {
      const data = await callRpc(this.client, 'discard_lead_proof', { p_proof_id: proofId });
      const row = Array.isArray(data) ? data[0] : data;
      return row && typeof row === 'object' ? mapProof(row) : null;
    }

    // Reads are short-lived signed URLs. Nothing durable is stored, and the URL
    // is requested again whenever it is needed.
    async createProofUrl(proof, expiresInSeconds) {
      const result = await this.client.storage.from(proof.storageBucket)
        .createSignedUrl(proof.storagePath, Math.max(30, Number(expiresInSeconds) || 120));
      if (result.error) throw result.error;
      const url = result.data && result.data.signedUrl;
      if (!url) throw Object.assign(new Error('PROOF_URL_UNAVAILABLE'), { code: 'PROOF_URL_UNAVAILABLE' });
      return url;
    }

    async getCurrentUser() {
      const sessionResult = await this.client.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      const user = sessionResult.data && sessionResult.data.session && sessionResult.data.session.user;
      if (!user) return null;
      const result = await this.client.from('profiles').select('id,username,name,role,lang,country,is_active,created_at,updated_at').eq('id', user.id).maybeSingle();
      if (result.error) throw result.error;
      return result.data ? mapProfile(result.data) : null;
    }

    async clearSession() {
      const result = await this.client.auth.signOut();
      if (result && result.error) throw result.error;
    }
  }

  return { SupabaseDataService, mapProfile, mapComment, mapHistory, mapPlayer, mapReveal, mapProof, callRpc };
});
