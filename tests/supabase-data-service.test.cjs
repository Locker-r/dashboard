const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/data/supabase-data-service.js');

function clientWith(results, authOverrides = {}) {
  const calls = { tables: [], signOut: 0 };
  const client = {
    from(table) {
      calls.tables.push(table);
      const result = results[table] || { data: [], error: null };
      return {
        select() {
          return {
            then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
            order() { return Promise.resolve(result); },
            eq() {
              return { maybeSingle: async () => result };
            }
          };
        }
      };
    },
    auth: {
      async getSession() { return { data: { session: null }, error: null }; },
      async signOut() { calls.signOut += 1; return { error: null }; },
      ...authOverrides
    }
  };
  return { client, calls };
}

test('maps profiles to the Dashboard user model', async () => {
  const fixture = clientWith({ profiles: { data: [{
    id: 'profile-1', username: 'agent', name: 'Synthetic Agent', role: 'agent', lang: 'es',
    is_active: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z'
  }], error: null } });
  assert.deepEqual(await new data.SupabaseDataService(fixture.client).loadUsers(), [{
    id: 'profile-1', username: 'agent', name: 'Synthetic Agent', role: 'agent', lang: 'es', isActive: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z'
  }]);
});

test('maps players with comments and status history', async () => {
  const fixture = clientWith({
    players: { data: [{ id: 'player-1', phone: '', email: '', messenger: '', status: 'in_work', agent_id: 'profile-1', imported_at: 'i', updated_at: 'u', follow_up_at: 'f' }], error: null },
    player_comments: { data: [{ id: 'comment-1', player_id: 'player-1', text: 'Synthetic', created_at: 'c', author_id: 'profile-1', author_name: 'Agent', author_role: 'agent' }], error: null },
    player_status_history: { data: [{ id: 'history-1', player_id: 'player-1', from_status: 'assigned', to_status: 'in_work', changed_at: 'h', user_id: 'profile-1', user_name: 'Agent', user_role: 'agent' }], error: null }
  });
  const players = await new data.SupabaseDataService(fixture.client).loadPlayers();
  assert.equal(players.length, 1);
  assert.equal(players[0].agentId, 'profile-1');
  assert.equal(players[0].comments[0].authorId, 'profile-1');
  assert.equal(players[0].statusHistory[0].fromStatus, 'assigned');
});

test('normalizes nullable fields and ignores orphan activity rows', async () => {
  const fixture = clientWith({
    players: { data: [{ id: 'player-1', phone: null, email: null, messenger: null, status: null, agent_id: null, imported_at: null, updated_at: null, follow_up_at: null }, null], error: null },
    player_comments: { data: [{ id: 'orphan', player_id: null }], error: null },
    player_status_history: { data: null, error: null }
  });
  const [player] = await new data.SupabaseDataService(fixture.client).loadPlayers();
  assert.deepEqual({ phone: player.phone, email: player.email, messenger: player.messenger, status: player.status, agentId: player.agentId, followUpAt: player.followUpAt },
    { phone: '', email: '', messenger: '', status: 'new', agentId: null, followUpAt: null });
  assert.deepEqual(player.comments, []);
  assert.deepEqual(player.statusHistory, []);
});

test('does not hide Supabase read errors', async () => {
  const expected = Object.assign(new Error('Synthetic database failure'), { code: 'TEST_DB_ERROR' });
  const fixture = clientWith({ profiles: { data: null, error: expected } });
  await assert.rejects(() => new data.SupabaseDataService(fixture.client).loadUsers(), error => error === expected);
});

test('rejects all direct save methods with READ_ONLY', async () => {
  const service = new data.SupabaseDataService(clientWith({}).client);
  await assert.rejects(() => service.saveUsers([]), error => error.code === 'READ_ONLY');
  await assert.rejects(() => service.savePlayers([]), error => error.code === 'READ_ONLY');
  await assert.rejects(() => service.saveCurrentUser(null), error => error.code === 'READ_ONLY');
});

test('clearSession delegates to Supabase Auth signOut and propagates its error', async () => {
  let fixture = clientWith({});
  await new data.SupabaseDataService(fixture.client).clearSession();
  assert.equal(fixture.calls.signOut, 1);
  const expected = new Error('Synthetic sign out failure');
  fixture = clientWith({}, { async signOut() { return { error: expected }; } });
  await assert.rejects(() => new data.SupabaseDataService(fixture.client).clearSession(), error => error === expected);
});
