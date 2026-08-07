'use strict';

// The scoped staging Edge Function deployment authorization. Mirrors
// tests/staging-db-migration.test.cjs: this is policy, not a feature — a
// regression here is a widening of what an agent may deploy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../scripts/release/release-core.cjs');
const guard = require('../.claude/hooks/release-guard.cjs');
const wrapper = require('../scripts/release/staging-functions-deploy.cjs');

const ROOT = path.resolve(__dirname, '..');
const CI = Object.freeze({ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'staging' });
const AUTHORIZED = 'node scripts/release/staging-functions-deploy.cjs --function team-management';

test('the wrapper allowlists only functions the app actually calls', () => {
  assert.deepEqual(wrapper.TARGET.functions, ['team-management']);
  assert.equal(wrapper.TARGET.projectRef, 'cjdxtakgmnzwixrajjry');
  assert.equal(wrapper.TARGET.environment, 'staging');
  const declared = fs.readdirSync(path.join(ROOT, 'supabase', 'functions'));
  for (const name of wrapper.TARGET.functions) assert.ok(declared.includes(name), name);
  const invoked = fs.readFileSync(path.join(ROOT, 'src', 'team-admin.js'), 'utf8');
  assert.ok(invoked.includes('/team-management'), 'the allowlisted function must be one the app calls');
});

test('the wrapper is authorized only in CI, only for an allowlisted function', () => {
  const outcome = core.classifyCommand(AUTHORIZED, CI);
  assert.equal(outcome.classification, core.LOCAL_WRITE);
  assert.equal(outcome.rule, 'STAGING_FUNCTIONS_DEPLOY_AUTHORIZED');
});

test('the wrapper is refused outside GitHub Actions and outside staging', () => {
  const cases = [
    [{}, 'STAGING_FUNCTIONS_DEPLOY_LOCAL_EXECUTION_BLOCKED'],
    [{ GITHUB_ACTIONS: 'false', RELEASE_ENVIRONMENT: 'staging' }, 'STAGING_FUNCTIONS_DEPLOY_LOCAL_EXECUTION_BLOCKED'],
    [{ GITHUB_ACTIONS: 'true' }, 'STAGING_FUNCTIONS_DEPLOY_ENVIRONMENT_MISMATCH'],
    [{ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'production' }, 'STAGING_FUNCTIONS_DEPLOY_ENVIRONMENT_MISMATCH']
  ];
  for (const [env, rule] of cases) {
    const outcome = core.classifyCommand(AUTHORIZED, env);
    assert.equal(outcome.classification, core.PRODUCTION, JSON.stringify(env));
    assert.equal(outcome.rule, rule);
  }
});

test('no other argument shape reaches the exception, even inside CI', () => {
  const refused = [
    'node scripts/release/staging-functions-deploy.cjs',
    'node scripts/release/staging-functions-deploy.cjs --function',
    'node scripts/release/staging-functions-deploy.cjs team-management',
    'node scripts/release/staging-functions-deploy.cjs --function team-management --force',
    'node scripts/release/staging-functions-deploy.cjs --project-ref hywpwutykwrxkddnofrh --function team-management'
  ];
  for (const command of refused) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('wrapper, shell, pipeline and env-prefix evasions are refused inside CI', () => {
  const evasions = [
    'cmd /c node scripts/release/staging-functions-deploy.cjs --function team-management',
    'bash -c "node scripts/release/staging-functions-deploy.cjs --function team-management"',
    'sh -c "node scripts/release/staging-functions-deploy.cjs --function team-management"',
    'powershell -Command "node scripts/release/staging-functions-deploy.cjs --function team-management"',
    'npx --yes node scripts/release/staging-functions-deploy.cjs --function team-management',
    'RELEASE_ENVIRONMENT=staging node scripts/release/staging-functions-deploy.cjs --function team-management',
    'echo hi && node scripts/release/staging-functions-deploy.cjs --function team-management',
    'node scripts/release/staging-functions-deploy.cjs --function team-management && supabase functions deploy other'
  ];
  for (const command of evasions) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('generic supabase functions deploy is untouched by this exception', () => {
  const commands = [
    'supabase functions deploy',
    'supabase functions deploy team-management',
    'supabase functions deploy team-management --project-ref cjdxtakgmnzwixrajjry',
    'npx supabase functions deploy team-management',
    'supabase --workdir . functions deploy team-management'
  ];
  for (const command of commands) {
    const outcome = core.classifyCommand(command, CI);
    assert.equal(outcome.classification, core.PRODUCTION, command);
    assert.equal(outcome.rule, 'SUPABASE_FUNCTIONS_DEPLOY', command);
  }
});

test('the guard denies the wrapper locally and defers to it in CI', () => {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: AUTHORIZED } };
  assert.equal(guard.evaluate(event, {}).decision, 'deny');
});

test('the wrapper refuses an unallowlisted function name before touching the CLI', () => {
  let started = false;
  const status = wrapper.main(['--function', 'not-a-real-function'], {
    env: { ...CI, SUPABASE_ACCESS_TOKEN: 't' },
    emit: () => {}, log: () => {},
    run: () => { started = true; return { status: 0 }; }
  });
  assert.equal(status, wrapper.EXIT.USAGE);
  assert.equal(started, false);
});

test('the wrapper refuses to run without CI, staging, and an access token', () => {
  assert.deepEqual(wrapper.checkEnvironment({ ...CI, SUPABASE_ACCESS_TOKEN: 't' }), []);
  assert.equal(wrapper.checkEnvironment({}).length, 3);
  assert.equal(wrapper.checkEnvironment({ ...CI }).length, 1);
});

test('the wrapper masks the access token before the CLI starts and never prints it', () => {
  const token = 'sbp_secrettoken';
  const emitted = [];
  const logged = [];
  let ranAfterMask = false;
  const status = wrapper.main(['--function', 'team-management'], {
    env: { ...CI, SUPABASE_ACCESS_TOKEN: token },
    emit: line => emitted.push(line),
    log: line => logged.push(line),
    run: (command, args) => {
      ranAfterMask = emitted.some(line => line === `::add-mask::${token}`);
      assert.equal(command, 'supabase');
      assert.deepEqual(args, ['functions', 'deploy', 'team-management', '--project-ref', wrapper.TARGET.projectRef]);
      return { status: 0 };
    }
  });
  assert.equal(status, wrapper.EXIT.OK);
  assert.ok(ranAfterMask, 'the token must be masked before the subprocess starts');
  assert.ok(!logged.join('\n').includes(token), 'the token must never be printed');
});

test('a blocked precondition never starts the CLI', () => {
  let started = false;
  const status = wrapper.main(['--function', 'team-management'], {
    env: { RELEASE_ENVIRONMENT: 'staging' },
    emit: () => {}, log: () => {},
    run: () => { started = true; return { status: 0 }; }
  });
  assert.equal(status, wrapper.EXIT.BLOCKED);
  assert.equal(started, false);
});
