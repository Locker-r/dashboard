'use strict';

// Regression for a staging incident: when window.REACTIVATION_SUPABASE_CONFIG
// never loads (config/runtime-config.js missing, wrong host, etc.), boot()
// throws before `authService` is assigned. Before this fix, clicking "Войти"
// then called `authService.signIn(...)` on a null authService, producing an
// unguarded TypeError with no `.code` — authErrorMessage() falls back to the
// generic 'auth_error' message, and clearAuthMsgs() had already wiped the one
// useful diagnostic boot() had shown (config_missing). The result looked
// identical to a real credentials failure, cost zero Auth network requests,
// and gave no way to tell the two apart from the UI alone.
//
// index.html has no test harness that executes its inline script (see
// tests/team-admin.test.cjs for the same string-assertion approach), so this
// checks the source directly rather than the runtime behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('boot() records its own initialization failure', () => {
  assert.match(indexHtml, /let authInitError = null;/);
  const bootCatchStart = indexHtml.indexOf('/* ==================== Boot ==================== */');
  assert.ok(bootCatchStart >= 0, 'Boot section must exist');
  const bootBody = indexHtml.slice(bootCatchStart);
  assert.match(bootBody, /if\(!authService\)\{ authInitError = error; \}/);
});

test('the login handler refuses to call signIn on a null authService', () => {
  const formStart = indexHtml.indexOf("document.getElementById('loginForm').addEventListener('submit'");
  assert.ok(formStart >= 0, 'login submit handler must exist');
  const signInCallIndex = indexHtml.indexOf('authService.signIn(email, password)', formStart);
  const guardIndex = indexHtml.indexOf('if(!authService){', formStart);
  assert.ok(guardIndex >= 0 && guardIndex < signInCallIndex, 'the null-authService guard must run before signIn is called');
  const guardBody = indexHtml.slice(guardIndex, signInCallIndex);
  assert.match(guardBody, /showAuthError\(authErrorMessage\(authInitError\)\)/, 'the guard must surface the real boot-time cause, not a generic message');
  assert.match(guardBody, /return;/, 'the guard must not fall through to authService.signIn');
});

test('authErrorMessage and logAuthDiagnostic tolerate a null error', () => {
  // Both are called with authInitError, which can itself be null if the guard
  // is ever reached without a prior boot() failure — must not throw.
  const messageFn = indexHtml.match(/function authErrorMessage\(error\)\{[\s\S]*?\n\}/)[0];
  assert.match(messageFn, /error && error\.code \|\| 'auth_error'/);
  const diagnosticFn = indexHtml.match(/function logAuthDiagnostic\(error\)\{[\s\S]*?\n\}/)[0];
  assert.match(diagnosticFn, /error && error\.cause \|\| error \|\| \{\}/);
});
