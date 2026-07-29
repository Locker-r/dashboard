'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { SupabaseDataService } = require('../src/data/supabase-data-service.js');

const PREFIX = 'SMOKE_TEST';
const WRITE_CONFIRMATION = 'I_UNDERSTAND_SMOKE_TEST_WRITES';
const STAGING_CONFIRMATION = 'STAGING_ONLY_NOT_PRODUCTION';
const RUN_ID_PATTERN = /^[a-z0-9]{12,40}$/;

function normalizeUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('PROJECT_URL_MUST_BE_ORIGIN');
  return parsed.origin;
}

function isLoopback(url) {
  const parsed = new URL(url);
  return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
}

function validateRunId(value) {
  const runId = String(value || '');
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('INVALID_SMOKE_RUN_ID');
  return runId;
}

function readConfig(env, options = {}) {
  const mode = String(env.SMOKE_TEST_MODE || '').toLowerCase();
  if (!['local', 'staging'].includes(mode)) throw new Error('SMOKE_TEST_MODE_MUST_BE_LOCAL_OR_STAGING');
  const projectUrl = normalizeUrl(env.SMOKE_TEST_PROJECT_URL);
  const allowedUrl = normalizeUrl(env.SMOKE_TEST_ALLOWED_PROJECT_URL);
  if (projectUrl !== allowedUrl) throw new Error('PROJECT_URL_NOT_ALLOWLISTED');
  if (mode === 'local' && !isLoopback(projectUrl)) throw new Error('LOCAL_MODE_REQUIRES_LOOPBACK_URL');
  if (mode === 'staging') {
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(projectUrl)) throw new Error('STAGING_REQUIRES_SUPABASE_PROJECT_URL');
    if (env.SMOKE_TEST_STAGING_CONFIRMATION !== STAGING_CONFIRMATION) throw new Error('STAGING_OPT_IN_REQUIRED');
  }
  const runId = validateRunId(options.runId || env.SMOKE_TEST_RUN_ID || crypto.randomBytes(10).toString('hex'));
  const config = { mode, projectUrl, allowedUrl, runId };
  if (options.dryRun) return config;
  if (env.SMOKE_TEST_WRITE_CONFIRMATION !== WRITE_CONFIRMATION) throw new Error('WRITE_OPT_IN_REQUIRED');
  const required = [
    'SMOKE_TEST_PUBLISHABLE_KEY', 'SMOKE_TEST_ADMIN_EMAIL', 'SMOKE_TEST_ADMIN_PASSWORD',
    'SMOKE_TEST_AGENT_A_EMAIL', 'SMOKE_TEST_AGENT_A_PASSWORD',
    'SMOKE_TEST_AGENT_B_EMAIL', 'SMOKE_TEST_AGENT_B_PASSWORD'
  ];
  for (const name of required) if (!String(env[name] || '').trim()) throw new Error(`MISSING_${name}`);
  const emails = [env.SMOKE_TEST_ADMIN_EMAIL, env.SMOKE_TEST_AGENT_A_EMAIL, env.SMOKE_TEST_AGENT_B_EMAIL];
  if (new Set(emails.map(value => String(value).toLowerCase())).size !== 3) throw new Error('SMOKE_ACCOUNTS_MUST_BE_DISTINCT');
  if (emails.some(value => !String(value).toLowerCase().startsWith('smoke_test'))) throw new Error('SMOKE_ACCOUNT_PREFIX_REQUIRED');
  return { ...config, publishableKey: env.SMOKE_TEST_PUBLISHABLE_KEY, accounts: {
    admin: { email: env.SMOKE_TEST_ADMIN_EMAIL, password: env.SMOKE_TEST_ADMIN_PASSWORD, role: 'admin' },
    agentA: { email: env.SMOKE_TEST_AGENT_A_EMAIL, password: env.SMOKE_TEST_AGENT_A_PASSWORD, role: 'agent' },
    agentB: { email: env.SMOKE_TEST_AGENT_B_EMAIL, password: env.SMOKE_TEST_AGENT_B_PASSWORD, role: 'agent' }
  } };
}

function buildPlan(runId) {
  validateRunId(runId);
  const prefix = `${PREFIX}_${runId}_`;
  return Object.freeze({
    runId, prefix, markerPrefix: `${PREFIX}:${runId}`,
    assignedMarker: `${PREFIX}:${runId}:assigned`, otherMarker: `${PREFIX}:${runId}:other`,
    assignedPlayerId: `${prefix}assigned`, otherPlayerId: `${prefix}other`,
    historyId: `${prefix}history`, commentId: `${prefix}comment`,
    followUpAt: '2030-01-15T10:30:00.000Z',
    cleanupConfirmation: `DELETE_SMOKE_TEST_${runId}`
  });
}

function buildPlayers(plan) {
  return [
    { id: plan.assignedPlayerId, email: `smoke_test_${plan.runId}_assigned@example.invalid`, messenger: plan.assignedMarker },
    { id: plan.otherPlayerId, email: `smoke_test_${plan.runId}_other@example.invalid`, messenger: plan.otherMarker }
  ];
}

function clientFor(config) {
  return createClient(config.projectUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

async function signIn(config, account) {
  const client = clientFor(config);
  const result = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (result.error) throw result.error;
  const profile = await client.from('profiles').select('id,role,is_active').eq('id', result.data.user.id).single();
  if (profile.error) throw profile.error;
  if (!profile.data.is_active || profile.data.role !== account.role) throw new Error(`UNEXPECTED_${account.role.toUpperCase()}_PROFILE`);
  return { client, id: result.data.user.id };
}

async function expectRpcFailure(client, name, parameters, expected) {
  const result = await client.rpc(name, parameters);
  if (!result.error || !String(result.error.message || '').includes(expected)) throw new Error(`EXPECTED_${expected}`);
}

async function cleanup(adminClient, plan) {
  const result = await adminClient.rpc('cleanup_smoke_test_run_atomic', {
    p_run_id: plan.runId, p_confirmation: plan.cleanupConfirmation
  });
  if (result.error) throw result.error;
  return result.data;
}

async function assertRunEmpty(adminClient, plan) {
  const result = await adminClient.from('players').select('id').in('id', [plan.assignedPlayerId, plan.otherPlayerId]);
  if (result.error) throw result.error;
  if (result.data.length !== 0) throw new Error('SMOKE_CLEANUP_INCOMPLETE');
}

async function runSmoke(config) {
  const plan = buildPlan(config.runId);
  const sessions = [];
  let admin;
  let stage = 'sign_in_admin';
  let failure = null;
  let outcome = null;
  try {
    admin = await signIn(config, config.accounts.admin); sessions.push(admin.client);
    stage = 'sign_in_agent_a';
    const agentA = await signIn(config, config.accounts.agentA); sessions.push(agentA.client);
    stage = 'sign_in_agent_b';
    const agentB = await signIn(config, config.accounts.agentB); sessions.push(agentB.client);
    const adminData = new SupabaseDataService(admin.client);
    const agentData = new SupabaseDataService(agentA.client);

    stage = 'pre_run_cleanup';
    await cleanup(admin.client, plan);
    stage = 'create_players_atomic';
    await adminData.createPlayers(buildPlayers(plan));
    stage = 'assign_agent_a';
    await adminData.assignPlayers([plan.assignedPlayerId], [agentA.id]);
    stage = 'assign_agent_b';
    await adminData.assignPlayers([plan.otherPlayerId], [agentB.id]);

    stage = 'verify_agent_rls';
    const visibleToAgent = await agentA.client.from('players').select('id,status,agent_id').in('id', [plan.assignedPlayerId, plan.otherPlayerId]);
    if (visibleToAgent.error) throw visibleToAgent.error;
    if (visibleToAgent.data.length !== 1 || visibleToAgent.data[0].id !== plan.assignedPlayerId) throw new Error('AGENT_RLS_VISIBILITY_FAILED');

    stage = 'change_player_status_atomic';
    await agentData.changePlayerStatus(plan.assignedPlayerId, 'in_work', plan.historyId);
    stage = 'verify_status_history';
    const history = await admin.client.from('player_status_history').select('id,player_id,from_status,to_status').eq('player_id', plan.assignedPlayerId);
    if (history.error) throw history.error;
    if (history.data.length !== 1 || history.data[0].id !== plan.historyId || history.data[0].from_status !== 'assigned' || history.data[0].to_status !== 'in_work') throw new Error('STATUS_HISTORY_ASSERTION_FAILED');

    stage = 'add_player_comment_atomic';
    await agentData.addPlayerComment(plan.assignedPlayerId, plan.commentId, `${PREFIX}:${plan.runId}:comment`);
    stage = 'set_player_follow_up_atomic';
    await agentData.setPlayerFollowUp(plan.assignedPlayerId, plan.followUpAt);
    stage = 'reject_invalid_transition';
    await expectRpcFailure(agentA.client, 'change_player_status_atomic', {
      p_player_id: plan.assignedPlayerId, p_next_status: 'assigned', p_history_id: `${plan.historyId}_invalid`, p_confirm_reopen: false
    }, 'INVALID_STATUS_TRANSITION');
    stage = 'reject_cross_agent_write';
    await expectRpcFailure(agentA.client, 'set_player_follow_up_atomic', {
      p_player_id: plan.otherPlayerId, p_follow_up_at: plan.followUpAt
    }, 'NOT_OWNER');

    stage = 'verify_admin_visibility';
    const adminPlayers = await admin.client.from('players').select('id,status,agent_id,follow_up_at').in('id', [plan.assignedPlayerId, plan.otherPlayerId]);
    if (adminPlayers.error) throw adminPlayers.error;
    if (adminPlayers.data.length !== 2 || new Set(adminPlayers.data.map(row => row.id)).size !== 2) throw new Error('ADMIN_VISIBILITY_OR_DUPLICATE_ASSERTION_FAILED');
    const assigned = adminPlayers.data.find(row => row.id === plan.assignedPlayerId);
    if (!assigned || assigned.status !== 'in_work' || assigned.agent_id !== agentA.id || new Date(assigned.follow_up_at).toISOString() !== plan.followUpAt) throw new Error('ASSIGNED_PLAYER_ASSERTION_FAILED');
    stage = 'verify_comment';
    const comments = await admin.client.from('player_comments').select('id,player_id,text').eq('player_id', plan.assignedPlayerId);
    if (comments.error) throw comments.error;
    if (comments.data.length !== 1 || comments.data[0].id !== plan.commentId) throw new Error('COMMENT_ASSERTION_FAILED');

    stage = 'reject_duplicate';
    await expectRpcFailure(admin.client, 'create_players_atomic', { p_players: [{
      id: plan.assignedPlayerId, email: `smoke_test_${plan.runId}_duplicate@example.invalid`, messenger: plan.assignedMarker
    }] }, 'PLAYER_ID_CONFLICT');
    outcome = { ok: true, runId: plan.runId };
  } catch (error) {
    failure = new Error(`stage=${stage} run_id=${plan.runId} error=${String(error && error.message || error)}`);
  } finally {
    if (admin) {
      try {
        await cleanup(admin.client, plan);
        await assertRunEmpty(admin.client, plan);
      } catch (error) {
        const cleanupMessage = `cleanup_error=${String(error && error.message || error)}`;
        failure = new Error(failure ? `${failure.message} ${cleanupMessage}` : `stage=final_cleanup run_id=${plan.runId} ${cleanupMessage}`);
      }
    }
    await Promise.allSettled(sessions.map(client => client.auth.signOut({ scope: 'local' })));
  }
  if (failure) throw failure;
  return outcome;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cleanupOnly = args.includes('--cleanup');
  const checkConfig = args.includes('--check-config');
  const config = readConfig(process.env, { dryRun, runId: argumentValue(args, '--run-id') });
  const plan = buildPlan(config.runId);
  if (dryRun) {
    console.log(`Dry run passed: mode=${config.mode}, run_id=${plan.runId}, writes=0`);
    return;
  }
  if (checkConfig) {
    console.log(`Configuration passed: mode=${config.mode}, run_id=${plan.runId}`);
    return;
  }
  if (cleanupOnly) {
    const admin = await signIn(config, config.accounts.admin);
    try { await cleanup(admin.client, plan); await assertRunEmpty(admin.client, plan); }
    finally { await admin.client.auth.signOut({ scope: 'local' }); }
    console.log(`Cleanup passed: run_id=${plan.runId}`);
    return;
  }
  const result = await runSmoke(config);
  console.log(`Runtime smoke test passed: run_id=${result.runId}`);
}

if (require.main === module) main().catch(error => {
  console.error(`Runtime smoke test failed: ${String(error && error.message || error)}`);
  process.exitCode = 1;
});

module.exports = { PREFIX, WRITE_CONFIRMATION, STAGING_CONFIRMATION, RUN_ID_PATTERN, normalizeUrl, isLoopback, validateRunId, readConfig, buildPlan, buildPlayers };
