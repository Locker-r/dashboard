const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../scripts/runtime-smoke.cjs');

const base = {
  SMOKE_TEST_MODE: 'local',
  SMOKE_TEST_PROJECT_URL: 'http://127.0.0.1:54321',
  SMOKE_TEST_ALLOWED_PROJECT_URL: 'http://127.0.0.1:54321'
};

test('dry-run accepts only an exactly allowlisted local endpoint', () => {
  const config = harness.readConfig(base, { dryRun: true, runId: 'abc123def456' });
  assert.equal(config.mode, 'local');
  assert.equal(config.runId, 'abc123def456');
  assert.throws(() => harness.readConfig({ ...base, SMOKE_TEST_ALLOWED_PROJECT_URL: 'http://localhost:54321' }, { dryRun: true }), /PROJECT_URL_NOT_ALLOWLISTED/);
  assert.throws(() => harness.readConfig({ ...base, SMOKE_TEST_PROJECT_URL: 'https://project.supabase.co', SMOKE_TEST_ALLOWED_PROJECT_URL: 'https://project.supabase.co' }, { dryRun: true }), /LOCAL_MODE_REQUIRES_LOOPBACK_URL/);
});

test('staging requires an exact project allowlist and explicit non-production opt-in', () => {
  const staging = { SMOKE_TEST_MODE: 'staging', SMOKE_TEST_PROJECT_URL: 'https://stagingref.supabase.co', SMOKE_TEST_ALLOWED_PROJECT_URL: 'https://stagingref.supabase.co' };
  assert.throws(() => harness.readConfig(staging, { dryRun: true }), /STAGING_OPT_IN_REQUIRED/);
  assert.equal(harness.readConfig({ ...staging, SMOKE_TEST_STAGING_CONFIRMATION: harness.STAGING_CONFIRMATION }, { dryRun: true, runId: 'abc123def456' }).mode, 'staging');
});

test('write mode requires opt-in, distinct prefixed accounts, and environment credentials', () => {
  const env = {
    ...base,
    SMOKE_TEST_WRITE_CONFIRMATION: harness.WRITE_CONFIRMATION,
    SMOKE_TEST_PUBLISHABLE_KEY: 'synthetic-public-key',
    SMOKE_TEST_ADMIN_EMAIL: 'smoke_test_admin@example.invalid', SMOKE_TEST_ADMIN_PASSWORD: 'synthetic-admin-password',
    SMOKE_TEST_AGENT_A_EMAIL: 'smoke_test_a@example.invalid', SMOKE_TEST_AGENT_A_PASSWORD: 'synthetic-agent-a-password',
    SMOKE_TEST_AGENT_B_EMAIL: 'smoke_test_b@example.invalid', SMOKE_TEST_AGENT_B_PASSWORD: 'synthetic-agent-b-password'
  };
  assert.equal(harness.readConfig(env, { runId: 'abc123def456' }).accounts.admin.role, 'admin');
  assert.throws(() => harness.readConfig({ ...env, SMOKE_TEST_WRITE_CONFIRMATION: '' }, { runId: 'abc123def456' }), /WRITE_OPT_IN_REQUIRED/);
  assert.throws(() => harness.readConfig({ ...env, SMOKE_TEST_AGENT_B_EMAIL: env.SMOKE_TEST_AGENT_A_EMAIL }, { runId: 'abc123def456' }), /MUST_BE_DISTINCT/);
  assert.throws(() => harness.readConfig({ ...env, SMOKE_TEST_AGENT_B_EMAIL: 'real@example.invalid' }, { runId: 'abc123def456' }), /PREFIX_REQUIRED/);
});

test('run plan scopes every identifier and cleanup confirmation to one run', () => {
  const plan = harness.buildPlan('abc123def456');
  assert.equal(plan.marker, 'SMOKE_TEST:abc123def456');
  assert.ok(plan.assignedPlayerId.startsWith('SMOKE_TEST_abc123def456_'));
  assert.ok(plan.otherPlayerId.startsWith('SMOKE_TEST_abc123def456_'));
  assert.equal(plan.cleanupConfirmation, 'DELETE_SMOKE_TEST_abc123def456');
  assert.throws(() => harness.buildPlan('../unsafe'), /INVALID_SMOKE_RUN_ID/);
});

test('cleanup SQL is admin-only and deletes only triple-matched players', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'smoke-test-harness.sql'), 'utf8');
  assert.match(sql, /v_actor\.role <> 'admin'/);
  assert.match(sql, /left\(p\.id, char_length\(v_prefix\)\) = v_prefix/);
  assert.match(sql, /p\.messenger = v_marker/);
  assert.match(sql, /p\.created_by = v_actor\.id/);
  assert.equal((sql.match(/delete\s+from/gi) || []).length, 1);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.(profiles|player_comments|player_status_history)/i);
});

test('ordinary CI never invokes a credentialed runtime smoke test', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'quality-gates.yml'), 'utf8');
  assert.doesNotMatch(workflow, /Invoke-RuntimeSmokeTest|runtime-smoke\.cjs|SMOKE_TEST_PUBLISHABLE_KEY/);
  assert.match(workflow, /check-runtime-smoke-harness\.ps1/);
});
