(function exposeDomain(root, factory) {
  const domain = factory();
  if (typeof module === 'object' && module.exports) module.exports = domain;
  root.ReactivationDomain = domain;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDomain() {
  'use strict';

  const ROLES = Object.freeze({ ADMIN: 'admin', AGENT: 'agent' });
  const STATUSES = Object.freeze({
    NEW: 'new',
    ASSIGNED: 'assigned',
    IN_WORK: 'in_work',
    NO_ANSWER: 'no_answer',
    SUCCESS: 'success',
    FAILED: 'failed'
  });

  const STATUS_TRANSITIONS = Object.freeze({
    [STATUSES.NEW]: Object.freeze([STATUSES.ASSIGNED]),
    [STATUSES.ASSIGNED]: Object.freeze([STATUSES.IN_WORK]),
    [STATUSES.IN_WORK]: Object.freeze([STATUSES.SUCCESS, STATUSES.NO_ANSWER, STATUSES.FAILED]),
    [STATUSES.NO_ANSWER]: Object.freeze([STATUSES.ASSIGNED]),
    [STATUSES.SUCCESS]: Object.freeze([STATUSES.IN_WORK]),
    [STATUSES.FAILED]: Object.freeze([STATUSES.IN_WORK])
  });

  function normalizeRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    return normalized === ROLES.ADMIN ? ROLES.ADMIN : ROLES.AGENT;
  }

  function normalizePhone(phone) {
    let normalized = String(phone || '').trim().replace(/\D/g, '');
    if (normalized.startsWith('00')) normalized = normalized.slice(2);
    return normalized;
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function duplicateKeyFor(player) {
    const phone = normalizePhone(player && player.phone);
    if (phone) return `phone:${phone}`;
    const email = normalizeEmail(player && player.email);
    return email ? `email:${email}` : null;
  }

  function isFinalStatus(status) {
    return status === STATUSES.SUCCESS || status === STATUSES.FAILED;
  }

  function isStatusTransitionAllowed(currentStatus, nextStatus) {
    return Boolean(STATUS_TRANSITIONS[currentStatus] && STATUS_TRANSITIONS[currentStatus].includes(nextStatus));
  }

  function canRoleTransitionStatus(role, currentStatus, nextStatus) {
    if (!isStatusTransitionAllowed(currentStatus, nextStatus)) return false;
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === ROLES.ADMIN) return true;
    if (currentStatus === STATUSES.NEW || isFinalStatus(currentStatus)) return false;
    return true;
  }

  function canReassignPlayer(role, playerStatus, hasExplicitConfirmation) {
    if (normalizeRole(role) !== ROLES.ADMIN) return false;
    return !isFinalStatus(playerStatus) || hasExplicitConfirmation === true;
  }

  function canPerformAdministrativeAction(role, options) {
    if (normalizeRole(role) !== ROLES.ADMIN) return false;
    const rules = options || {};
    if (rules.affectsActiveAdmin) {
      return Number.isFinite(rules.activeAdminCount) && rules.activeAdminCount > 1;
    }
    return true;
  }

  return Object.freeze({
    ROLES,
    STATUSES,
    STATUS_TRANSITIONS,
    normalizeRole,
    normalizePhone,
    normalizeEmail,
    duplicateKeyFor,
    isFinalStatus,
    isStatusTransitionAllowed,
    canRoleTransitionStatus,
    canReassignPlayer,
    canPerformAdministrativeAction
  });
});
