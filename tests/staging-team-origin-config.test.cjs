'use strict';

// The scoped staging team-management CORS origin secret authorization.
// Mirrors tests/staging-auth-config.test.cjs: policy, not a feature — a
// regression here is a widening of what an agent may set on a real hosted
// Supabase project's Edge Function secrets.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const core = require('../scripts/release/release-core.cjs');
const guard = require('../.claude/hooks/release-guard.cjs');
const wrapper = require('../scripts/release/staging-team-origin-config.cjs');

const CI = Object.freeze({ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'staging' });
const AUTHORIZED = 'node scripts/release/staging-team-origin-config.cjs --dry-run';

test('the wrapper pins the exact secret name, value, and project', () => {
  assert.equal(wrapper.TARGET.projectRef, 'cjdxtakgmnzwixrajjry');
  assert.equal(wrapper.TARGET.environment, 'staging');
  assert.equal(wrapper.TARGET.secretName, 'TEAM_ALLOWED_ORIGIN');
  assert.equal(wrapper.TARGET.secretValue, 'https://locker-r.github.io');
});

test('the wrapper is authorized only in CI, only for the two supported modes', () => {
  for (const mode of ['--dry-run', '--apply']) {
    const outcome = core.classifyCommand(`node scripts/release/staging-team-origin-config.cjs ${mode}`, CI);
    assert.equal(outcome.classification, core.LOCAL_WRITE, mode);
    assert.equal(outcome.rule, 'STAGING_TEAM_ORIGIN_CONFIG_AUTHORIZED');
  }
});

test('the wrapper is refused outside GitHub Actions and outside staging', () => {
  const cases = [
    [{}, 'STAGING_TEAM_ORIGIN_CONFIG_LOCAL_EXECUTION_BLOCKED'],
    [{ GITHUB_ACTIONS: 'false', RELEASE_ENVIRONMENT: 'staging' }, 'STAGING_TEAM_ORIGIN_CONFIG_LOCAL_EXECUTION_BLOCKED'],
    [{ GITHUB_ACTIONS: 'true' }, 'STAGING_TEAM_ORIGIN_CONFIG_ENVIRONMENT_MISMATCH'],
    [{ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'production' }, 'STAGING_TEAM_ORIGIN_CONFIG_ENVIRONMENT_MISMATCH']
  ];
  for (const [env, rule] of cases) {
    const outcome = core.classifyCommand(AUTHORIZED, env);
    assert.equal(outcome.classification, core.PRODUCTION, JSON.stringify(env));
    assert.equal(outcome.rule, rule);
  }
});

test('no other argument shape reaches the exception, even inside CI', () => {
  const refused = [
    'node scripts/release/staging-team-origin-config.cjs',
    'node scripts/release/staging-team-origin-config.cjs --apply --dry-run',
    'node scripts/release/staging-team-origin-config.cjs --secret-name OTHER',
    'node scripts/release/staging-team-origin-config.cjs --project-ref hywpwutykwrxkddnofrh --apply',
    'node scripts/release/staging-team-origin-config.cjs --force'
  ];
  for (const command of refused) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('wrapper, shell, pipeline and env-prefix evasions are refused inside CI', () => {
  const evasions = [
    'cmd /c node scripts/release/staging-team-origin-config.cjs --apply',
    'bash -c "node scripts/release/staging-team-origin-config.cjs --apply"',
    'sh -c "node scripts/release/staging-team-origin-config.cjs --apply"',
    'powershell -Command "node scripts/release/staging-team-origin-config.cjs --apply"',
    'npx --yes node scripts/release/staging-team-origin-config.cjs --apply',
    'RELEASE_ENVIRONMENT=staging node scripts/release/staging-team-origin-config.cjs --apply',
    'echo hi && node scripts/release/staging-team-origin-config.cjs --apply'
  ];
  for (const command of evasions) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('generic supabase secrets set/unset is untouched by this exception', () => {
  const commands = [
    'supabase secrets set TEAM_ALLOWED_ORIGIN=https://locker-r.github.io --project-ref cjdxtakgmnzwixrajjry',
    'supabase secrets set OTHER_SECRET=x --project-ref cjdxtakgmnzwixrajjry',
    'supabase secrets unset TEAM_ALLOWED_ORIGIN --project-ref cjdxtakgmnzwixrajjry',
    'npx supabase secrets set TEAM_ALLOWED_ORIGIN=x --project-ref cjdxtakgmnzwixrajjry'
  ];
  for (const command of commands) {
    const outcome = core.classifyCommand(command, CI);
    assert.equal(outcome.classification, core.PRODUCTION, command);
    assert.equal(outcome.rule, 'SUPABASE_SECRETS_MUTATION', command);
  }
});

test('the guard denies the wrapper locally and defers to it in CI', () => {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: AUTHORIZED } };
  assert.equal(guard.evaluate(event, {}).decision, 'deny');
});

test('the wrapper accepts exactly one of --dry-run and --apply', () => {
  assert.equal(wrapper.parseMode(['--dry-run']).mode, 'dry-run');
  assert.equal(wrapper.parseMode(['--apply']).mode, 'apply');
  for (const argv of [[], ['--apply', '--dry-run'], ['--force']]) {
    assert.ok(wrapper.parseMode(argv).error, JSON.stringify(argv));
  }
});

test('the wrapper refuses to run without CI, staging, and an access token', () => {
  assert.deepEqual(wrapper.checkEnvironment({ ...CI, SUPABASE_ACCESS_TOKEN: 't' }), []);
  assert.equal(wrapper.checkEnvironment({}).length, 3);
});

test('a blocked precondition never starts the CLI', () => {
  let started = false;
  const status = wrapper.main(['--dry-run'], {
    env: { RELEASE_ENVIRONMENT: 'staging' },
    log: () => {},
    run: () => { started = true; return { status: 0, stdout: '' }; }
  });
  assert.equal(status, wrapper.EXIT.BLOCKED);
  assert.equal(started, false);
});

test('--dry-run only lists, never calls secrets set', () => {
  const calls = [];
  const status = wrapper.main(['--dry-run'], {
    env: { ...CI, SUPABASE_ACCESS_TOKEN: 't' },
    log: () => {},
    run: (command, args) => { calls.push(args); return { status: 0, stdout: 'OTHER_SECRET\n' }; }
  });
  assert.equal(status, wrapper.EXIT.OK);
  assert.deepEqual(calls, [['secrets', 'list', '--project-ref', wrapper.TARGET.projectRef]]);
});

test('--apply lists then sets the exact pinned secret and value', () => {
  const calls = [];
  const status = wrapper.main(['--apply'], {
    env: { ...CI, SUPABASE_ACCESS_TOKEN: 't' },
    log: () => {},
    run: (command, args) => {
      calls.push(args);
      assert.equal(command, 'supabase');
      return { status: 0, stdout: '' };
    }
  });
  assert.equal(status, wrapper.EXIT.OK);
  assert.deepEqual(calls, [
    ['secrets', 'list', '--project-ref', wrapper.TARGET.projectRef],
    ['secrets', 'set', 'TEAM_ALLOWED_ORIGIN=https://locker-r.github.io', '--project-ref', wrapper.TARGET.projectRef]
  ]);
});
