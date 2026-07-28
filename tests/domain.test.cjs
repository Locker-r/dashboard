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

const domain = loadClassicModule('../src/domain.js');

test('normalizes roles with a safe agent fallback', () => {
  assert.equal(domain.normalizeRole(' ADMIN '), 'admin');
  assert.equal(domain.normalizeRole('unexpected'), 'agent');
});

test('normalizes duplicate identifiers', () => {
  assert.equal(domain.normalizePhone('+593 98-765-4321'), '593987654321');
  assert.equal(domain.normalizePhone('00593 98 765 4321'), '593987654321');
  assert.equal(domain.normalizeEmail(' Agent@Example.COM '), 'agent@example.com');
  assert.equal(domain.duplicateKeyFor({ phone: '+593 98 765 4321', email: 'ignored@example.com' }), 'phone:593987654321');
  assert.equal(domain.duplicateKeyFor({ phone: '', email: ' Agent@Example.COM ' }), 'email:agent@example.com');
  assert.equal(domain.duplicateKeyFor({}), null);
});

test('enforces approved status transitions by role', () => {
  assert.equal(domain.canRoleTransitionStatus('agent', 'assigned', 'in_work'), true);
  assert.equal(domain.canRoleTransitionStatus('agent', 'in_work', 'success'), true);
  assert.equal(domain.canRoleTransitionStatus('agent', 'no_answer', 'assigned'), true);
  assert.equal(domain.canRoleTransitionStatus('agent', 'success', 'in_work'), false);
  assert.equal(domain.canRoleTransitionStatus('admin', 'success', 'in_work'), true);
  assert.equal(domain.canRoleTransitionStatus('admin', 'new', 'success'), false);
});

test('requires admin and confirmation to reassign final players', () => {
  assert.equal(domain.canReassignPlayer('agent', 'assigned', true), false);
  assert.equal(domain.canReassignPlayer('admin', 'assigned', false), true);
  assert.equal(domain.canReassignPlayer('admin', 'success', false), false);
  assert.equal(domain.canReassignPlayer('admin', 'success', true), true);
});

test('protects the last active administrator', () => {
  assert.equal(domain.canPerformAdministrativeAction('agent'), false);
  assert.equal(domain.canPerformAdministrativeAction('admin'), true);
  assert.equal(domain.canPerformAdministrativeAction('admin', { affectsActiveAdmin: true }), false);
  assert.equal(domain.canPerformAdministrativeAction('admin', { affectsActiveAdmin: true, activeAdminCount: 1 }), false);
  assert.equal(domain.canPerformAdministrativeAction('admin', { affectsActiveAdmin: true, activeAdminCount: 2 }), true);
});
