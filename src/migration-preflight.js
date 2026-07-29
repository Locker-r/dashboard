(function exposeMigrationPreflight(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationMigrationPreflight = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMigrationPreflight() {
  'use strict';

  const STATUSES = new Set(['new', 'assigned', 'in_work', 'no_answer', 'success', 'failed']);
  const ROLES = new Set(['admin', 'agent']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SECRET_USER_FIELDS = new Set(['salt', 'passwordHash', 'securitySalt', 'securityAnswerHash']);

  function list(value) { return Array.isArray(value) ? value : []; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function normalizeEmail(value) { return text(value).toLowerCase(); }
  function normalizeMessenger(value) {
    const normalized = text(value).toLowerCase();
    const channelLabel = normalized.replace(/\s+/g, ' ');
    return ['', 'whatsapp', 'telegram', 'whats app', 'wa', 'tg'].includes(channelLabel) ? '' : normalized;
  }
  function normalizePhone(value) {
    let result = text(value).replace(/\D/g, '');
    if (result.startsWith('00')) result = result.slice(2);
    return result;
  }
  function contactKeys(player) {
    const keys = [];
    const phone = normalizePhone(player && player.phone);
    const email = normalizeEmail(player && player.email);
    const messenger = normalizeMessenger(player && player.messenger);
    if (phone) keys.push(`phone:${phone}`);
    if (email) keys.push(`email:${email}`);
    if (messenger) keys.push(`messenger:${messenger}`);
    return keys;
  }
  function iso(value) {
    const number = typeof value === 'number' ? value : NaN;
    const date = new Date(Number.isFinite(number) ? number : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  function safeClone(value) { return JSON.parse(JSON.stringify(value)); }

  function createRecoveryBackup(players, users, now) {
    return {
      format: 'reactivation-desk-local-recovery', version: 1, sensitive: true,
      createdAt: new Date(now || Date.now()).toISOString(),
      storage: { 'crm-data': { players: safeClone(list(players)) }, 'crm-users': safeClone(list(users)) }
    };
  }

  function createSanitizedSnapshot(players, users, now) {
    const sanitizedUsers = list(users).map(user => Object.fromEntries(
      Object.entries(user && typeof user === 'object' ? user : {}).filter(([key]) => !SECRET_USER_FIELDS.has(key))
    ));
    return {
      format: 'reactivation-desk-migration-snapshot', version: 1, sensitive: true,
      createdAt: new Date(now || Date.now()).toISOString(),
      data: { players: safeClone(list(players)) }, users: sanitizedUsers
    };
  }

  function mappingState(users, profiles, mapping) {
    const profileById = new Map(list(profiles).map(profile => [text(profile && profile.id), profile]));
    const normalizedProfiles = new Map();
    list(profiles).forEach(profile => {
      const key = normalizeEmail(profile && profile.username);
      if (!normalizedProfiles.has(key)) normalizedProfiles.set(key, []);
      normalizedProfiles.get(key).push(profile);
    });
    const confirmed = new Map(), unmapped = [], ambiguous = [], suggestions = [];
    list(users).forEach(user => {
      const localId = text(user && user.id);
      const entry = mapping && mapping[localId];
      if (entry && entry.confirmed === true && UUID.test(text(entry.profileId)) && profileById.has(text(entry.profileId))) {
        confirmed.set(localId, text(entry.profileId));
      } else {
        unmapped.push(localId);
        const candidates = normalizedProfiles.get(normalizeEmail(user && user.username)) || [];
        if (candidates.length === 1) suggestions.push({ localUserId: localId, candidateCount: 1 });
        if (candidates.length > 1) ambiguous.push(localId);
      }
    });
    return { confirmed, unmapped, ambiguous, suggestions };
  }

  function transformPlayer(player, profileIdByLocalId) {
    const errors = [];
    const id = text(player && player.id);
    if (!id) errors.push('id_missing');
    if (!contactKeys(player).length) errors.push('contact_missing');
    if (!STATUSES.has(player && player.status)) errors.push('status_invalid');
    const importedAt = iso(player && player.importedAt);
    const updatedAt = iso(player && player.updatedAt);
    const followUpAt = player && player.followUpAt ? iso(player.followUpAt) : null;
    if (!importedAt) errors.push('imported_at_invalid');
    if (!updatedAt) errors.push('updated_at_invalid');
    if (player && player.followUpAt && !followUpAt) errors.push('follow_up_at_invalid');
    const localAgentId = text(player && player.agentId);
    const agentId = localAgentId ? profileIdByLocalId.get(localAgentId) || null : null;
    if (localAgentId && !agentId) errors.push('agent_mapping_missing');
    return { errors, row: { id, phone: text(player && player.phone), email: text(player && player.email), messenger: text(player && player.messenger), status: player && player.status, agent_id: agentId, imported_at: importedAt, updated_at: updatedAt, follow_up_at: followUpAt, created_by: null } };
  }

  function transformComment(comment, playerId, profileIdByLocalId) {
    const errors = [], id = text(comment && comment.id), body = text(comment && comment.text);
    if (!id) errors.push('comment_id_missing');
    if (!body || body.length > 5000) errors.push('comment_text_invalid');
    const createdAt = iso(comment && comment.createdAt);
    if (!createdAt) errors.push('comment_created_at_invalid');
    const localAuthorId = text(comment && comment.authorId);
    const authorId = localAuthorId ? profileIdByLocalId.get(localAuthorId) || null : null;
    if (localAuthorId && !authorId) errors.push('comment_author_mapping_missing');
    if (!ROLES.has(comment && comment.authorRole)) errors.push('comment_author_role_invalid');
    return { errors, row: { id, player_id: playerId, text: body, created_at: createdAt, author_id: authorId, author_name: text(comment && comment.authorName), author_role: comment && comment.authorRole } };
  }

  function transformHistory(event, playerId, profileIdByLocalId) {
    const errors = [], id = text(event && event.id);
    if (!id) errors.push('history_id_missing');
    if (event && event.fromStatus && !STATUSES.has(event.fromStatus)) errors.push('history_from_status_invalid');
    if (!STATUSES.has(event && event.toStatus)) errors.push('history_to_status_invalid');
    const changedAt = iso(event && event.changedAt);
    if (!changedAt) errors.push('history_changed_at_invalid');
    const localUserId = text(event && event.userId);
    const userId = localUserId ? profileIdByLocalId.get(localUserId) || null : null;
    if (localUserId && !userId) errors.push('history_user_mapping_missing');
    if (!ROLES.has(event && event.userRole)) errors.push('history_user_role_invalid');
    return { errors, row: { id, player_id: playerId, from_status: event && event.fromStatus || null, to_status: event && event.toStatus, changed_at: changedAt, user_id: userId, user_name: text(event && event.userName), user_role: event && event.userRole } };
  }

  function dryRun(input) {
    const source = input || {}, players = list(source.players), users = list(source.users);
    const map = mappingState(users, source.profiles, source.userMapping || {});
    const remotePlayers = list(source.remotePlayers), remoteIds = new Set(remotePlayers.map(row => text(row && row.id)));
    const remoteContacts = new Map();
    remotePlayers.forEach(row => contactKeys(row).forEach(key => { if (!remoteContacts.has(key)) remoteContacts.set(key, new Set()); remoteContacts.get(key).add(text(row.id)); }));
    const localContacts = new Map(), localIds = new Set(), knownLocalUsers = new Set(users.map(user => text(user && user.id)));
    const results = [], issueCounts = {}, blockedReferences = new Set();
    function issue(code) { issueCounts[code] = (issueCounts[code] || 0) + 1; }
    players.forEach(player => {
      const transformed = transformPlayer(player, map.confirmed);
      const id = transformed.row.id, keys = contactKeys(player);
      const exactIdDuplicate = remoteIds.has(id);
      const contactDuplicate = keys.some(key => remoteContacts.has(key) && [...remoteContacts.get(key)].some(otherId => otherId !== id));
      const duplicateInsideLocal = localIds.has(id) || keys.some(key => localContacts.has(key));
      localIds.add(id); keys.forEach(key => localContacts.set(key, id));
      transformed.errors.forEach(issue);
      const localAgentId = text(player && player.agentId);
      if (localAgentId && !knownLocalUsers.has(localAgentId)) { issue('agent_local_user_missing'); blockedReferences.add(localAgentId); }
      const classification = exactIdDuplicate ? 'exact_id_duplicate' : contactDuplicate ? 'contact_duplicate' : duplicateInsideLocal ? 'duplicate_inside_local' : 'clean_record';
      results.push({ classification, valid: transformed.errors.length === 0, blocked: transformed.errors.some(code => code.includes('mapping_missing')), row: transformed.row });
    });
    const remoteCommentIds = new Set(list(source.remoteComments).map(row => text(row && row.id)));
    const remoteHistoryIds = new Set(list(source.remoteHistory).map(row => text(row && row.id)));
    const comments = [], history = [];
    players.forEach(player => {
      list(player && player.comments).forEach(comment => {
        const transformed = transformComment(comment, text(player && player.id), map.confirmed);
        const ref = text(comment && comment.authorId);
        if (ref && !knownLocalUsers.has(ref)) { issue('comment_local_user_missing'); blockedReferences.add(ref); }
        transformed.errors.forEach(issue); comments.push({ ...transformed, exactIdDuplicate: remoteCommentIds.has(transformed.row.id) });
      });
      list(player && player.statusHistory).forEach(event => {
        const transformed = transformHistory(event, text(player && player.id), map.confirmed);
        const ref = text(event && event.userId);
        if (ref && !knownLocalUsers.has(ref)) { issue('history_local_user_missing'); blockedReferences.add(ref); }
        transformed.errors.forEach(issue); history.push({ ...transformed, exactIdDuplicate: remoteHistoryIds.has(transformed.row.id) });
      });
    });
    const classifications = Object.fromEntries(['exact_id_duplicate','contact_duplicate','duplicate_inside_local','clean_record'].map(key => [key, results.filter(row => row.classification === key).length]));
    return {
      summary: {
        localUsers: users.length, confirmedMappings: map.confirmed.size, unmappedUsers: map.unmapped.length,
        ambiguousMappings: map.ambiguous.length, suggestedMappings: map.suggestions.length, missingUserReferences: blockedReferences.size,
        players: players.length, validPlayers: results.filter(row => row.valid).length, invalidPlayers: results.filter(row => !row.valid).length,
        blockedPlayers: results.filter(row => row.blocked).length, comments: comments.length,
        validComments: comments.filter(row => !row.errors.length).length, blockedComments: comments.filter(row => row.errors.some(code => code.includes('mapping_missing'))).length,
        exactCommentIdDuplicates: comments.filter(row => row.exactIdDuplicate).length,
        history: history.length, validHistory: history.filter(row => !row.errors.length).length, blockedHistory: history.filter(row => row.errors.some(code => code.includes('mapping_missing'))).length,
        exactHistoryIdDuplicates: history.filter(row => row.exactIdDuplicate).length,
        ...classifications, schemaCreatedByNullable: true
      },
      issueCounts, suggestions: map.suggestions,
      migrationBlocked: map.unmapped.length > 0 || map.ambiguous.length > 0 || blockedReferences.size > 0 ||
        results.some(row => !row.valid || row.classification !== 'clean_record') ||
        comments.some(row => row.errors.length || row.exactIdDuplicate) || history.some(row => row.errors.length || row.exactIdDuplicate),
      transformed: { players: results, comments, history }
    };
  }

  return Object.freeze({ normalizePhone, normalizeEmail, normalizeMessenger, contactKeys, iso, createRecoveryBackup, createSanitizedSnapshot, mappingState, transformPlayer, transformComment, transformHistory, dryRun });
});
