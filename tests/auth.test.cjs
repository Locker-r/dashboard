const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const filename = path.join(__dirname, '../src/auth.js');
const sandbox = { module: { exports: {} }, TextEncoder, Uint8Array };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
const auth = sandbox.module.exports;

async function syntheticUser(id, username, password, role) {
  const salt = `synthetic-salt-${id}`;
  return { id, username, role, salt, passwordHash: await auth.hashValue(password, salt, webcrypto) };
}

test('authenticates new and existing admins and agents', async () => {
  const users = [
    await syntheticUser('new-admin', 'new.admin', 'AdminPass1', 'admin'),
    await syntheticUser('old-admin', 'old.admin', 'OldAdmin1', 'admin'),
    await syntheticUser('agent', 'agent.one', 'AgentPass1', 'agent')
  ];
  assert.equal((await auth.authenticateUser(users, 'new.admin', 'AdminPass1', webcrypto)).ok, true);
  assert.equal((await auth.authenticateUser(users, 'old.admin', 'OldAdmin1', webcrypto)).ok, true);
  assert.equal((await auth.authenticateUser(users, 'agent.one', 'AgentPass1', webcrypto)).ok, true);
});

test('rejects a wrong password and unknown user', async () => {
  const users = [await syntheticUser('agent', 'agent.one', 'AgentPass1', 'agent')];
  assert.equal((await auth.authenticateUser(users, 'agent.one', 'WrongPass1', webcrypto)).reason, 'wrong_password');
  assert.equal((await auth.authenticateUser(users, 'missing', 'AgentPass1', webcrypto)).reason, 'unknown_user');
});

test('normalizes intended username whitespace and case', async () => {
  const users = [await syntheticUser('agent', 'Agent.One', 'AgentPass1', 'agent')];
  assert.equal(auth.normalizeUsername('  AGENT.ONE  '), 'agent.one');
  assert.equal((await auth.authenticateUser(users, '  agent.one ', 'AgentPass1', webcrypto)).ok, true);
  assert.equal(auth.usernameExists(users, ' agent.ONE '), true);
});

test('rejects unsupported legacy password shapes without exposing or guessing credentials', async () => {
  const plaintextLegacy = { id: 'legacy', username: 'legacy', password: 'not-used', role: 'agent' };
  assert.equal((await auth.authenticateUser([plaintextLegacy], 'legacy', 'not-used', webcrypto)).reason, 'unsupported_user_format');
});

test('appending registration data preserves existing users', () => {
  const existing = [{ id: 'u1' }, { id: 'u2' }];
  const result = auth.appendUser(existing, { id: 'u3' });
  assert.deepEqual(Array.from(result, user => user.id), ['u1', 'u2', 'u3']);
  assert.equal(existing.length, 2);
});

test('only a genuinely first registration receives admin role', () => {
  assert.equal(auth.roleForRegistration([], true), 'admin');
  assert.equal(auth.roleForRegistration([{ id: 'existing-admin' }], true), 'agent');
  assert.equal(auth.roleForRegistration([], false), 'agent');
});

test('existing admin authenticates after a simulated application restart', async () => {
  const storedUsers = [await syntheticUser('admin', 'persistent.admin', 'Persistent1', 'admin')];
  const serialized = JSON.stringify(storedUsers);
  const reloadedUsers = JSON.parse(serialized);
  assert.equal((await auth.authenticateUser(reloadedUsers, 'persistent.admin', 'Persistent1', webcrypto)).ok, true);
});
