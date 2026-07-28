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

  const STATUS_TRANSITION_REASONS = Object.freeze({
    ALLOWED: 'allowed',
    NO_CURRENT_USER: 'no_current_user',
    PLAYER_NOT_FOUND: 'player_not_found',
    UNKNOWN_ROLE: 'unknown_role',
    NOT_OWNER: 'not_owner',
    INVALID_TRANSITION: 'invalid_transition',
    ROLE_FORBIDDEN: 'role_forbidden',
    CONFIRMATION_REQUIRED: 'confirmation_required'
  });
  const COMMENT_MAX_LENGTH = 1000;
  const FOLLOW_UP_FILTERS = Object.freeze({
    ALL: 'all',
    TODAY: 'today',
    OVERDUE: 'overdue',
    SCHEDULED: 'scheduled',
    NONE: 'none'
  });

  function normalizeRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    return normalized === ROLES.ADMIN ? ROLES.ADMIN : ROLES.AGENT;
  }

  function isKnownRole(role) {
    return role === ROLES.ADMIN || role === ROLES.AGENT;
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

  function canUserChangePlayerStatus(user, player) {
    if (!user || !player || !isKnownRole(user.role)) return false;
    if (user.role === ROLES.ADMIN) return true;
    return Boolean(user.id && player.agentId && user.id === player.agentId);
  }

  function canUserManagePlayer(user, player) {
    return canUserChangePlayerStatus(user, player);
  }

  function normalizeStatusHistory(player) {
    return player && Array.isArray(player.statusHistory)
      ? player.statusHistory.slice().sort((a, b) => (Number(b && b.changedAt) || 0) - (Number(a && a.changedAt) || 0))
      : [];
  }

  function normalizeComments(player) {
    return player && Array.isArray(player.comments)
      ? player.comments.slice().sort((a, b) => (Number(b && b.createdAt) || 0) - (Number(a && a.createdAt) || 0))
      : [];
  }

  function createStatusHistoryEntry(details) {
    const data = details || {};
    const user = data.user || {};
    return {
      id: String(data.id || ''),
      fromStatus: data.fromStatus || '',
      toStatus: data.toStatus || '',
      changedAt: Number.isFinite(data.changedAt) ? data.changedAt : Date.now(),
      userId: user.id || '',
      userName: user.name || '',
      userRole: isKnownRole(user.role) ? user.role : ROLES.AGENT
    };
  }

  function createComment(details) {
    const data = details || {};
    const text = String(data.text || '').trim();
    if (!text) return { ok: false, reason: 'empty_comment' };
    if (text.length > COMMENT_MAX_LENGTH) return { ok: false, reason: 'comment_too_long' };
    const user = data.user || {};
    return {
      ok: true,
      comment: {
        id: String(data.id || ''),
        text,
        createdAt: Number.isFinite(data.createdAt) ? data.createdAt : Date.now(),
        authorId: user.id || '',
        authorName: user.name || '',
        authorRole: isKnownRole(user.role) ? user.role : ROLES.AGENT
      }
    };
  }

  function followUpTimestamp(value) {
    if (!value) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function normalizeFollowUpAt(value) {
    const timestamp = followUpTimestamp(value);
    return timestamp === null ? null : new Date(timestamp).toISOString();
  }

  function isFollowUpToday(value, now) {
    const timestamp = followUpTimestamp(value);
    if (timestamp === null) return false;
    const reference = new Date(Number.isFinite(now) ? now : Date.now());
    const followUp = new Date(timestamp);
    return followUp.getFullYear() === reference.getFullYear()
      && followUp.getMonth() === reference.getMonth()
      && followUp.getDate() === reference.getDate();
  }

  function isFollowUpOverdue(value, now) {
    const timestamp = followUpTimestamp(value);
    return timestamp !== null && timestamp < (Number.isFinite(now) ? now : Date.now());
  }

  function isFollowUpScheduled(value, now) {
    const timestamp = followUpTimestamp(value);
    return timestamp !== null && timestamp > (Number.isFinite(now) ? now : Date.now());
  }

  function matchesFollowUpFilter(value, filter, now) {
    if (!filter || filter === FOLLOW_UP_FILTERS.ALL) return true;
    if (filter === FOLLOW_UP_FILTERS.TODAY) return isFollowUpToday(value, now);
    if (filter === FOLLOW_UP_FILTERS.OVERDUE) return isFollowUpOverdue(value, now);
    if (filter === FOLLOW_UP_FILTERS.SCHEDULED) return isFollowUpScheduled(value, now);
    if (filter === FOLLOW_UP_FILTERS.NONE) return followUpTimestamp(value) === null;
    return false;
  }

  function evaluateStatusTransition(user, player, nextStatus, options) {
    if (!user) return { allowed: false, reason: STATUS_TRANSITION_REASONS.NO_CURRENT_USER };
    if (!player) return { allowed: false, reason: STATUS_TRANSITION_REASONS.PLAYER_NOT_FOUND };
    if (!isKnownRole(user.role)) return { allowed: false, reason: STATUS_TRANSITION_REASONS.UNKNOWN_ROLE };
    if (!canUserChangePlayerStatus(user, player)) {
      return { allowed: false, reason: STATUS_TRANSITION_REASONS.NOT_OWNER };
    }
    if (!isStatusTransitionAllowed(player.status, nextStatus)) {
      return { allowed: false, reason: STATUS_TRANSITION_REASONS.INVALID_TRANSITION };
    }
    if (!canRoleTransitionStatus(user.role, player.status, nextStatus)) {
      return { allowed: false, reason: STATUS_TRANSITION_REASONS.ROLE_FORBIDDEN };
    }
    const needsAdminConfirmation = user.role === ROLES.ADMIN
      && isFinalStatus(player.status)
      && nextStatus === STATUSES.IN_WORK;
    if (needsAdminConfirmation && !(options && options.adminConfirmed === true)) {
      return { allowed: false, reason: STATUS_TRANSITION_REASONS.CONFIRMATION_REQUIRED };
    }
    return { allowed: true, reason: STATUS_TRANSITION_REASONS.ALLOWED };
  }

  function prepareStatusTransition(user, player, nextStatus, options) {
    const decision = evaluateStatusTransition(user, player, nextStatus, options);
    if (!decision.allowed) return decision;
    return {
      allowed: true,
      reason: decision.reason,
      historyEntry: createStatusHistoryEntry({
        id: options && options.historyId,
        fromStatus: player.status,
        toStatus: nextStatus,
        changedAt: options && options.changedAt,
        user
      })
    };
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
    STATUS_TRANSITION_REASONS,
    COMMENT_MAX_LENGTH,
    FOLLOW_UP_FILTERS,
    normalizeRole,
    isKnownRole,
    normalizePhone,
    normalizeEmail,
    duplicateKeyFor,
    isFinalStatus,
    isStatusTransitionAllowed,
    canRoleTransitionStatus,
    canUserChangePlayerStatus,
    canUserManagePlayer,
    normalizeStatusHistory,
    normalizeComments,
    createStatusHistoryEntry,
    createComment,
    followUpTimestamp,
    normalizeFollowUpAt,
    isFollowUpToday,
    isFollowUpOverdue,
    isFollowUpScheduled,
    matchesFollowUpFilter,
    evaluateStatusTransition,
    prepareStatusTransition,
    canReassignPlayer,
    canPerformAdministrativeAction
  });
});
