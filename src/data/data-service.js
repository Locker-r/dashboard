(function exposeDataService(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationData = Object.assign(root.ReactivationData || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDataServiceContract() {
  'use strict';

  class DataService {
    async loadUsers() { throw new Error('loadUsers() is not implemented'); }
    async saveUsers(_users) { throw new Error('saveUsers() is not implemented'); }
    canInitializeUsers() { return false; }
    async loadPlayers() { throw new Error('loadPlayers() is not implemented'); }
    async savePlayers(_players) { throw new Error('savePlayers() is not implemented'); }
    async getCurrentUser() { throw new Error('getCurrentUser() is not implemented'); }
    async saveCurrentUser(_user) { throw new Error('saveCurrentUser() is not implemented'); }
    async createPlayers(_players) { throw new Error('createPlayers() is not implemented'); }
    async assignPlayers(_playerIds, _agentIds, _options) { throw new Error('assignPlayers() is not implemented'); }
    async changePlayerStatus(_playerId, _nextStatus, _historyId, _options) { throw new Error('changePlayerStatus() is not implemented'); }
    async addPlayerComment(_playerId, _commentId, _text) { throw new Error('addPlayerComment() is not implemented'); }
    async setPlayerFollowUp(_playerId, _followUpAt) { throw new Error('setPlayerFollowUp() is not implemented'); }
    async clearSession() { throw new Error('clearSession() is not implemented'); }
  }

  return { DataService };
});
