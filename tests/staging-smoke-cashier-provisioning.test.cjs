'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const provision = require('../scripts/staging-smoke-provision-cashiers.cjs');
const deprovision = require('../scripts/staging-smoke-deprovision-cashiers.cjs');

// Regression for the first staging dispatch's actual failure: both scripts
// captured the admin access token, then called client.auth.signOut() before
// using that token against team-management. signOut revokes the current
// session server-side even with { scope: 'local' }, so by the time the Edge
// Function validated the bearer token it was already dead — every call
// failed with 401 INVALID_TOKEN (provisioning) and 401 LIST_MEMBERS_FAILED
// (deprovisioning, cascading from the same bug). The token must outlive
// every call that needs it; signOut must run last.
function sourceOf(filename) {
  return fs.readFileSync(path.join(__dirname, '..', 'scripts', filename), 'utf8');
}

test('provisioning signs out only after both create-member calls complete', () => {
  const source = sourceOf('staging-smoke-provision-cashiers.cjs');
  const signOutIndex = source.indexOf('client.auth.signOut(');
  const lastCreateMemberIndex = source.lastIndexOf('await createMember(');
  assert.ok(signOutIndex >= 0 && lastCreateMemberIndex >= 0);
  assert.ok(signOutIndex > lastCreateMemberIndex, 'signOut must run after every createMember call, not before');
});

test('deprovisioning signs out only after every lookup/deactivate call completes', () => {
  const source = sourceOf('staging-smoke-deprovision-cashiers.cjs');
  const signOutIndex = source.indexOf('client.auth.signOut(');
  const lastDeactivateIndex = Math.max(source.lastIndexOf('await findMemberId('), source.lastIndexOf('await deactivate('));
  assert.ok(signOutIndex >= 0 && lastDeactivateIndex >= 0);
  assert.ok(signOutIndex > lastDeactivateIndex, 'signOut must run after every team-management call, not before');
});

test('buildCashier produces a deterministic, run-scoped, smoke_test-prefixed identity', () => {
  const a = provision.buildCashier('abc123def456', 'a');
  assert.equal(a.email, 'smoke_test_abc123def456_cashier_a@example.invalid');
  assert.equal(a.username, 'smoke_test_abc123def456_a');
  // The same run id and slot must always produce the same email/username, so
  // deprovisioning (which re-derives them rather than storing state) can find
  // exactly the account provisioning created.
  const again = provision.buildCashier('abc123def456', 'a');
  assert.equal(again.email, a.email);
  assert.equal(again.username, a.username);
});

test('the two slots never collide', () => {
  const a = provision.buildCashier('abc123def456', 'a');
  const b = provision.buildCashier('abc123def456', 'b');
  assert.notEqual(a.email, b.email);
  assert.notEqual(a.username, b.username);
});

test('different runs never collide', () => {
  const runOne = provision.buildCashier('abc123def456', 'a');
  const runTwo = provision.buildCashier('def456abc789', 'a');
  assert.notEqual(runOne.email, runTwo.email);
});

test('generated passwords are unique, long, and never the literal word password', () => {
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const password = provision.generatePassword();
    assert.ok(password.length >= 24, password.length);
    assert.ok(!/password/i.test(password));
    assert.ok(!seen.has(password), 'passwords must not repeat');
    seen.add(password);
  }
});

test('deprovisioning exposes lookup and deactivation, and re-derives identity from provisioning rather than storing it', () => {
  assert.equal(typeof deprovision.findMemberId, 'function');
  assert.equal(typeof deprovision.deactivate, 'function');
  // buildCashier itself is imported by staging-smoke-deprovision-cashiers.cjs
  // (see its require of ./staging-smoke-provision-cashiers.cjs) rather than
  // reimplemented, so the naming rule cannot drift between the two scripts.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'staging-smoke-deprovision-cashiers.cjs'), 'utf8'
  );
  assert.match(source, /require\(['"]\.\/staging-smoke-provision-cashiers\.cjs['"]\)/);
});
