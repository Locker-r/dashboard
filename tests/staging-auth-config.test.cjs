'use strict';

// The scoped staging Auth URL configuration authorization. Mirrors
// tests/staging-db-migration.test.cjs and tests/staging-functions-deploy.test.cjs:
// this is policy, not a feature — a regression here is a widening of what an
// agent may configure on a real hosted Supabase project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../scripts/release/release-core.cjs');
const guard = require('../.claude/hooks/release-guard.cjs');
const wrapper = require('../scripts/release/staging-auth-config.cjs');

const ROOT = path.resolve(__dirname, '..');
const CI = Object.freeze({ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'staging' });
const AUTHORIZED = 'node scripts/release/staging-auth-config.cjs --dry-run';

test('the wrapper pins the exact staging target with no wildcard', () => {
  assert.equal(wrapper.TARGET.projectRef, 'cjdxtakgmnzwixrajjry');
  assert.equal(wrapper.TARGET.environment, 'staging');
  assert.equal(wrapper.TARGET.siteUrl, 'https://locker-r.github.io/dashboard/');
  assert.deepEqual(wrapper.TARGET.redirectUrls, ['https://locker-r.github.io/dashboard/']);
  for (const url of [wrapper.TARGET.siteUrl, ...wrapper.TARGET.redirectUrls]) {
    assert.ok(!url.includes('*'), `no wildcard allowed: ${url}`);
  }
});

test('the pinned redirect URL is the only one the app could plausibly need', () => {
  // The app has no redirect-based Auth flow at all today; verifying that
  // stays true is what justifies "no wildcard" rather than asserting it once
  // and letting the app drift underneath the policy.
  const authService = fs.readFileSync(path.join(ROOT, 'src', 'supabase-auth-service.js'), 'utf8');
  for (const method of ['resetPasswordForEmail', 'signInWithOtp', 'signInWithOAuth', 'verifyOtp']) {
    assert.ok(!authService.includes(method), `${method} would need its own redirect URL, and none is authorized`);
  }
});

test('the wrapper is authorized only in CI, only for the two supported modes', () => {
  for (const mode of ['--dry-run', '--apply']) {
    const outcome = core.classifyCommand(`node scripts/release/staging-auth-config.cjs ${mode}`, CI);
    assert.equal(outcome.classification, core.LOCAL_WRITE, mode);
    assert.equal(outcome.rule, 'STAGING_AUTH_CONFIG_AUTHORIZED');
  }
});

test('the wrapper is refused outside GitHub Actions and outside staging', () => {
  const cases = [
    [{}, 'STAGING_AUTH_CONFIG_LOCAL_EXECUTION_BLOCKED'],
    [{ GITHUB_ACTIONS: 'false', RELEASE_ENVIRONMENT: 'staging' }, 'STAGING_AUTH_CONFIG_LOCAL_EXECUTION_BLOCKED'],
    [{ GITHUB_ACTIONS: 'true' }, 'STAGING_AUTH_CONFIG_ENVIRONMENT_MISMATCH'],
    [{ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'production' }, 'STAGING_AUTH_CONFIG_ENVIRONMENT_MISMATCH']
  ];
  for (const [env, rule] of cases) {
    const outcome = core.classifyCommand(AUTHORIZED, env);
    assert.equal(outcome.classification, core.PRODUCTION, JSON.stringify(env));
    assert.equal(outcome.rule, rule);
  }
});

test('no other argument shape reaches the exception, even inside CI', () => {
  const refused = [
    'node scripts/release/staging-auth-config.cjs',
    'node scripts/release/staging-auth-config.cjs --apply --dry-run',
    'node scripts/release/staging-auth-config.cjs --site-url https://example.com',
    'node scripts/release/staging-auth-config.cjs --project-ref hywpwutykwrxkddnofrh --apply',
    'node scripts/release/staging-auth-config.cjs --force'
  ];
  for (const command of refused) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('wrapper, shell, pipeline and env-prefix evasions are refused inside CI', () => {
  const evasions = [
    'cmd /c node scripts/release/staging-auth-config.cjs --apply',
    'bash -c "node scripts/release/staging-auth-config.cjs --apply"',
    'sh -c "node scripts/release/staging-auth-config.cjs --apply"',
    'powershell -Command "node scripts/release/staging-auth-config.cjs --apply"',
    'npx --yes node scripts/release/staging-auth-config.cjs --apply',
    'RELEASE_ENVIRONMENT=staging node scripts/release/staging-auth-config.cjs --apply',
    'echo hi && node scripts/release/staging-auth-config.cjs --apply'
  ];
  for (const command of evasions) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('any ad hoc GitHub or Supabase API mutation of hosting/Auth stays production', () => {
  const commands = [
    'gh api -X PUT repos/Locker-r/dashboard/pages',
    'gh api -X PATCH repos/Locker-r/dashboard/pages',
    'gh api -X DELETE repos/Locker-r/dashboard/pages',
    'gh api -X PATCH projects/cjdxtakgmnzwixrajjry/config/auth'
  ];
  for (const command of commands) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('the guard denies the wrapper locally and defers to it in CI', () => {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: AUTHORIZED } };
  assert.equal(guard.evaluate(event, {}).decision, 'deny');
});

test('the wrapper accepts exactly one of --dry-run and --apply', () => {
  assert.equal(wrapper.parseMode(['--dry-run']).mode, 'dry-run');
  assert.equal(wrapper.parseMode(['--apply']).mode, 'apply');
  for (const argv of [[], ['--apply', '--dry-run'], ['--force'], ['--site-url', 'x']]) {
    assert.ok(wrapper.parseMode(argv).error, JSON.stringify(argv));
  }
});

test('the wrapper refuses to run without CI, staging, and an access token', () => {
  assert.deepEqual(wrapper.checkEnvironment({ ...CI, SUPABASE_ACCESS_TOKEN: 't' }), []);
  assert.equal(wrapper.checkEnvironment({}).length, 3);
  assert.equal(wrapper.checkEnvironment({ ...CI }).length, 1);
});

test('a blocked precondition never makes a network request', async () => {
  let requested = false;
  const status = await wrapper.main(['--dry-run'], {
    env: { RELEASE_ENVIRONMENT: 'staging' },
    emit: () => {}, log: () => {},
    request: () => { requested = true; return { status: 200, body: {} }; }
  });
  assert.equal(status, wrapper.EXIT.BLOCKED);
  assert.equal(requested, false);
});

test('the wrapper masks the token before any request and never prints it', async () => {
  const token = 'sbp_secrettoken';
  const emitted = [];
  const logged = [];
  let maskedBeforeRequest = false;
  await wrapper.main(['--dry-run'], {
    env: { ...CI, SUPABASE_ACCESS_TOKEN: token },
    emit: line => emitted.push(line),
    log: line => logged.push(line),
    request: (options) => {
      maskedBeforeRequest = emitted.some(line => line === `::add-mask::${token}`);
      assert.equal(options.token, token);
      return { status: 200, body: { site_url: wrapper.TARGET.siteUrl, uri_allow_list: wrapper.TARGET.redirectUrls.join(',') } };
    }
  });
  assert.ok(maskedBeforeRequest, 'the token must be masked before any network call');
  assert.ok(!logged.join('\n').includes(token), 'the token must never be printed');
});

test('--dry-run never writes; --apply only PATCHes when the current state differs', async () => {
  let methodsCalled = [];
  await wrapper.main(['--dry-run'], {
    env: { ...CI, SUPABASE_ACCESS_TOKEN: 't' },
    emit: () => {}, log: () => {},
    request: (options) => { methodsCalled.push(options.method); return { status: 200, body: { site_url: 'stale', uri_allow_list: 'stale' } }; }
  });
  assert.deepEqual(methodsCalled, ['GET']);

  methodsCalled = [];
  await wrapper.main(['--apply'], {
    env: { ...CI, SUPABASE_ACCESS_TOKEN: 't' },
    emit: () => {}, log: () => {},
    request: (options) => {
      methodsCalled.push(options.method);
      if (options.method === 'GET') return { status: 200, body: { site_url: wrapper.TARGET.siteUrl, uri_allow_list: wrapper.TARGET.redirectUrls.join(',') } };
      return { status: 200, body: {} };
    }
  });
  assert.deepEqual(methodsCalled, ['GET'], 'a matching current state must not be re-written');

  methodsCalled = [];
  const patchBodies = [];
  await wrapper.main(['--apply'], {
    env: { ...CI, SUPABASE_ACCESS_TOKEN: 't' },
    emit: () => {}, log: () => {},
    request: (options) => {
      methodsCalled.push(options.method);
      if (options.method === 'PATCH') patchBodies.push(options.body);
      if (options.method === 'GET') return { status: 200, body: { site_url: 'stale', uri_allow_list: 'stale' } };
      return { status: 200, body: {} };
    }
  });
  assert.deepEqual(methodsCalled, ['GET', 'PATCH']);
  assert.deepEqual(patchBodies, [{ site_url: wrapper.TARGET.siteUrl, uri_allow_list: wrapper.TARGET.redirectUrls.join(',') }]);
});
