'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const proof = require('../src/lead-proof.js');
const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260805000100_lead_proof.sql'), 'utf8');

function file(name, type, size) {
  return { name, type, size };
}

test('accepts every approved proof type and reports its extension', () => {
  const cases = [
    ['shot.jpg', 'image/jpeg', 'jpg'],
    ['shot.png', 'image/png', 'png'],
    ['shot.webp', 'image/webp', 'webp'],
    ['receipt.pdf', 'application/pdf', 'pdf']
  ];
  for (const [name, type, extension] of cases) {
    const result = proof.validateProofFile(file(name, type, 1024));
    assert.equal(result.ok, true, `${type} should be accepted`);
    assert.equal(result.mimeType, type);
    assert.equal(result.extension, extension);
    assert.equal(result.fileSize, 1024);
  }
});

test('refuses executable, archive and text types regardless of a harmless extension', () => {
  const refused = [
    file('payload.exe', 'application/x-msdownload', 10),
    file('payload.zip', 'application/zip', 10),
    file('notes.txt', 'text/plain', 10),
    file('page.html', 'text/html', 10),
    file('script.js', 'text/javascript', 10),
    file('sheet.svg', 'image/svg+xml', 10)
  ];
  for (const candidate of refused) {
    const result = proof.validateProofFile(candidate);
    assert.equal(result.ok, false, `${candidate.type} must be refused`);
    assert.equal(result.reason, 'proof_invalid_type');
  }
});

test('a disguised extension cannot promote a refused MIME type', () => {
  // The declared type wins whenever the browser supplies one, so naming an
  // executable "invoice.png" does not make it an image.
  const result = proof.validateProofFile(file('invoice.png', 'application/x-msdownload', 10));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'proof_invalid_type');
});

test('a missing browser type falls back to the extension, and only to an approved one', () => {
  assert.equal(proof.validateProofFile(file('scan.pdf', '', 10)).mimeType, 'application/pdf');
  assert.equal(proof.validateProofFile(file('scan.JPEG', '', 10)).mimeType, 'image/jpeg');
  assert.equal(proof.validateProofFile(file('scan.exe', '', 10)).reason, 'proof_invalid_type');
  assert.equal(proof.validateProofFile(file('noextension', '', 10)).reason, 'proof_invalid_type');
});

test('size limits reject empty and oversized files at exactly the documented boundary', () => {
  assert.equal(proof.MAX_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(proof.validateProofFile(file('a.png', 'image/png', 0)).reason, 'proof_empty_file');
  assert.equal(proof.validateProofFile(file('a.png', 'image/png', -1)).reason, 'proof_empty_file');
  assert.equal(proof.validateProofFile(file('a.png', 'image/png', proof.MAX_FILE_BYTES)).ok, true);
  assert.equal(proof.validateProofFile(file('a.png', 'image/png', proof.MAX_FILE_BYTES + 1)).reason, 'proof_file_too_large');
  assert.equal(proof.validateProofFile(null).reason, 'proof_missing_file');
});

test('filename normalization strips traversal, separators and control characters', () => {
  assert.equal(proof.normalizeFilename('../../etc/passwd'), 'etcpasswd');
  assert.equal(proof.normalizeFilename('..\\..\\windows\\system32'), 'windowssystem32');
  assert.equal(proof.normalizeFilename('a/b/c.png'), 'abc.png');
  assert.equal(proof.normalizeFilename('....'), 'proof');
  assert.equal(proof.normalizeFilename(''), 'proof');
  assert.equal(proof.normalizeFilename(null), 'proof');
  assert.equal(proof.normalizeFilename('   '), 'proof');
  const withControls = `re${String.fromCharCode(0)}ce${String.fromCharCode(31)}ipt${String.fromCharCode(127)}.png`;
  assert.equal(proof.normalizeFilename(withControls), 'receipt.png');
  assert.equal(proof.normalizeFilename('x'.repeat(500)).length, 200);
});

test('the source file itself contains no raw control byte', () => {
  // A literal NUL or DEL in a shipped classic script is a defect in its own
  // right; the normalizer builds its pattern from a string to avoid one.
  const source = fs.readFileSync(path.join(root, 'src', 'lead-proof.js'), 'utf8');
  const forbidden = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]');
  const offset = source.search(forbidden);
  assert.equal(offset, -1, `raw control byte at offset ${offset}`);
});

test('only an active proof for the same lead satisfies the close requirement', () => {
  const rows = [
    { id: '1', playerId: 'p1', state: 'pending' },
    { id: '2', playerId: 'p2', state: 'active' },
    { id: '3', playerId: 'p3', state: 'discarded' },
    { id: '4', playerId: 'p4', state: 'active' }
  ];
  assert.equal(proof.activeProofFor(rows, 'p1'), null, 'pending is not enough');
  assert.equal(proof.activeProofFor(rows, 'p3'), null, 'discarded is not enough');
  assert.equal(proof.activeProofFor(rows, 'p2').id, '2');
  assert.equal(proof.activeProofFor(rows, 'unknown'), null);
  assert.equal(proof.activeProofFor(null, 'p2'), null);

  const inWork = { id: 'p2', status: 'in_work' };
  assert.equal(proof.canCloseWithProof(inWork, rows), true);
  // Another lead's proof never satisfies this lead.
  assert.equal(proof.canCloseWithProof({ id: 'p1', status: 'in_work' }, rows), false);
  // A lead that is not in_work cannot be closed even with a proof present.
  assert.equal(proof.canCloseWithProof({ id: 'p2', status: 'assigned' }, rows), false);
  assert.equal(proof.canCloseWithProof(null, rows), false);
});

test('closing statuses are exactly the two the database gates', () => {
  assert.equal(proof.isClosingStatus('success'), true);
  assert.equal(proof.isClosingStatus('failed'), true);
  for (const status of ['new', 'assigned', 'in_work', 'no_answer', '']) {
    assert.equal(proof.isClosingStatus(status), false, `${status} must not require proof`);
  }
  // The same pair must be the one the SQL guards, or the button and the server
  // would disagree about what "closing" means.
  assert.match(migration, /if p_next_status in \('success','failed'\) then[\s\S]*?PROOF_REQUIRED/);
});

test('server error codes map to stable reasons and never leak a raw message', () => {
  assert.equal(proof.proofErrorReason({ message: 'PROOF_REQUIRED' }), 'proof_required');
  assert.equal(proof.proofErrorReason({ message: 'PROOF_ACCESS_DENIED' }), 'proof_access_denied');
  assert.equal(proof.proofErrorReason({ message: 'PROOF_NOT_READY' }), 'proof_not_ready');
  assert.equal(proof.proofErrorReason({ message: 'INVALID_FILE_TYPE' }), 'proof_invalid_type');
  assert.equal(proof.proofErrorReason({ message: 'FILE_TOO_LARGE' }), 'proof_file_too_large');
  assert.equal(proof.proofErrorReason({ code: 'PROOF_LOCKED_AFTER_CLOSE' }), 'proof_locked_after_close');
  // Anything unrecognised, including a database internal, collapses.
  assert.equal(proof.proofErrorReason({ message: 'duplicate key value violates unique constraint "x"' }), 'proof_upload_failed');
  assert.equal(proof.proofErrorReason(null), 'proof_upload_failed');
});

test('formatFileSize renders bytes, kilobytes and megabytes', () => {
  assert.equal(proof.formatFileSize(512), '512 B');
  assert.equal(proof.formatFileSize(2048), '2.0 KB');
  assert.equal(proof.formatFileSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(proof.formatFileSize('nonsense'), '');
});

test('the migration keeps the bucket private and the path server-generated', () => {
  assert.match(migration, /insert into storage\.buckets[\s\S]*?'lead-proofs'[\s\S]*?false/);
  assert.match(migration, /public = false/);
  assert.doesNotMatch(migration, /public\s*=\s*true/);
  // The path is two UUIDs and an approved extension: no client string reaches it.
  assert.match(migration, /storage_path text not null unique/);
  assert.match(migration, /v_actor\.id::text \|\| '\/' \|\| p_proof_id::text \|\| '\.' \|\| v_extension/);
  assert.match(migration, /check \(storage_path ~ '\^\[0-9a-f-\]\{36\}\/\[0-9a-f-\]\{36\}\\\.\(jpg\|png\|webp\|pdf\)\$'\)/);
});

test('the migration verifies the stored object instead of trusting the client', () => {
  assert.match(migration, /from storage\.objects o/);
  assert.match(migration, /v_size := nullif\(v_metadata->>'size', ''\)::bigint/);
  assert.match(migration, /v_mime := nullif\(v_metadata->>'mimetype', ''\)/);
  assert.match(migration, /v_mime <> v_proof\.mime_type/);
  // Activation is impossible without a verified size.
  assert.match(migration, /state <> 'active' or \(confirmed_at is not null and verified_file_size is not null\)/);
});

test('storage policies are per-object and never blanket-true for authenticated users', () => {
  const policies = migration.slice(migration.indexOf('lead_proofs_objects_insert_own_pending'));
  assert.doesNotMatch(policies, /with check \(\s*true\s*\)/);
  assert.doesNotMatch(policies, /using \(\s*true\s*\)/);
  for (const name of [
    'lead_proofs_objects_insert_own_pending',
    'lead_proofs_objects_select_admin_or_assigned',
    'lead_proofs_objects_update_own_pending',
    'lead_proofs_objects_delete_own_discarded'
  ]) {
    assert.match(migration, new RegExp(`create policy ${name} on storage\\.objects`));
  }
  // Every policy resolves the object name back to a proof row.
  const joins = migration.match(/lp\.storage_path = storage\.objects\.name/g) || [];
  assert.ok(joins.length >= 4, `expected each storage policy to bind to a proof row, found ${joins.length}`);
});

test('proof writes stay behind SECURITY DEFINER RPCs with a pinned search_path', () => {
  for (const fn of ['request_lead_proof_upload', 'confirm_lead_proof', 'discard_lead_proof', 'proof_authorize_player']) {
    const at = migration.indexOf(`function public.${fn}`);
    assert.ok(at > -1, `${fn} missing`);
    const body = migration.slice(at, at + 400);
    assert.match(body, /security definer/);
    assert.match(body, /set search_path = pg_catalog, public/);
  }
  // The table is readable but never directly writable from a browser.
  assert.match(migration, /revoke insert, update, delete, truncate, references, trigger on public\.lead_proofs from authenticated/);
  assert.match(migration, /grant select on public\.lead_proofs to authenticated/);
  assert.match(migration, /revoke all on public\.lead_proofs from public, anon/);
  // The internal authorisation helper is not callable from a session at all.
  assert.match(migration, /revoke all on function public\.proof_authorize_player\(text, boolean\) from public, anon, authenticated/);
});

test('uploaded_by is taken from the session, never from a parameter', () => {
  const at = migration.indexOf('function public.request_lead_proof_upload');
  const body = migration.slice(at, migration.indexOf('function public.confirm_lead_proof'));
  assert.match(body, /v_actor := public\.require_active_profile\(\);/);
  assert.match(body, /p_proof_id, v_player\.id, v_actor\.id,/);
  assert.doesNotMatch(body, /p_uploaded_by|p_agent_id|p_actor_id/);
});

test('only one proof can be active per lead', () => {
  assert.match(migration, /create unique index if not exists lead_proofs_one_active_per_player_idx\s*\n\s*on public\.lead_proofs\(player_id\) where state = 'active'/);
});
