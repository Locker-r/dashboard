'use strict';
// Runtime security verification for the mandatory closing proof (B1).
//
// Every assertion below runs against a live local stack using a real per-user
// JWT, never the service role. The point is to prove that the guarantees hold
// against the HTTP surface an attacker actually has: PostgREST, the Storage
// API and the RPCs, with the frontend removed from the picture entirely.
const { createClient } = require('@supabase/supabase-js');
const { normalizeUrl, isLoopback, buildPlan } = require('./runtime-smoke.cjs');
const randomId = () => require('node:crypto').randomUUID();

const BUCKET = 'lead-proofs';
// A real 1x1 PNG, so the Storage API records a genuine image/png metadata entry.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const failures = [];
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); return true; }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
  console.log(`  FAIL  ${name} :: ${detail || ''}`);
  return false;
}

function errorText(result) {
  const error = result && result.error;
  return String((error && (error.message || error.error || error.code)) || '');
}

function refused(name, result, expected) {
  const text = errorText(result);
  return check(name, Boolean(result && result.error) && (!expected || text.includes(expected)),
    result && result.error ? `got "${text}"` : 'the call SUCCEEDED but must have been refused');
}

async function signIn(url, key, email, password) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error || !result.data.session) throw result.error || new Error('SIGN_IN_FAILED');
  return { client, user: result.data.user, token: result.data.session.access_token };
}

// Drives the approved three-step flow to a confirmed, active proof.
async function uploadProof(session, playerId, options = {}) {
  const proofId = options.proofId || randomId();
  const granted = await session.client.rpc('request_lead_proof_upload', {
    p_player_id: playerId, p_proof_id: proofId,
    p_filename: options.filename || 'evidence.png',
    p_mime_type: options.mimeType || 'image/png',
    p_file_size: options.fileSize || PNG_BYTES.length
  });
  if (granted.error) return { error: granted.error, proofId };
  const row = Array.isArray(granted.data) ? granted.data[0] : granted.data;
  const uploaded = await session.client.storage.from(BUCKET)
    .upload(row.storage_path, PNG_BYTES, { contentType: 'image/png', upsert: true });
  if (uploaded.error) return { error: uploaded.error, proofId, path: row.storage_path };
  const confirmed = await session.client.rpc('confirm_lead_proof', { p_proof_id: proofId });
  if (confirmed.error) return { error: confirmed.error, proofId, path: row.storage_path };
  const active = Array.isArray(confirmed.data) ? confirmed.data[0] : confirmed.data;
  return { proofId, path: row.storage_path, row: active };
}

async function main() {
  const url = normalizeUrl(process.env.SMOKE_TEST_PROJECT_URL);
  const key = process.env.SMOKE_TEST_PUBLISHABLE_KEY;
  const plan = buildPlan(process.argv[2]);
  if (!isLoopback(url) || !key) throw new Error('LOCAL_SECURITY_SMOKE_CONFIG_REQUIRED');

  const admin = await signIn(url, key, process.env.SMOKE_TEST_ADMIN_EMAIL, process.env.SMOKE_TEST_ADMIN_PASSWORD);
  const agentA = await signIn(url, key, process.env.SMOKE_TEST_AGENT_A_EMAIL, process.env.SMOKE_TEST_AGENT_A_PASSWORD);
  const agentB = await signIn(url, key, process.env.SMOKE_TEST_AGENT_B_EMAIL, process.env.SMOKE_TEST_AGENT_B_PASSWORD);
  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  // Used only to inspect bucket configuration and to drive the same
  // server-side team RPC the Edge Function uses. Never used to assert an
  // access-control outcome: every such assertion below runs on a user JWT.
  const service = createClient(url, process.env.SMOKE_TEST_LOCAL_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const playerA = plan.assignedPlayerId;
  const playerB = plan.otherPlayerId;

  try {
    console.log('\n[0] seed two leads, one per agent, both in_work');
    const created = await admin.client.rpc('create_players_atomic', { p_players: [
      { id: playerA, email: `smoke_test_${plan.runId}_a@example.invalid`, messenger: `${plan.markerPrefix}:a` },
      { id: playerB, email: `smoke_test_${plan.runId}_b@example.invalid`, messenger: `${plan.markerPrefix}:b` }
    ] });
    if (created.error) throw created.error;
    const assignedA = await admin.client.rpc('assign_players_atomic', { p_player_ids: [playerA], p_agent_ids: [agentA.user.id], p_confirm_final: false });
    if (assignedA.error) throw assignedA.error;
    const assignedB = await admin.client.rpc('assign_players_atomic', { p_player_ids: [playerB], p_agent_ids: [agentB.user.id], p_confirm_final: false });
    if (assignedB.error) throw assignedB.error;
    for (const [session, playerId, tag] of [[agentA, playerA, 'a'], [agentB, playerB, 'b']]) {
      const toWork = await session.client.rpc('change_player_status_atomic', {
        p_player_id: playerId, p_next_status: 'in_work', p_history_id: `${plan.prefix}pw_${tag}`, p_confirm_reopen: false
      });
      if (toWork.error) throw toWork.error;
    }
    check('both leads reached in_work', true);

    console.log('\n[1] closing without a proof is refused by the database');
    refused('agent cannot close as success without a proof',
      await agentA.client.rpc('change_player_status_atomic', {
        p_player_id: playerA, p_next_status: 'success', p_history_id: `${plan.prefix}c1`, p_confirm_reopen: false
      }), 'PROOF_REQUIRED');
    refused('agent cannot close as failed without a proof',
      await agentA.client.rpc('change_player_status_atomic', {
        p_player_id: playerA, p_next_status: 'failed', p_history_id: `${plan.prefix}c2`, p_confirm_reopen: false
      }), 'PROOF_REQUIRED');
    refused('admin cannot close without a proof either',
      await admin.client.rpc('change_player_status_atomic', {
        p_player_id: playerA, p_next_status: 'success', p_history_id: `${plan.prefix}c3`, p_confirm_reopen: false
      }), 'PROOF_REQUIRED');
    const stillInWork = await admin.client.from('players').select('status').eq('id', playerA).single();
    check('the lead is still in_work after the refusals', stillInWork.data && stillInWork.data.status === 'in_work',
      `status=${stillInWork.data && stillInWork.data.status}`);

    console.log('\n[2] no_answer is not a closing status and needs no proof');
    const noAnswer = await agentA.client.rpc('change_player_status_atomic', {
      p_player_id: playerA, p_next_status: 'no_answer', p_history_id: `${plan.prefix}na`, p_confirm_reopen: false
    });
    check('agent may move to no_answer without a proof', !noAnswer.error, errorText(noAnswer));
    const backToAssigned = await agentA.client.rpc('change_player_status_atomic', {
      p_player_id: playerA, p_next_status: 'assigned', p_history_id: `${plan.prefix}ba`, p_confirm_reopen: false
    });
    if (backToAssigned.error) throw backToAssigned.error;
    const backToWork = await agentA.client.rpc('change_player_status_atomic', {
      p_player_id: playerA, p_next_status: 'in_work', p_history_id: `${plan.prefix}bw`, p_confirm_reopen: false
    });
    if (backToWork.error) throw backToWork.error;

    console.log('\n[3] a proof cannot be requested for another agent\'s lead');
    refused('agent A cannot request a proof slot for agent B\'s lead',
      await agentA.client.rpc('request_lead_proof_upload', {
        p_player_id: playerB, p_proof_id: randomId(), p_filename: 'x.png', p_mime_type: 'image/png', p_file_size: 10
      }), 'PROOF_ACCESS_DENIED');
    refused('anon cannot request a proof slot at all',
      await anon.rpc('request_lead_proof_upload', {
        p_player_id: playerA, p_proof_id: randomId(), p_filename: 'x.png', p_mime_type: 'image/png', p_file_size: 10
      }));

    console.log('\n[4] type and size are refused server-side');
    refused('an executable MIME type is refused',
      await agentA.client.rpc('request_lead_proof_upload', {
        p_player_id: playerA, p_proof_id: randomId(), p_filename: 'p.exe', p_mime_type: 'application/x-msdownload', p_file_size: 10
      }), 'INVALID_FILE_TYPE');
    refused('text/plain is refused',
      await agentA.client.rpc('request_lead_proof_upload', {
        p_player_id: playerA, p_proof_id: randomId(), p_filename: 'p.txt', p_mime_type: 'text/plain', p_file_size: 10
      }), 'INVALID_FILE_TYPE');
    refused('an oversized declared file is refused',
      await agentA.client.rpc('request_lead_proof_upload', {
        p_player_id: playerA, p_proof_id: randomId(), p_filename: 'p.png', p_mime_type: 'image/png', p_file_size: 10485761
      }), 'FILE_TOO_LARGE');

    console.log('\n[5] direct table writes cannot forge a proof');
    const forgedId = randomId();
    refused('agent cannot INSERT a proof row directly',
      await agentA.client.from('lead_proofs').insert({
        id: forgedId, player_id: playerA, uploaded_by: agentA.user.id,
        storage_bucket: BUCKET, storage_path: `${agentA.user.id}/${forgedId}.png`,
        mime_type: 'image/png', declared_file_size: 10, state: 'active'
      }));
    refused('anon cannot INSERT a proof row', await anon.from('lead_proofs').insert({
      id: randomId(), player_id: playerA, uploaded_by: agentA.user.id,
      storage_bucket: BUCKET, storage_path: `${agentA.user.id}/${randomId()}.png`,
      mime_type: 'image/png', declared_file_size: 10, state: 'active'
    }));
    refused('agent cannot UPDATE the players table directly to close a lead',
      await agentA.client.from('players').update({ status: 'success' }).eq('id', playerA));

    console.log('\n[6] the approved flow produces one active proof');
    const good = await uploadProof(agentA, playerA);
    check('agent A completed request, upload and confirm', !good.error, good.error && String(good.error.message));
    check('the proof is active with a server-verified size',
      Boolean(good.row) && good.row.state === 'active' && Number(good.row.verified_file_size) === PNG_BYTES.length,
      `state=${good.row && good.row.state} size=${good.row && good.row.verified_file_size}`);
    check('the storage path is two server-generated UUIDs, not a client string',
      new RegExp(`^${agentA.user.id}/[0-9a-f-]{36}\\.png$`).test(good.path || ''), good.path);

    console.log('\n[7] a pending proof does not authorise a close');
    const pendingId = randomId();
    const pendingGrant = await agentB.client.rpc('request_lead_proof_upload', {
      p_player_id: playerB, p_proof_id: pendingId, p_filename: 'later.png', p_mime_type: 'image/png', p_file_size: 10
    });
    check('agent B obtained a pending slot', !pendingGrant.error, errorText(pendingGrant));
    refused('a pending, unconfirmed proof does not allow closing',
      await agentB.client.rpc('change_player_status_atomic', {
        p_player_id: playerB, p_next_status: 'success', p_history_id: `${plan.prefix}pend`, p_confirm_reopen: false
      }), 'PROOF_REQUIRED');
    refused('confirming a proof whose object was never uploaded is refused',
      await agentB.client.rpc('confirm_lead_proof', { p_proof_id: pendingId }), 'PROOF_NOT_READY');

    console.log('\n[8] one agent\'s proof never satisfies another agent\'s lead');
    refused('agent B still cannot close their lead using agent A\'s proof',
      await agentB.client.rpc('change_player_status_atomic', {
        p_player_id: playerB, p_next_status: 'success', p_history_id: `${plan.prefix}cross`, p_confirm_reopen: false
      }), 'PROOF_REQUIRED');
    refused('agent B cannot confirm agent A\'s proof',
      await agentB.client.rpc('confirm_lead_proof', { p_proof_id: good.proofId }), 'PROOF_ACCESS_DENIED');
    refused('agent B cannot discard agent A\'s proof',
      await agentB.client.rpc('discard_lead_proof', { p_proof_id: good.proofId }), 'PROOF_ACCESS_DENIED');

    console.log('\n[9] proof rows are RLS-scoped');
    const bVisible = await agentB.client.from('lead_proofs').select('id,player_id').eq('id', good.proofId);
    check('agent B cannot read agent A\'s proof row', !bVisible.error && bVisible.data.length === 0,
      `rows=${bVisible.data && bVisible.data.length}`);
    const anonVisible = await anon.from('lead_proofs').select('id');
    check('anon reads no proof rows', Boolean(anonVisible.error) || anonVisible.data.length === 0,
      anonVisible.error ? errorText(anonVisible) : `rows=${anonVisible.data.length}`);
    const aVisible = await agentA.client.from('lead_proofs').select('id').eq('id', good.proofId);
    check('agent A reads their own proof row', !aVisible.error && aVisible.data.length === 1, errorText(aVisible));
    const adminVisible = await admin.client.from('lead_proofs').select('id').eq('id', good.proofId);
    check('admin reads the proof row', !adminVisible.error && adminVisible.data.length === 1, errorText(adminVisible));

    console.log('\n[10] storage objects are private and per-owner');
    const anonDownload = await anon.storage.from(BUCKET).download(good.path);
    check('anon cannot download the proof object', Boolean(anonDownload.error), 'anon DOWNLOADED the object');
    const bDownload = await agentB.client.storage.from(BUCKET).download(good.path);
    check('agent B cannot download agent A\'s proof object', Boolean(bDownload.error), 'agent B DOWNLOADED the object');
    const bOverwrite = await agentB.client.storage.from(BUCKET).upload(good.path, PNG_BYTES, { contentType: 'image/png', upsert: true });
    check('agent B cannot overwrite agent A\'s proof object', Boolean(bOverwrite.error), 'agent B OVERWROTE the object');
    const bDelete = await agentB.client.storage.from(BUCKET).remove([good.path]);
    const bDeleteBlocked = Boolean(bDelete.error) || !(bDelete.data || []).length;
    check('agent B cannot delete agent A\'s proof object', bDeleteBlocked, 'agent B DELETED the object');
    const aDownload = await agentA.client.storage.from(BUCKET).download(good.path);
    check('agent A can download their own proof object', !aDownload.error, errorText(aDownload));
    const adminDownload = await admin.client.storage.from(BUCKET).download(good.path);
    check('admin can download the proof object', !adminDownload.error, errorText(adminDownload));
    const anonSigned = await anon.storage.from(BUCKET).createSignedUrl(good.path, 60);
    check('anon cannot mint a signed URL', Boolean(anonSigned.error), 'anon MINTED a signed URL');
    const adminSigned = await admin.client.storage.from(BUCKET).createSignedUrl(good.path, 60);
    check('admin can mint a short-lived signed URL', !adminSigned.error && Boolean(adminSigned.data.signedUrl), errorText(adminSigned));

    console.log('\n[11] the bucket itself is not public');
    // Read the bucket definition with the service role: a user JWT does not see
    // every bucket column, and the question here is what the row actually says.
    const bucketRow = await service.storage.getBucket(BUCKET);
    check('bucket lead-proofs is private', !bucketRow.error && bucketRow.data.public === false,
      `public=${bucketRow.data && bucketRow.data.public}`);
    // The SDK has shipped both camelCase and snake_case for these fields; read
    // whichever this version returns rather than pinning to one spelling.
    const bucketData = bucketRow.data || {};
    const sizeLimit = Number(bucketData.fileSizeLimit ?? bucketData.file_size_limit);
    const mimeTypes = bucketData.allowedMimeTypes ?? bucketData.allowed_mime_types;
    check('bucket enforces the 10 MB limit and the four approved MIME types',
      !bucketRow.error && sizeLimit === 10485760 && Array.isArray(mimeTypes)
        && mimeTypes.slice().sort().join(',') === 'application/pdf,image/jpeg,image/png,image/webp',
      `limit=${sizeLimit} types=${JSON.stringify(mimeTypes)}`);
    const publicUrl = admin.client.storage.from(BUCKET).getPublicUrl(good.path).data.publicUrl;
    const publicFetch = await fetch(publicUrl);
    check('the unsigned public URL does not serve the object', !publicFetch.ok, `status=${publicFetch.status}`);

    console.log('\n[12] closing succeeds with a valid proof');
    const closed = await agentA.client.rpc('change_player_status_atomic', {
      p_player_id: playerA, p_next_status: 'success', p_history_id: `${plan.prefix}ok`, p_confirm_reopen: false
    });
    check('agent A closes the lead with a confirmed proof', !closed.error, errorText(closed));
    const closedRow = await admin.client.from('players').select('status').eq('id', playerA).single();
    check('the lead is now success', closedRow.data && closedRow.data.status === 'success',
      `status=${closedRow.data && closedRow.data.status}`);
    const closeHistory = await admin.client.from('player_status_history')
      .select('id,from_status,to_status,user_id').eq('id', `${plan.prefix}ok`).single();
    check('the close is audited with the real actor',
      !closeHistory.error && closeHistory.data.from_status === 'in_work'
        && closeHistory.data.to_status === 'success' && closeHistory.data.user_id === agentA.user.id,
      errorText(closeHistory));

    console.log('\n[13] evidence is immutable once the lead is closed');
    refused('agent A cannot discard the proof of a closed lead',
      await agentA.client.rpc('discard_lead_proof', { p_proof_id: good.proofId }), 'PROOF_LOCKED_AFTER_CLOSE');
    refused('agent A cannot attach a new proof to a closed lead',
      await agentA.client.rpc('request_lead_proof_upload', {
        p_player_id: playerA, p_proof_id: randomId(), p_filename: 'x.png', p_mime_type: 'image/png', p_file_size: 10
      }), 'PROOF_LEAD_NOT_IN_WORK');
    const aOverwriteClosed = await agentA.client.storage.from(BUCKET).upload(good.path, PNG_BYTES, { contentType: 'image/png', upsert: true });
    check('agent A cannot overwrite the bytes of a confirmed proof', Boolean(aOverwriteClosed.error),
      'the confirmed object was OVERWRITTEN');
    const aDeleteClosed = await agentA.client.storage.from(BUCKET).remove([good.path]);
    const aDeleteBlocked = Boolean(aDeleteClosed.error) || !(aDeleteClosed.data || []).length;
    check('agent A cannot delete the bytes of a confirmed proof', aDeleteBlocked, 'the confirmed object was DELETED');

    console.log('\n[14] an inactive agent loses proof access with a live token');
    const deactivate = await admin.client.rpc('change_player_status_atomic', {
      p_player_id: playerB, p_next_status: 'no_answer', p_history_id: `${plan.prefix}bna`, p_confirm_reopen: false
    });
    if (deactivate.error) throw deactivate.error;
    // Deactivate through the same server-side RPC the Edge Function calls, not
    // by writing to profiles: service_role holds only SELECT on that table, and
    // going through the RPC is what production actually does. The token agent B
    // already holds is untouched and stays cryptographically valid.
    const off = await service.rpc('team_set_member_active', {
      p_actor_id: admin.user.id, p_target_id: agentB.user.id, p_is_active: false,
      p_reassign_to: agentA.user.id, p_request_id: randomId()
    });
    if (off.error) throw off.error;
    refused('a deactivated agent cannot request a proof with their existing token',
      await agentB.client.rpc('request_lead_proof_upload', {
        p_player_id: playerB, p_proof_id: randomId(), p_filename: 'x.png', p_mime_type: 'image/png', p_file_size: 10
      }), 'ACTIVE_PROFILE_REQUIRED');
    const deadRead = await agentB.client.from('lead_proofs').select('id');
    check('a deactivated agent reads no proof rows', !deadRead.error && deadRead.data.length === 0,
      `rows=${deadRead.data && deadRead.data.length}`);
    const reactivate = await service.rpc('team_set_member_active', {
      p_actor_id: admin.user.id, p_target_id: agentB.user.id, p_is_active: true,
      p_reassign_to: null, p_request_id: randomId()
    });
    if (reactivate.error) throw reactivate.error;
    const revived = await agentB.client.from('lead_proofs').select('id');
    check('a reactivated agent regains proof access with the same token', !revived.error, errorText(revived));

    console.log('\n[15] cleanup');
    // Remove the storage objects this run created, then the run's rows.
    const paths = [good.path].filter(Boolean);
    if (paths.length) await service.storage.from(BUCKET).remove(paths);
    const cleaned = await admin.client.rpc('cleanup_smoke_test_run_atomic', {
      p_run_id: plan.runId, p_confirmation: `DELETE_SMOKE_TEST_${plan.runId}`
    });
    check('smoke run cleaned up', !cleaned.error, errorText(cleaned));
    const leftover = await admin.client.from('lead_proofs').select('id').in('player_id', [playerA, playerB]);
    check('no proof rows survive cleanup', !leftover.error && leftover.data.length === 0,
      `rows=${leftover.data && leftover.data.length}`);
  } finally {
    await Promise.allSettled([admin, agentA, agentB].map(s => s.client.auth.signOut({ scope: 'local' })));
  }

  const total = failures.length;
  console.log(`\n${total ? 'FAILED' : 'PASSED'}: lead proof runtime security (${total} failure${total === 1 ? '' : 's'})`);
  if (total) { failures.forEach(f => console.log(`  - ${f}`)); process.exitCode = 1; }
}

if (require.main === module) main().catch(error => {
  console.error(`Lead proof smoke failed: ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
