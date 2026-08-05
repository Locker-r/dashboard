(function exposeLeadProof(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationLeadProof = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLeadProof() {
  'use strict';

  // Client-side proof rules. These exist so a cashier gets an immediate, clear
  // answer instead of a failed upload -- they are not a security boundary. The
  // same limits are enforced by the bucket configuration, by CHECK constraints
  // on lead_proofs, and by confirm_lead_proof re-reading the object's real size
  // and MIME type out of storage. Anything relaxed here stays refused there.
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const ALLOWED_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  const EXTENSION_BY_MIME = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf'
  });
  // A browser may report an empty type for a picked file, so the extension is
  // used only to recover a missing type, never to override a declared one.
  const MIME_BY_EXTENSION = Object.freeze({
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', pdf: 'application/pdf'
  });
  const PROOF_STATES = Object.freeze({ PENDING: 'pending', ACTIVE: 'active', DISCARDED: 'discarded' });

  // Built from a string literal rather than a regex literal so no raw control
  // byte is ever written into this source file.
  const CONTROL_CHARACTERS = new RegExp('[\\x00-\\x1f\\x7f]', 'g');
  const PATH_SEPARATORS = /[\\/]/g;

  function extensionOf(name) {
    const value = String(name || '');
    const dot = value.lastIndexOf('.');
    if (dot < 0 || dot === value.length - 1) return '';
    return value.slice(dot + 1).toLowerCase();
  }

  function resolveMimeType(file) {
    const declared = String(file && file.type || '').trim().toLowerCase();
    if (declared) return declared;
    return MIME_BY_EXTENSION[extensionOf(file && file.name)] || '';
  }

  // Display-only normalisation. The storage path never contains this value --
  // request_lead_proof_upload builds the path from two server-side UUIDs -- so
  // this cannot influence where bytes land. It still strips separators and
  // control characters so a hostile name cannot be rendered as a path.
  function normalizeFilename(name) {
    const stripped = String(name == null ? '' : name)
      .replace(CONTROL_CHARACTERS, '')
      .replace(PATH_SEPARATORS, '')
      .replace(/^[.\s]+/, '')
      .trim();
    if (!stripped) return 'proof';
    return stripped.slice(0, 200);
  }

  function validateProofFile(file) {
    if (!file) return { ok: false, reason: 'proof_missing_file' };
    const size = Number(file.size);
    if (!Number.isFinite(size) || size < 1) return { ok: false, reason: 'proof_empty_file' };
    if (size > MAX_FILE_BYTES) return { ok: false, reason: 'proof_file_too_large' };
    const mimeType = resolveMimeType(file);
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) return { ok: false, reason: 'proof_invalid_type' };
    return {
      ok: true,
      mimeType,
      extension: EXTENSION_BY_MIME[mimeType],
      fileSize: size,
      filename: normalizeFilename(file.name)
    };
  }

  function formatFileSize(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function isActiveProof(proof) {
    return Boolean(proof && proof.state === PROOF_STATES.ACTIVE);
  }

  function activeProofFor(proofs, playerId) {
    if (!Array.isArray(proofs) || !playerId) return null;
    return proofs.find(proof => proof && proof.playerId === playerId && isActiveProof(proof)) || null;
  }

  // A closing transition is exactly the pair the database gates. Keeping this
  // predicate and change_player_status_atomic in one shape is deliberate: the
  // button state and the server rule must not drift apart.
  function isClosingStatus(status) {
    return status === 'success' || status === 'failed';
  }

  function canCloseWithProof(player, proofs) {
    if (!player || player.status !== 'in_work') return false;
    return Boolean(activeProofFor(proofs, player.id));
  }

  // Maps a server error onto a stable UI reason. Unknown errors collapse to a
  // generic reason so a database message never reaches the screen.
  function proofErrorReason(error) {
    const code = String(error && (error.message || error.code) || '').trim();
    const known = {
      PROOF_REQUIRED: 'proof_required',
      PROOF_ACCESS_DENIED: 'proof_access_denied',
      PROOF_NOT_READY: 'proof_not_ready',
      PROOF_NOT_FOUND: 'proof_not_found',
      PROOF_DISCARDED: 'proof_discarded',
      PROOF_LOCKED_AFTER_CLOSE: 'proof_locked_after_close',
      PROOF_LEAD_NOT_IN_WORK: 'proof_lead_not_in_work',
      PROOF_ID_CONFLICT: 'proof_id_conflict',
      INVALID_FILE_TYPE: 'proof_invalid_type',
      FILE_TOO_LARGE: 'proof_file_too_large',
      NOT_OWNER: 'proof_access_denied',
      ACTIVE_PROFILE_REQUIRED: 'proof_inactive_profile',
      AUTH_REQUIRED: 'proof_inactive_profile'
    };
    return known[code] || 'proof_upload_failed';
  }

  return Object.freeze({
    MAX_FILE_BYTES,
    ALLOWED_MIME_TYPES,
    EXTENSION_BY_MIME,
    PROOF_STATES,
    normalizeFilename,
    resolveMimeType,
    validateProofFile,
    formatFileSize,
    isActiveProof,
    activeProofFor,
    isClosingStatus,
    canCloseWithProof,
    proofErrorReason
  });
});
