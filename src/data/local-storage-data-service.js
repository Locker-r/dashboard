(function exposeLocalStorageDataService(root, factory) {
  const dependencies = typeof module === 'object' && module.exports
    ? require('./data-service.js')
    : root.ReactivationData;
  const api = factory(dependencies, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationData = Object.assign(root.ReactivationData || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLocalStorageDataService(dependencies, root) {
  'use strict';

  const DataService = dependencies.DataService;
  const DEFAULT_STORAGE_KEYS = Object.freeze({ data: 'crm-data', users: 'crm-users' });

  class LocalStorageDataService extends DataService {
    constructor(options) {
      super();
      const config = options || {};
      this.localStorage = config.localStorage || null;
      this.hostStorage = config.hostStorage || null;
      this.keys = Object.assign({}, DEFAULT_STORAGE_KEYS, config.keys || {});
      this.currentUser = null;
      this.usersLoadState = 'unloaded';
    }

    async readStorageValue(key) {
      if (this.hostStorage && typeof this.hostStorage.get === 'function') {
        try {
          const result = await this.hostStorage.get(key, true);
          if (result && typeof result.value === 'string') {
            try { if (this.localStorage) this.localStorage.setItem(key, result.value); } catch (_error) {}
            return result.value;
          }
        } catch (_error) {}
      }
      try { return this.localStorage ? this.localStorage.getItem(key) : null; } catch (_error) { return null; }
    }

    async writeStorageValue(key, value) {
      let saved = false;
      if (this.hostStorage && typeof this.hostStorage.set === 'function') {
        try { await this.hostStorage.set(key, value, true); saved = true; } catch (_error) {}
      }
      try {
        if (this.localStorage) {
          this.localStorage.setItem(key, value);
          saved = true;
        }
      } catch (_error) {}
      if (!saved) throw new Error('Storage is unavailable');
    }

    parseArray(raw) {
      if (!raw) return [];
      try {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? value : [];
      } catch (_error) {
        return [];
      }
    }

    inspectArray(raw) {
      if (raw === null || typeof raw === 'undefined') return { state: 'missing', value: [] };
      if (typeof raw !== 'string') return { state: 'invalid', value: [] };
      try {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? { state: 'valid', value } : { state: 'invalid', value: [] };
      } catch (_error) {
        return { state: 'invalid', value: [] };
      }
    }

    async readHostValue(key) {
      if (!this.hostStorage || typeof this.hostStorage.get !== 'function') return null;
      try {
        const result = await this.hostStorage.get(key, true);
        return result && typeof result.value === 'string' ? result.value : null;
      } catch (_error) {
        return null;
      }
    }

    async loadUsers() {
      let localRaw = null;
      try { localRaw = this.localStorage ? this.localStorage.getItem(this.keys.users) : null; } catch (_error) {}
      const local = this.inspectArray(localRaw);
      const hostRaw = await this.readHostValue(this.keys.users);
      const host = this.inspectArray(hostRaw);
      if (local.state === 'valid') {
        this.usersLoadState = 'valid';
        return local.value;
      }
      if (local.state === 'invalid') {
        this.usersLoadState = 'invalid';
        return [];
      }
      if (host.state === 'valid') {
        this.usersLoadState = 'valid';
        try { if (this.localStorage) this.localStorage.setItem(this.keys.users, hostRaw); } catch (_error) {}
        return host.value;
      }
      this.usersLoadState = host.state === 'invalid' ? 'invalid' : 'missing';
      return [];
    }

    async saveUsers(users) {
      const safeUsers = Array.isArray(users) ? users : [];
      if (safeUsers.length === 0) {
        let localRaw = null;
        try { localRaw = this.localStorage ? this.localStorage.getItem(this.keys.users) : null; } catch (_error) {}
        const hostRaw = await this.readHostValue(this.keys.users);
        const existing = [this.inspectArray(localRaw), this.inspectArray(hostRaw)];
        if (existing.some(entry => entry.state === 'valid' && entry.value.length > 0)) {
          throw new Error('Refusing to replace non-empty users storage with an empty array');
        }
      }
      await this.writeStorageValue(this.keys.users, JSON.stringify(safeUsers));
      this.usersLoadState = 'valid';
    }

    canInitializeUsers() {
      return this.usersLoadState === 'missing' || this.usersLoadState === 'valid';
    }

    async loadPlayers() {
      const raw = await this.readStorageValue(this.keys.data);
      if (!raw) return [];
      try {
        const value = JSON.parse(raw);
        return value && Array.isArray(value.players) ? value.players : [];
      } catch (_error) {
        return [];
      }
    }

    async savePlayers(players) {
      const safePlayers = Array.isArray(players) ? players : [];
      await this.writeStorageValue(this.keys.data, JSON.stringify({ players: safePlayers }));
    }

    async getCurrentUser() {
      return this.currentUser;
    }

    async saveCurrentUser(user) {
      this.currentUser = user || null;
    }

    async clearSession() {
      this.currentUser = null;
    }
  }

  function createBrowserDataService(options) {
    let browserLocalStorage = null;
    let hostStorage = null;
    try { browserLocalStorage = root.localStorage || null; } catch (_error) {}
    try { hostStorage = root.storage || null; } catch (_error) {}
    return new LocalStorageDataService(Object.assign({}, options || {}, {
      localStorage: browserLocalStorage,
      hostStorage
    }));
  }

  return { DEFAULT_STORAGE_KEYS, LocalStorageDataService, createBrowserDataService };
});
