const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadClassicModule(relativePath, requireImplementation) {
  const filename = path.join(__dirname, relativePath);
  const sandbox = { module: { exports: {} }, require: requireImplementation };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports;
}

const dataServiceContract = loadClassicModule('../src/data/data-service.js');
const { LocalStorageDataService } = loadClassicModule(
  '../src/data/local-storage-data-service.js',
  request => request === './data-service.js' ? dataServiceContract : require(request)
);

const plain = value => JSON.parse(JSON.stringify(value));

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    value: key => values.get(key)
  };
}

test('reads and writes the legacy users and players shapes', async () => {
  const storage = memoryStorage({
    'crm-users': JSON.stringify([{ id: 'u_1', role: 'admin' }]),
    'crm-data': JSON.stringify({ players: [{ id: 'p_1', status: 'new' }] })
  });
  const service = new LocalStorageDataService({ localStorage: storage });

  assert.deepEqual(plain(await service.loadUsers()), [{ id: 'u_1', role: 'admin' }]);
  assert.deepEqual(plain(await service.loadPlayers()), [{ id: 'p_1', status: 'new' }]);

  await service.saveUsers([{ id: 'u_2' }]);
  await service.savePlayers([{ id: 'p_2' }]);
  assert.deepEqual(JSON.parse(storage.value('crm-users')), [{ id: 'u_2' }]);
  assert.deepEqual(JSON.parse(storage.value('crm-data')), { players: [{ id: 'p_2' }] });
});

test('returns safe defaults for empty, corrupt, or wrong-shaped storage', async () => {
  for (const initial of [
    {},
    { 'crm-users': '{broken', 'crm-data': '{broken' },
    { 'crm-users': '{}', 'crm-data': JSON.stringify({ players: {} }) }
  ]) {
    const service = new LocalStorageDataService({ localStorage: memoryStorage(initial) });
    assert.deepEqual(plain(await service.loadUsers()), []);
    assert.deepEqual(plain(await service.loadPlayers()), []);
  }
});

test('keeps a valid local users array when host storage differs', async () => {
  const local = memoryStorage({ 'crm-users': JSON.stringify([{ id: 'local' }]) });
  const host = {
    async get(key, shared) {
      assert.equal(shared, true);
      return { value: key === 'crm-users' ? JSON.stringify([{ id: 'host' }]) : null };
    },
    async set(_key, _value, shared) { assert.equal(shared, true); }
  };
  const service = new LocalStorageDataService({ localStorage: local, hostStorage: host });
  assert.deepEqual(plain(await service.loadUsers()), [{ id: 'local' }]);
  assert.deepEqual(JSON.parse(local.value('crm-users')), [{ id: 'local' }]);
});

test('empty host storage cannot override non-empty local users', async () => {
  const local = memoryStorage({ 'crm-users': JSON.stringify([{ id: 'admin' }, { id: 'agent' }]) });
  const host = { async get() { return { value: '[]' }; }, async set() {} };
  const service = new LocalStorageDataService({ localStorage: local, hostStorage: host });
  assert.deepEqual(plain(await service.loadUsers()).map(user => user.id), ['admin', 'agent']);
});

test('existing users survive service recreation without host storage', async () => {
  const local = memoryStorage({ 'crm-users': JSON.stringify([{ id: 'admin', role: 'admin' }, { id: 'agent', role: 'agent' }]) });
  const firstLoad = new LocalStorageDataService({ localStorage: local });
  const secondLoad = new LocalStorageDataService({ localStorage: local });
  assert.deepEqual(plain(await firstLoad.loadUsers()).map(user => user.role), ['admin', 'agent']);
  assert.deepEqual(plain(await secondLoad.loadUsers()).map(user => user.role), ['admin', 'agent']);
});

test('corrupt users JSON is not overwritten during load and blocks initialization', async () => {
  const local = memoryStorage({ 'crm-users': '{broken' });
  const service = new LocalStorageDataService({ localStorage: local });
  assert.deepEqual(plain(await service.loadUsers()), []);
  assert.equal(service.canInitializeUsers(), false);
  assert.equal(local.value('crm-users'), '{broken');
});

test('rejects replacing a non-empty users array with an empty array', async () => {
  const local = memoryStorage({ 'crm-users': JSON.stringify([{ id: 'admin' }]) });
  const service = new LocalStorageDataService({ localStorage: local });
  await assert.rejects(service.saveUsers([]), /Refusing to replace/);
  assert.deepEqual(JSON.parse(local.value('crm-users')), [{ id: 'admin' }]);
});

test('registration-style append persists existing users across reloads', async () => {
  const local = memoryStorage({ 'crm-users': JSON.stringify([{ id: 'admin' }, { id: 'agent' }]) });
  const service = new LocalStorageDataService({ localStorage: local });
  const existing = await service.loadUsers();
  await service.saveUsers([...existing, { id: 'new-agent' }]);
  const reloaded = new LocalStorageDataService({ localStorage: local });
  assert.deepEqual(plain(await reloaded.loadUsers()).map(user => user.id), ['admin', 'agent', 'new-agent']);
});

test('keeps the current session ephemeral', async () => {
  const storage = memoryStorage({ 'crm-users': JSON.stringify([{ id: 'u_1' }]) });
  const service = new LocalStorageDataService({ localStorage: storage });
  assert.equal(await service.getCurrentUser(), null);
  await service.saveCurrentUser({ id: 'u_1' });
  assert.deepEqual(await service.getCurrentUser(), { id: 'u_1' });
  await service.clearSession();
  assert.equal(await service.getCurrentUser(), null);
  assert.deepEqual(JSON.parse(storage.value('crm-users')), [{ id: 'u_1' }]);
});

test('round-trips player history, comments, and follow-up fields', async () => {
  const storage = memoryStorage();
  const service = new LocalStorageDataService({ localStorage: storage });
  const players = [{
    id: 'p_activity',
    status: 'no_answer',
    followUpAt: '2026-07-30T10:00:00.000Z',
    statusHistory: [{ id: 'h_1', fromStatus: 'in_work', toStatus: 'no_answer', changedAt: 1 }],
    comments: [{ id: 'c_1', text: 'Synthetic test comment', createdAt: 2 }]
  }];

  await service.savePlayers(players);
  const reloadedService = new LocalStorageDataService({ localStorage: storage });
  assert.deepEqual(plain(await reloadedService.loadPlayers()), players);
});
