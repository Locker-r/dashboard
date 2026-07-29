(function exposeTestDataCleanup(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationTestDataCleanup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTestDataCleanup() {
  'use strict';

  const TEST_EMAIL_PATTERN = /^test(0[1-9]|[12][0-9]|30)@example\.com$/i;
  const CONFIRMATION_PHRASE = 'DELETE 30 TEST PLAYERS';

  function list(value) { return Array.isArray(value) ? value : []; }
  function id(value) { return String(value == null ? '' : value).trim(); }
  function isTestPlayer(player) { return TEST_EMAIL_PATTERN.test(String(player && player.email || '').trim()); }
  function playerReferences(player) {
    const references = new Set();
    const agentId = id(player && player.agentId);
    if (agentId) references.add(agentId);
    list(player && player.comments).forEach(comment => { const value = id(comment && comment.authorId); if (value) references.add(value); });
    list(player && player.statusHistory).forEach(event => { const value = id(event && event.userId); if (value) references.add(value); });
    return references;
  }

  function preview(players, users) {
    const allPlayers = list(players), allUsers = list(users);
    const testPlayers = allPlayers.filter(isTestPlayer);
    const otherPlayers = allPlayers.filter(player => !isTestPlayer(player));
    const testUserIds = new Set();
    const testAgentIds = new Set();
    testPlayers.forEach(player => {
      const agentId = id(player && player.agentId);
      if (agentId) testAgentIds.add(agentId);
      playerReferences(player).forEach(value => testUserIds.add(value));
    });
    const sharedUserIds = new Set();
    let otherPlayersUsingTestUsers = 0;
    let otherPlayersUsingTestAgents = 0;
    otherPlayers.forEach(player => {
      const references = playerReferences(player);
      if ([...references].some(value => testUserIds.has(value))) {
        otherPlayersUsingTestUsers++;
        references.forEach(value => { if (testUserIds.has(value)) sharedUserIds.add(value); });
      }
      if (testAgentIds.has(id(player && player.agentId))) otherPlayersUsingTestAgents++;
    });
    const usersById = new Map(allUsers.map(user => [id(user && user.id), user]));
    const removableUserIds = [...testUserIds].filter(value => {
      const user = usersById.get(value);
      return user && user.role !== 'admin' && !sharedUserIds.has(value);
    });
    const adminsAfter = allUsers.filter(user => user && user.role === 'admin').length;
    return {
      counts: {
        testPlayers: testPlayers.length,
        historyEvents: testPlayers.reduce((sum, player) => sum + list(player && player.statusHistory).length, 0),
        comments: testPlayers.reduce((sum, player) => sum + list(player && player.comments).length, 0),
        referencedUsers: testUserIds.size,
        otherPlayersUsingReferencedUsers: otherPlayersUsingTestUsers,
        removableUsers: removableUserIds.length,
        adminsPreserved: adminsAfter,
        remainingPlayers: otherPlayers.length
      },
      eligible: testPlayers.length === 30 && otherPlayersUsingTestAgents === 0 && adminsAfter > 0,
      testPlayerIds: new Set(testPlayers.map(player => id(player && player.id))),
      removableUserIds: new Set(removableUserIds)
    };
  }

  function clean(players, users, phrase) {
    const plan = preview(players, users);
    if (!plan.eligible) return { ok: false, reason: 'preconditions_failed', plan };
    if (phrase !== CONFIRMATION_PHRASE) return { ok: false, reason: 'confirmation_failed', plan };
    const cleanedPlayers = list(players).filter(player => !isTestPlayer(player));
    const remainingReferences = new Set();
    cleanedPlayers.forEach(player => playerReferences(player).forEach(value => remainingReferences.add(value)));
    const cleanedUsers = list(users).filter(user => {
      const userId = id(user && user.id);
      if (user && user.role === 'admin') return true;
      return !plan.removableUserIds.has(userId) || remainingReferences.has(userId);
    });
    if (!cleanedUsers.some(user => user && user.role === 'admin')) return { ok: false, reason: 'admin_required', plan };
    return { ok: true, players: cleanedPlayers, users: cleanedUsers, before: plan, after: preview(cleanedPlayers, cleanedUsers) };
  }

  return Object.freeze({ TEST_EMAIL_PATTERN, CONFIRMATION_PHRASE, isTestPlayer, preview, clean });
});
