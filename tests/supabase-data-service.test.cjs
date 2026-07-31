const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/data/supabase-data-service.js');

function clientWith(results, authOverrides = {}) {
  const calls = { tables: [], rpcs: [], signOut: 0 };
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
    async rpc(name, parameters) { calls.rpcs.push({ name, parameters }); return { data: { ok: true }, error: null }; },
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
    players_secure: { data: [{ id: 'player-1', phone_display: '***1234', email_display: 'a***@example.invalid', messenger_display: '@a***', has_phone: true, has_email: true, has_messenger: true, contact_access_state: 'eligible', status: 'in_work', agent_id: 'profile-1', imported_at: 'i', updated_at: 'u', follow_up_at: 'f' }], error: null },
    player_comments: { data: [{ id: 'comment-1', player_id: 'player-1', text: 'Synthetic', created_at: 'c', author_id: 'profile-1', author_name: 'Agent', author_role: 'agent' }], error: null },
    player_status_history: { data: [{ id: 'history-1', player_id: 'player-1', from_status: 'assigned', to_status: 'in_work', changed_at: 'h', user_id: 'profile-1', user_name: 'Agent', user_role: 'agent' }], error: null }
  });
  const players = await new data.SupabaseDataService(fixture.client).loadPlayers();
  assert.equal(players.length, 1);
  assert.equal(players[0].agentId, 'profile-1');
  assert.equal(players[0].comments[0].authorId, 'profile-1');
  assert.equal(players[0].statusHistory[0].fromStatus, 'assigned');
  assert.equal(players[0].phoneDisplay, '***1234');
  assert.equal(players[0].contactAccessState, 'eligible');
  for (const key of ['phone', 'email', 'messenger']) assert.equal(key in players[0], false, `${key} must never reach the browser player object`);
});

test('normalizes nullable fields and ignores orphan activity rows', async () => {
  const fixture = clientWith({
    players_secure: { data: [{ id: 'player-1', phone_display: null, email_display: null, messenger_display: null, has_phone: false, has_email: false, has_messenger: false, contact_access_state: null, status: null, agent_id: null, imported_at: null, updated_at: null, follow_up_at: null }, null], error: null },
    player_comments: { data: [{ id: 'orphan', player_id: null }], error: null },
    player_status_history: { data: null, error: null }
  });
  const [player] = await new data.SupabaseDataService(fixture.client).loadPlayers();
  assert.deepEqual({ phoneDisplay: player.phoneDisplay, emailDisplay: player.emailDisplay, messengerDisplay: player.messengerDisplay,
    hasPhone: player.hasPhone, contactAccessState: player.contactAccessState, status: player.status, agentId: player.agentId, followUpAt: player.followUpAt },
    { phoneDisplay: '', emailDisplay: '', messengerDisplay: '', hasPhone: false, contactAccessState: 'locked', status: 'new', agentId: null, followUpAt: null });
  assert.deepEqual(player.comments, []);
  assert.deepEqual(player.statusHistory, []);
});

test('does not hide Supabase read errors', async () => {
  const expected = Object.assign(new Error('Synthetic database failure'), { code: 'TEST_DB_ERROR' });
  const fixture = clientWith({ profiles: { data: null, error: expected } });
  await assert.rejects(() => new data.SupabaseDataService(fixture.client).loadUsers(), error => error === expected);
});

test('rejects broad save methods because writes require scoped RPCs', async () => {
  const service = new data.SupabaseDataService(clientWith({}).client);
  await assert.rejects(() => service.saveUsers([]), error => error.code === 'RPC_REQUIRED');
  await assert.rejects(() => service.savePlayers([]), error => error.code === 'RPC_REQUIRED');
  await assert.rejects(() => service.saveCurrentUser(null), error => error.code === 'RPC_REQUIRED');
});

test('routes every write through its narrowly scoped atomic RPC', async () => {
  const fixture = clientWith({});
  const service = new data.SupabaseDataService(fixture.client);
  await service.createPlayers([{ id:'p1', phone:'+1', importedAt:0 }]);
  await service.assignPlayers(['p1'],['a1']);
  await service.changePlayerStatus('p1','in_work','h1',{ adminConfirmed:true });
  await service.addPlayerComment('p1','c1',' note ');
  await service.setPlayerFollowUp('p1','2026-01-01T00:00:00Z');
  assert.deepEqual(fixture.calls.rpcs.map(call=>call.name), [
    'create_players_atomic','assign_players_atomic','change_player_status_atomic',
    'add_player_comment_atomic','set_player_follow_up_atomic'
  ]);
  assert.equal(fixture.calls.rpcs[2].parameters.p_confirm_reopen,true);
});

test('propagates RPC errors without a direct-write fallback', async () => {
  const fixture = clientWith({});
  const expected = Object.assign(new Error('denied'),{ code:'42501' });
  fixture.client.rpc = async ()=>({ data:null,error:expected });
  await assert.rejects(()=>new data.SupabaseDataService(fixture.client).setPlayerFollowUp('p1',null),error=>error===expected);
});

test('clearSession delegates to Supabase Auth signOut and propagates its error', async () => {
  let fixture = clientWith({});
  await new data.SupabaseDataService(fixture.client).clearSession();
  assert.equal(fixture.calls.signOut, 1);
  const expected = new Error('Synthetic sign out failure');
  fixture = clientWith({}, { async signOut() { return { error: expected }; } });
  await assert.rejects(() => new data.SupabaseDataService(fixture.client).clearSession(), error => error === expected);
});
