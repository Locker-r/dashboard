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
  assert.equal(plan.markerPrefix, 'SMOKE_TEST:abc123def456');
  assert.equal(plan.assignedMarker, 'SMOKE_TEST:abc123def456:assigned');
  assert.equal(plan.otherMarker, 'SMOKE_TEST:abc123def456:other');
  assert.ok(plan.assignedPlayerId.startsWith('SMOKE_TEST_abc123def456_'));
  assert.ok(plan.otherPlayerId.startsWith('SMOKE_TEST_abc123def456_'));
  assert.equal(plan.cleanupConfirmation, 'DELETE_SMOKE_TEST_abc123def456');
  assert.throws(() => harness.buildPlan('../unsafe'), /INVALID_SMOKE_RUN_ID/);
});

test('each player has a unique contact while retaining the run cleanup prefix', () => {
  const plan = harness.buildPlan('abc123def456');
  const players = harness.buildPlayers(plan);
  assert.equal(players.length, 2);
  assert.equal(new Set(players.map(player => player.email)).size, 2);
  assert.equal(new Set(players.map(player => player.messenger)).size, 2);
  assert.ok(players.every(player => player.messenger.startsWith(`${plan.markerPrefix}:`)));
});

test('cleanup SQL is admin-only and deletes only triple-matched players', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'smoke-test-harness.sql'), 'utf8');
  assert.match(sql, /v_actor\.role <> 'admin'/);
  assert.match(sql, /left\(p\.id, char_length\(v_prefix\)\) = v_prefix/);
  assert.match(sql, /left\(p\.messenger, char_length\(v_marker\) \+ 1\) = v_marker \|\| ':'/);
  assert.match(sql, /p\.created_by = v_actor\.id/);
  assert.equal((sql.match(/delete\s+from/gi) || []).length, 1);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.(profiles|player_comments|player_status_history)/i);
});

test('runtime failures identify the safe stage and run id and always enter cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'runtime-smoke.cjs'), 'utf8');
  assert.match(source, /stage=\$\{stage\} run_id=\$\{plan\.runId\}/);
  assert.match(source, /finally \{\s+if \(admin\) \{/);
  assert.doesNotMatch(source, /writesStarted/);
});

test('ordinary CI never invokes a credentialed runtime smoke test', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'quality-gates.yml'), 'utf8');
  assert.doesNotMatch(workflow, /Invoke-RuntimeSmokeTest|runtime-smoke\.cjs|SMOKE_TEST_PUBLISHABLE_KEY/);
  assert.match(workflow, /check-runtime-smoke-harness\.ps1/);
});

/* ==================== contact protection, proof/closure, security negatives ==================== */

function runtimeSmokeSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'scripts', 'runtime-smoke.cjs'), 'utf8');
}

test('contact protection is checked before the in_work transition and re-checked after', () => {
  const source = runtimeSmokeSource();
  const lockedIndex = source.indexOf("stage = 'verify_contact_locked_before_in_work'");
  const rawForbiddenIndex = source.indexOf("stage = 'verify_raw_contact_columns_forbidden'");
  const transitionIndex = source.indexOf("stage = 'change_player_status_atomic'");
  const eligibleIndex = source.indexOf("stage = 'verify_contact_eligible_after_in_work'");
  assert.ok(lockedIndex >= 0 && rawForbiddenIndex >= 0 && transitionIndex >= 0 && eligibleIndex >= 0);
  assert.ok(lockedIndex < rawForbiddenIndex && rawForbiddenIndex < transitionIndex && transitionIndex < eligibleIndex,
    'contact must be proven locked, then raw columns proven forbidden, before the in_work transition, then proven eligible after it');
});

test('contact protection is asserted against the server-computed gate and the raw column grant, not just the UI', () => {
  const source = runtimeSmokeSource();
  assert.match(source, /players_secure['"][\s\S]{0,120}contact_access_state/);
  assert.match(source, /CONTACT_NOT_LOCKED_BEFORE_IN_WORK/);
  assert.match(source, /CONTACT_NOT_MASKED_BEFORE_IN_WORK/);
  assert.match(source, /CONTACT_NOT_ELIGIBLE_AFTER_IN_WORK/);
  // The raw-column attempt must expect an error (RLS/grant enforcement), not
  // merely observe that the UI would have hidden the values.
  assert.match(source, /from\('players'\)\.select\('phone,email,messenger'\)/);
  assert.match(source, /RAW_CONTACT_COLUMNS_NOT_FORBIDDEN/);
});

test('closing without proof is rejected before any proof is created', () => {
  const source = runtimeSmokeSource();
  const rejectIndex = source.indexOf("stage = 'reject_close_without_proof'");
  const requestProofIndex = source.indexOf("stage = 'request_lead_proof_upload'");
  assert.ok(rejectIndex >= 0 && requestProofIndex >= 0 && rejectIndex < requestProofIndex);
  assert.match(source, /PROOF_REQUIRED/);
});

test('the proof flow uploads through the real reviewed RPC and storage path, in order', () => {
  const source = runtimeSmokeSource();
  const order = [
    "stage = 'request_lead_proof_upload'",
    "stage = 'upload_proof_object'",
    "stage = 'confirm_lead_proof'",
    "stage = 'verify_proof_private_from_other_agent'",
    "stage = 'close_lead_with_proof'",
    "stage = 'verify_admin_proof_visibility'",
    "stage = 'verify_admin_final_result'"
  ];
  let cursor = -1;
  for (const marker of order) {
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `missing stage: ${marker}`);
    assert.ok(index > cursor, `${marker} must come after the previous stage`);
    cursor = index;
  }
  assert.match(source, /request_lead_proof_upload'/);
  assert.match(source, /\.storage\.from\('lead-proofs'\)\.upload\(/);
  assert.match(source, /confirm_lead_proof'/);
  assert.match(source, /PROOF_NOT_PRIVATE_TO_OTHER_AGENT/);
});

test('proof privacy is checked by attempting a real download as a non-owning agent, not asserted from configuration alone', () => {
  const source = runtimeSmokeSource();
  assert.match(source, /agentB\.client\.storage\.from\('lead-proofs'\)\.download\(storagePath\)/);
  assert.match(source, /if \(!otherAgentDownload\.error\) throw new Error\('PROOF_NOT_PRIVATE_TO_OTHER_AGENT'\)/);
});

test('the security negatives cover anonymous data read, anonymous proof access, and an unauthorized team-management call', () => {
  const source = runtimeSmokeSource();
  assert.match(source, /ANONYMOUS_PLAYER_READ_NOT_DENIED/);
  assert.match(source, /ANONYMOUS_PROFILE_READ_NOT_DENIED/);
  assert.match(source, /ANONYMOUS_PROOF_ACCESS_NOT_DENIED/);
  assert.match(source, /UNAUTHORIZED_TEAM_MANAGEMENT_NOT_DENIED/);
  // The anonymous client must be unauthenticated — built with the same public
  // config as everything else, not signed in as any account.
  assert.match(source, /const anonClient = clientFor\(config\)/);
  assert.match(source, /functions\/v1\/team-management/);
  assert.match(source, /if \(unauthorized\.status !== 401\)/);
});

test('the security negatives run after the proof flow, while the proof object still exists to probe', () => {
  const source = runtimeSmokeSource();
  const closeIndex = source.indexOf("stage = 'close_lead_with_proof'");
  const anonReadIndex = source.indexOf("stage = 'verify_anonymous_read_denied'");
  const anonProofIndex = source.indexOf("stage = 'verify_anonymous_proof_access_denied'");
  assert.ok(closeIndex >= 0 && anonReadIndex >= 0 && anonProofIndex >= 0);
  assert.ok(closeIndex < anonReadIndex && anonReadIndex < anonProofIndex);
});

test('no new stage bypasses the existing cleanup contract', () => {
  const source = runtimeSmokeSource();
  // The added stages must all still live inside the same try block that the
  // existing finally-cleanup covers — outcome is only set once, at the very end.
  assert.equal((source.match(/outcome = \{ ok: true, runId: plan\.runId \};/g) || []).length, 1);
  const outcomeIndex = source.indexOf('outcome = { ok: true, runId: plan.runId };');
  const lastNewStageIndex = source.lastIndexOf("stage = 'verify_unauthorized_team_management_denied'");
  assert.ok(lastNewStageIndex >= 0 && lastNewStageIndex < outcomeIndex);
});
