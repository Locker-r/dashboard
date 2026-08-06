'use strict';

// The scoped staging migration authorization, and the settings-level guarantee
// that release/approvals/ stays human-only. Both are policy: a regression here
// is a widening of what an agent may do, not a cosmetic failure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../scripts/release/release-core.cjs');
const guard = require('../.claude/hooks/release-guard.cjs');
const wrapper = require('../scripts/release/staging-db-migrate.cjs');

const ROOT = path.resolve(__dirname, '..');
const CI = Object.freeze({ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'staging' });
const AUTHORIZED = 'node scripts/release/staging-db-migrate.cjs --dry-run';

/* ==================== settings: approvals stay human-only ==================== */

function settings() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
}

test('settings deny both creating and modifying an approval record', () => {
  const deny = settings().permissions.deny;
  // Write creates a file that does not exist yet; Edit changes one that does.
  // Denying only the second leaves "create the approval from scratch" open,
  // which is exactly the regression this test exists to catch.
  assert.ok(deny.includes('Write(./release/approvals/**)'), 'Write(./release/approvals/**) must be denied');
  assert.ok(deny.includes('Edit(./release/approvals/**)'), 'Edit(./release/approvals/**) must be denied');
});

test('every approval deny rule uses a supported tool name', () => {
  const supported = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task']);
  for (const rule of settings().permissions.deny) {
    const tool = String(rule).split('(')[0];
    assert.ok(supported.has(tool), `unsupported permission tool "${tool}" in rule ${rule}`);
  }
});

test('the guard refuses to create, overwrite, or modify any approval record', () => {
  const targets = [
    'release/approvals/B1.approval.json',
    'release/approvals/B2.approval.json',
    'release/approvals/nested/anything.json',
    path.join(ROOT, 'release', 'approvals', 'B1.approval.json')
  ];
  const events = target => [
    { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target, content: '{}' } },
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: target, old_string: 'a', new_string: 'b' } },
    { hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', tool_input: { file_path: target, edits: [{ new_string: '{}' }] } },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo "{}" > ${target}` } },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `printf "{}" >> ${target}` } },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cp release/approval.example.json ${target}` } }
  ];
  for (const target of targets) {
    for (const event of events(target)) {
      for (const env of [{}, CI, { RELEASE_HARNESS_MODE: 'verify' }]) {
        assert.equal(guard.evaluate(event, env).decision, 'deny', `${event.tool_name} ${target}`);
      }
    }
  }
});

/* ==================== classifier: the scoped exception ==================== */

test('the wrapper is authorized only in CI, only for the two supported modes', () => {
  for (const mode of ['--dry-run', '--apply']) {
    const outcome = core.classifyCommand(`node scripts/release/staging-db-migrate.cjs ${mode}`, CI);
    assert.equal(outcome.classification, core.LOCAL_WRITE, mode);
    assert.equal(outcome.rule, 'STAGING_DB_MIGRATION_AUTHORIZED');
  }
});

test('the wrapper is refused outside GitHub Actions and outside staging', () => {
  const cases = [
    [{}, 'STAGING_DB_MIGRATION_LOCAL_EXECUTION_BLOCKED'],
    [{ GITHUB_ACTIONS: 'false', RELEASE_ENVIRONMENT: 'staging' }, 'STAGING_DB_MIGRATION_LOCAL_EXECUTION_BLOCKED'],
    [{ GITHUB_ACTIONS: 'true' }, 'STAGING_DB_MIGRATION_ENVIRONMENT_MISMATCH'],
    [{ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'production' }, 'STAGING_DB_MIGRATION_ENVIRONMENT_MISMATCH']
  ];
  for (const [env, rule] of cases) {
    const outcome = core.classifyCommand(AUTHORIZED, env);
    assert.equal(outcome.classification, core.PRODUCTION, JSON.stringify(env));
    assert.equal(outcome.rule, rule);
  }
});

test('no other argument shape reaches the exception, even inside CI', () => {
  const refused = [
    'node scripts/release/staging-db-migrate.cjs',
    'node scripts/release/staging-db-migrate.cjs --apply --dry-run',
    'node scripts/release/staging-db-migrate.cjs --apply --db-url postgresql://x',
    'node scripts/release/staging-db-migrate.cjs --project-ref hywpwutykwrxkddnofrh',
    'node scripts/release/staging-db-migrate.cjs --force',
    'node scripts/release/staging-db-migrate.cjs --apply extra'
  ];
  for (const command of refused) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('wrapper, shell, pipeline and env-prefix evasions are refused inside CI', () => {
  const evasions = [
    'cmd /c node scripts/release/staging-db-migrate.cjs --apply',
    'cmd /c "node scripts/release/staging-db-migrate.cjs --apply"',
    'bash -c "node scripts/release/staging-db-migrate.cjs --apply"',
    'sh -c "node scripts/release/staging-db-migrate.cjs --apply"',
    'powershell -Command "node scripts/release/staging-db-migrate.cjs --apply"',
    'npx --yes node scripts/release/staging-db-migrate.cjs --apply',
    'RELEASE_ENVIRONMENT=staging node scripts/release/staging-db-migrate.cjs --apply',
    'echo hi && node scripts/release/staging-db-migrate.cjs --apply',
    'echo hi | node scripts/release/staging-db-migrate.cjs --apply',
    'node scripts/release/staging-db-migrate.cjs --apply && supabase db push'
  ];
  for (const command of evasions) {
    assert.equal(core.classifyCommand(command, CI).classification, core.PRODUCTION, command);
  }
});

test('generic supabase db push is untouched by this exception', () => {
  const commands = [
    'supabase db push',
    'supabase db push --dry-run',
    `supabase db push --db-url postgresql://postgres.${wrapper.TARGET.projectRef}@${wrapper.TARGET.host}:5432/postgres`,
    'npx supabase db push',
    'npx.cmd supabase db push',
    'supabase --workdir . db push'
  ];
  for (const command of commands) {
    const outcome = core.classifyCommand(command, CI);
    assert.equal(outcome.classification, core.PRODUCTION, command);
    assert.equal(outcome.rule, 'SUPABASE_DB_PUSH', command);
  }
  assert.equal(core.classifyCommand('supabase db reset', CI).classification, core.DESTRUCTIVE);
});

test('the guard denies the wrapper locally and defers to it in CI', () => {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node scripts/release/staging-db-migrate.cjs --apply' } };
  assert.equal(guard.evaluate(event, {}).decision, 'deny');
});

/* ==================== the wrapper itself ==================== */

test('the wrapper accepts exactly one of --dry-run and --apply', () => {
  assert.equal(wrapper.parseMode(['--dry-run']).mode, 'dry-run');
  assert.equal(wrapper.parseMode(['--apply']).mode, 'apply');
  for (const argv of [[], ['--apply', '--dry-run'], ['--force'], ['--apply', 'extra'], ['--db-url', 'x']]) {
    assert.ok(wrapper.parseMode(argv).error, JSON.stringify(argv));
  }
});

test('the wrapper refuses to run without CI, staging, and a password', () => {
  assert.deepEqual(wrapper.checkEnvironment({ ...CI, SUPABASE_DB_PASSWORD: 'p' }), []);
  assert.equal(wrapper.checkEnvironment({}).length, 3);
  assert.equal(wrapper.checkEnvironment({ ...CI }).length, 1);
  assert.equal(wrapper.checkEnvironment({ GITHUB_ACTIONS: 'true', RELEASE_ENVIRONMENT: 'production', SUPABASE_DB_PASSWORD: 'p' }).length, 1);
});

test('the connection URL is pinned and percent-encoded', () => {
  const url = wrapper.buildConnectionUrl('p@ss:w/rd?#[]');
  assert.equal(url, `postgresql://postgres.${wrapper.TARGET.projectRef}:p%40ss%3Aw%2Frd%3F%23%5B%5D@${wrapper.TARGET.host}:5432/postgres`);
  for (const character of ['@ss', ':w/', '?#[]']) assert.ok(!url.includes(character), character);
  assert.equal(wrapper.TARGET.projectRef, 'cjdxtakgmnzwixrajjry');
  assert.equal(wrapper.TARGET.host, 'aws-1-eu-west-3.pooler.supabase.com');
  assert.equal(wrapper.TARGET.port, '5432');
  assert.equal(wrapper.TARGET.database, 'postgres');
  assert.equal(wrapper.TARGET.environment, 'staging');
});

test('the wrapper masks the secret before the CLI starts and never prints it', () => {
  const password = 'sup3r/secret';
  const emitted = [];
  const logged = [];
  let ranAfterMask = false;
  const status = wrapper.main(['--apply'], {
    env: { ...CI, SUPABASE_DB_PASSWORD: password },
    emit: line => emitted.push(line),
    log: line => logged.push(line),
    run: (command, args) => {
      ranAfterMask = emitted.some(line => line === `::add-mask::${password}`);
      assert.equal(command, 'supabase');
      assert.deepEqual(args.slice(0, 3), ['db', 'push', '--db-url']);
      assert.ok(!args.includes('--dry-run'));
      return { status: 0 };
    }
  });
  assert.equal(status, wrapper.EXIT.OK);
  assert.ok(ranAfterMask, 'the password must be masked before the subprocess starts');
  assert.ok(emitted.some(line => line.startsWith('::add-mask::postgresql://')), 'the URL must be masked too');
  const printed = logged.join('\n');
  assert.ok(!printed.includes(password), 'the password must never be printed');
  assert.ok(!printed.includes('postgresql://'), 'the connection URL must never be printed');
});

test('--dry-run passes --dry-run through and blocks when preconditions fail', () => {
  const seen = [];
  wrapper.main(['--dry-run'], {
    env: { ...CI, SUPABASE_DB_PASSWORD: 'p' },
    emit: () => {}, log: () => {},
    run: (command, args) => { seen.push(args); return { status: 0 }; }
  });
  assert.ok(seen[0].includes('--dry-run'));

  let started = false;
  const blocked = wrapper.main(['--apply'], {
    env: { RELEASE_ENVIRONMENT: 'staging' },
    emit: () => {}, log: () => {},
    run: () => { started = true; return { status: 0 }; }
  });
  assert.equal(blocked, wrapper.EXIT.BLOCKED);
  assert.equal(started, false, 'no subprocess may start when preconditions fail');
});
