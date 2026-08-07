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
  return { client, id: result.data.user.id, token: result.data.session.access_token };
}

async function expectRpcFailure(client, name, parameters, expected) {
  const result = await client.rpc(name, parameters);
  if (!result.error || !String(result.error.message || '').includes(expected)) throw new Error(`EXPECTED_${expected}`);
}

// The reviewed team-management action an admin uses from the UI, called
// directly with an already-issued session token — never the service role.
async function callTeamManagement(config, token, body) {
  const response = await fetch(`${config.projectUrl}/functions/v1/team-management`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, body: parsed };
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

    // Contact protection is a server-computed gate (players_secure.contact_access_state),
    // not a client-side choice, and the raw columns are unreachable regardless of
    // status: the column grant on public.players never includes phone/email/messenger
    // (see supabase/migrations/20260801000200_revoke_raw_contacts.sql). Both facts are
    // asserted here, before the lead has ever reached in_work.
    stage = 'verify_contact_locked_before_in_work';
    const lockedSecure = await agentA.client.from('players_secure')
      .select('id,contact_access_state,has_email,has_messenger,email_display,messenger_display')
      .eq('id', plan.assignedPlayerId).single();
    if (lockedSecure.error) throw lockedSecure.error;
    if (lockedSecure.data.contact_access_state !== 'locked') throw new Error('CONTACT_NOT_LOCKED_BEFORE_IN_WORK');
    const assignedPlayerFixture = buildPlayers(plan)[0];
    if (lockedSecure.data.email_display === assignedPlayerFixture.email
      || lockedSecure.data.messenger_display === assignedPlayerFixture.messenger) {
      throw new Error('CONTACT_NOT_MASKED_BEFORE_IN_WORK');
    }
    stage = 'verify_raw_contact_columns_forbidden';
    const rawContactAttempt = await agentA.client.from('players').select('phone,email,messenger').eq('id', plan.assignedPlayerId).maybeSingle();
    if (!rawContactAttempt.error) throw new Error('RAW_CONTACT_COLUMNS_NOT_FORBIDDEN');

    stage = 'change_player_status_atomic';
    await agentData.changePlayerStatus(plan.assignedPlayerId, 'in_work', plan.historyId);
    stage = 'verify_status_history';
    const history = await admin.client.from('player_status_history').select('id,player_id,from_status,to_status').eq('player_id', plan.assignedPlayerId);
    if (history.error) throw history.error;
    if (history.data.length !== 1 || history.data[0].id !== plan.historyId || history.data[0].from_status !== 'assigned' || history.data[0].to_status !== 'in_work') throw new Error('STATUS_HISTORY_ASSERTION_FAILED');

    stage = 'verify_contact_eligible_after_in_work';
    const eligibleSecure = await agentA.client.from('players_secure').select('id,contact_access_state').eq('id', plan.assignedPlayerId).single();
    if (eligibleSecure.error) throw eligibleSecure.error;
    if (eligibleSecure.data.contact_access_state !== 'eligible') throw new Error('CONTACT_NOT_ELIGIBLE_AFTER_IN_WORK');

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

    stage = 'reject_close_without_proof';
    await expectRpcFailure(agentA.client, 'change_player_status_atomic', {
      p_player_id: plan.assignedPlayerId, p_next_status: 'success', p_history_id: `${plan.historyId}_close_no_proof`, p_confirm_reopen: false
    }, 'PROOF_REQUIRED');

    // MIME allowlist and the 10 MB declared-size ceiling are enforced inside
    // request_lead_proof_upload itself — proven directly against that RPC,
    // not by reading the bucket's admin configuration (which needs the
    // service role this harness never holds).
    stage = 'reject_disallowed_mime_type';
    await expectRpcFailure(agentA.client, 'request_lead_proof_upload', {
      p_player_id: plan.assignedPlayerId, p_proof_id: crypto.randomUUID(),
      p_filename: 'evidence.txt', p_mime_type: 'text/plain', p_file_size: 10
    }, 'INVALID_FILE_TYPE');
    stage = 'reject_oversized_declared_file';
    await expectRpcFailure(agentA.client, 'request_lead_proof_upload', {
      p_player_id: plan.assignedPlayerId, p_proof_id: crypto.randomUUID(),
      p_filename: 'evidence.png', p_mime_type: 'image/png', p_file_size: 10485761
    }, 'FILE_TOO_LARGE');

    // A tiny, real 1x1 PNG — request_lead_proof_upload validates the MIME type
    // against a fixed allowlist and confirm_lead_proof re-derives size and MIME
    // from the uploaded object itself, not from what the caller declares.
    stage = 'request_lead_proof_upload';
    const proofId = crypto.randomUUID();
    const proofBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'
    );
    const requestedProof = await agentA.client.rpc('request_lead_proof_upload', {
      p_player_id: plan.assignedPlayerId, p_proof_id: proofId, p_filename: `${plan.markerPrefix}.png`,
      p_mime_type: 'image/png', p_file_size: proofBytes.length
    });
    if (requestedProof.error) throw requestedProof.error;
    const storagePath = requestedProof.data.storage_path;

    stage = 'upload_proof_object';
    const uploadedProof = await agentA.client.storage.from('lead-proofs').upload(storagePath, proofBytes, { contentType: 'image/png', upsert: false });
    if (uploadedProof.error) throw uploadedProof.error;

    stage = 'confirm_lead_proof';
    const confirmedProof = await agentA.client.rpc('confirm_lead_proof', { p_proof_id: proofId });
    if (confirmedProof.error) throw confirmedProof.error;
    if (confirmedProof.data.state !== 'active') throw new Error('PROOF_NOT_ACTIVE_AFTER_CONFIRM');

    // Signed-URL minting runs on the caller's own session (admin qualifies via
    // is_admin() on the same storage SELECT policy that gates download), not
    // the service role — a cross-agent, non-admin actor must be refused the
    // same way a direct download already is.
    stage = 'verify_signed_url_access';
    const adminSigned = await admin.client.storage.from('lead-proofs').createSignedUrl(storagePath, 60);
    if (adminSigned.error || !adminSigned.data || !adminSigned.data.signedUrl) throw new Error('ADMIN_SIGNED_URL_FAILED');
    const signedFetch = await fetch(adminSigned.data.signedUrl);
    if (!signedFetch.ok) throw new Error('ADMIN_SIGNED_URL_NOT_USABLE');
    const otherAgentSigned = await agentB.client.storage.from('lead-proofs').createSignedUrl(storagePath, 60);
    if (!otherAgentSigned.error) throw new Error('CROSS_AGENT_SIGNED_URL_NOT_DENIED');

    stage = 'verify_proof_private_from_other_agent';
    const otherAgentDownload = await agentB.client.storage.from('lead-proofs').download(storagePath);
    if (!otherAgentDownload.error) throw new Error('PROOF_NOT_PRIVATE_TO_OTHER_AGENT');

    stage = 'close_lead_with_proof';
    const closeHistoryId = `${plan.historyId}_close`;
    await agentData.changePlayerStatus(plan.assignedPlayerId, 'success', closeHistoryId);

    stage = 'verify_close_audit_actor';
    const closeHistory = await admin.client.from('player_status_history')
      .select('id,from_status,to_status,user_id').eq('id', closeHistoryId).single();
    if (closeHistory.error) throw closeHistory.error;
    if (closeHistory.data.from_status !== 'in_work' || closeHistory.data.to_status !== 'success'
      || closeHistory.data.user_id !== agentA.id) throw new Error('CLOSE_AUDIT_ACTOR_MISMATCH');

    // Confirmation locks the bytes: the storage update/delete policies only
    // admit a write while the owning proof row is still 'pending', so once
    // confirm_lead_proof has flipped it to 'active' even the uploader's own
    // session must be refused.
    stage = 'verify_proof_immutable_after_close';
    const overwriteAttempt = await agentA.client.storage.from('lead-proofs')
      .upload(storagePath, proofBytes, { contentType: 'image/png', upsert: true });
    if (!overwriteAttempt.error) throw new Error('CONFIRMED_PROOF_OVERWRITE_NOT_DENIED');
    const removeAttempt = await agentA.client.storage.from('lead-proofs').remove([storagePath]);
    const removeBlocked = Boolean(removeAttempt.error) || !(removeAttempt.data || []).length;
    if (!removeBlocked) throw new Error('CONFIRMED_PROOF_DELETE_NOT_DENIED');

    stage = 'verify_admin_proof_visibility';
    const adminProof = await admin.client.from('lead_proofs').select('id,player_id,state,uploaded_by,mime_type')
      .eq('player_id', plan.assignedPlayerId).eq('state', 'active').maybeSingle();
    if (adminProof.error) throw adminProof.error;
    if (!adminProof.data || adminProof.data.id !== proofId || adminProof.data.uploaded_by !== agentA.id) throw new Error('ADMIN_PROOF_VISIBILITY_FAILED');

    stage = 'verify_admin_final_result';
    const closedPlayer = await admin.client.from('players').select('id,status').eq('id', plan.assignedPlayerId).single();
    if (closedPlayer.error) throw closedPlayer.error;
    if (closedPlayer.data.status !== 'success') throw new Error('FINAL_RESULT_NOT_VISIBLE');

    stage = 'verify_anonymous_read_denied';
    const anonClient = clientFor(config);
    const anonPlayers = await anonClient.from('players').select('id').eq('id', plan.assignedPlayerId);
    if (!anonPlayers.error) throw new Error('ANONYMOUS_PLAYER_READ_NOT_DENIED');
    const anonProfiles = await anonClient.from('profiles').select('id').limit(1);
    if (!anonProfiles.error) throw new Error('ANONYMOUS_PROFILE_READ_NOT_DENIED');

    stage = 'verify_anonymous_proof_access_denied';
    const anonProofDownload = await anonClient.storage.from('lead-proofs').download(storagePath);
    if (!anonProofDownload.error) throw new Error('ANONYMOUS_PROOF_ACCESS_NOT_DENIED');

    stage = 'verify_unauthorized_team_management_denied';
    const unauthorized = await fetch(`${config.projectUrl}/functions/v1/team-management`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list-members' })
    });
    if (unauthorized.status !== 401) throw new Error('UNAUTHORIZED_TEAM_MANAGEMENT_NOT_DENIED');

    // A deactivated agent's already-issued JWT must lose proof access
    // immediately — require_active_profile() is re-checked on every RPC, not
    // only at sign-in. Run last: it reassigns agent B's lead to agent A,
    // which would confuse the ownership assertions earlier in this run.
    stage = 'transition_other_lead_to_in_work';
    const otherToWork = await agentB.client.rpc('change_player_status_atomic', {
      p_player_id: plan.otherPlayerId, p_next_status: 'in_work', p_history_id: `${plan.historyId}_b_in_work`, p_confirm_reopen: false
    });
    if (otherToWork.error) throw otherToWork.error;

    stage = 'verify_active_agent_can_request_proof';
    const activeRequest = await agentB.client.rpc('request_lead_proof_upload', {
      p_player_id: plan.otherPlayerId, p_proof_id: crypto.randomUUID(),
      p_filename: `${plan.markerPrefix}_b.png`, p_mime_type: 'image/png', p_file_size: proofBytes.length
    });
    if (activeRequest.error) throw activeRequest.error;

    stage = 'deactivate_agent_via_team_management';
    const deactivated = await callTeamManagement(config, admin.token, {
      action: 'set-member-active', memberId: agentB.id, isActive: false,
      reassignTo: agentA.id, requestId: crypto.randomUUID()
    });
    if (deactivated.status !== 200 || !deactivated.body || deactivated.body.ok !== true) {
      throw new Error(`DEACTIVATE_AGENT_FAILED:${deactivated.status}`);
    }

    // The same session from sign_in_agent_b, never refreshed or re-issued.
    stage = 'verify_deactivated_agent_denied_with_live_token';
    await expectRpcFailure(agentB.client, 'request_lead_proof_upload', {
      p_player_id: plan.otherPlayerId, p_proof_id: crypto.randomUUID(),
      p_filename: `${plan.markerPrefix}_b2.png`, p_mime_type: 'image/png', p_file_size: proofBytes.length
    }, 'ACTIVE_PROFILE_REQUIRED');

    stage = 'reactivate_agent_via_team_management';
    const reactivated = await callTeamManagement(config, admin.token, {
      action: 'set-member-active', memberId: agentB.id, isActive: true, reassignTo: null, requestId: crypto.randomUUID()
    });
    if (reactivated.status !== 200 || !reactivated.body || reactivated.body.ok !== true) {
      throw new Error(`REACTIVATE_AGENT_FAILED:${reactivated.status}`);
    }

    stage = 'verify_reactivated_agent_regains_access';
    const revivedRead = await agentB.client.from('lead_proofs').select('id').limit(1);
    if (revivedRead.error) throw revivedRead.error;

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
