(function exposeAnalytics(root, factory) {
  const domain = typeof module === 'object' && module.exports
    ? require('./domain.js')
    : root.ReactivationDomain;
  const analytics = factory(domain);
  if (typeof module === 'object' && module.exports) module.exports = analytics;
  root.ReactivationAnalytics = analytics;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAnalytics(domain) {
  'use strict';

  const PERIODS = Object.freeze({ TODAY: 'today', DAYS_7: '7d', DAYS_30: '30d', ALL: 'all' });

  function idKey(value) {
    return value === null || value === undefined || value === '' ? null : String(value);
  }

  function canAccessAnalytics(user) {
    return Boolean(user && user.role === domain.ROLES.ADMIN);
  }

  function periodBounds(period, now) {
    const end = Number.isFinite(now) ? now : Date.now();
    if (period === PERIODS.ALL) return { start: null, end };
    const startDate = new Date(end);
    startDate.setHours(0, 0, 0, 0);
    if (period === PERIODS.DAYS_7) startDate.setDate(startDate.getDate() - 6);
    else if (period === PERIODS.DAYS_30) startDate.setDate(startDate.getDate() - 29);
    return { start: startDate.getTime(), end };
  }

  function isEventInPeriod(value, period, now) {
    if (value === null || value === undefined || value === '') return false;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return false;
    const bounds = periodBounds(period, now);
    return timestamp <= bounds.end && (bounds.start === null || timestamp >= bounds.start);
  }

  function percentage(numerator, denominator) {
    return denominator > 0 ? numerator / denominator * 100 : 0;
  }

  function agentUsers(users) {
    return (Array.isArray(users) ? users : []).filter(user => user && user.role === domain.ROLES.AGENT);
  }

  function validAgentIds(users) {
    return new Set(agentUsers(users).map(user => idKey(user.id)).filter(Boolean));
  }

  function statusEvents(players, period, now, actorId) {
    const actorKey = idKey(actorId);
    const events = [];
    for (const player of Array.isArray(players) ? players : []) {
      for (const event of domain.normalizeStatusHistory(player)) {
        if (!event || !isEventInPeriod(event.changedAt, period, now)) continue;
        if (actorKey && idKey(event.userId) !== actorKey) continue;
        events.push({ ...event, playerId: player && player.id });
      }
    }
    return events.sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime());
  }

  function commentEvents(players, period, now, authorId) {
    const authorKey = idKey(authorId);
    const comments = [];
    for (const player of Array.isArray(players) ? players : []) {
      for (const comment of domain.normalizeComments(player)) {
        if (!comment || !idKey(comment.authorId) || !isEventInPeriod(comment.createdAt, period, now)) continue;
        if (authorKey && idKey(comment.authorId) !== authorKey) continue;
        comments.push({ ...comment, playerId: player && player.id });
      }
    }
    return comments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  function snapshotMetrics(players, users, now) {
    const list = Array.isArray(players) ? players : [];
    const knownAgents = validAgentIds(users);
    const counts = { total: list.length, assigned: 0, inWork: 0, success: 0, failed: 0, noAnswer: 0, unassigned: 0, overdue: 0, today: 0 };
    for (const player of list) {
      const agentId = idKey(player && player.agentId);
      if (agentId && knownAgents.has(agentId)) counts.assigned++;
      else counts.unassigned++;
      if (player && (player.status === domain.STATUSES.ASSIGNED || player.status === domain.STATUSES.IN_WORK)) counts.inWork++;
      if (player && player.status === domain.STATUSES.SUCCESS) counts.success++;
      if (player && player.status === domain.STATUSES.FAILED) counts.failed++;
      if (player && player.status === domain.STATUSES.NO_ANSWER) counts.noAnswer++;
      if (domain.isFollowUpOverdue(player && player.followUpAt, now)) counts.overdue++;
      if (domain.isFollowUpToday(player && player.followUpAt, now)) counts.today++;
    }
    counts.currentConversion = percentage(counts.success, counts.success + counts.failed);
    return counts;
  }

  function eventMetrics(events, comments) {
    const successful = events.filter(event => (event.toStatus || event.newStatus) === domain.STATUSES.SUCCESS).length;
    const failed = events.filter(event => (event.toStatus || event.newStatus) === domain.STATUSES.FAILED).length;
    return {
      success: successful,
      failed,
      terminal: successful + failed,
      conversion: percentage(successful, successful + failed),
      statusChanges: events.length,
      comments: comments.length
    };
  }

  function playersForAgent(players, agentId) {
    const key = idKey(agentId);
    return (Array.isArray(players) ? players : []).filter(player => key && idKey(player && player.agentId) === key);
  }

  function agentRow(agent, players, users, period, now) {
    const owned = playersForAgent(players, agent.id);
    const events = statusEvents(players, period, now, agent.id);
    const comments = commentEvents(players, period, now, agent.id);
    const snapshot = snapshotMetrics(owned, users, now);
    const byStatus = { assigned: 0, in_work: 0, success: 0, failed: 0, no_answer: 0 };
    for (const player of owned) if (byStatus[player.status] !== undefined) byStatus[player.status]++;
    return {
      id: agent.id,
      name: agent.name || '—',
      total: owned.length,
      ...byStatus,
      successfulReactivations: eventMetrics(events, comments).success,
      conversion: eventMetrics(events, comments).conversion,
      overdue: snapshot.overdue,
      today: snapshot.today,
      statusChanges: events.length,
      comments: comments.length
    };
  }

  function buildAnalytics(players, users, options) {
    const config = options || {};
    const now = Number.isFinite(config.now) ? config.now : Date.now();
    const period = Object.values(PERIODS).includes(config.period) ? config.period : PERIODS.DAYS_7;
    const selectedAgentId = idKey(config.agentId);
    const agents = agentUsers(users);
    const selectedAgent = selectedAgentId ? agents.find(agent => idKey(agent.id) === selectedAgentId) : null;
    const scopedPlayers = selectedAgentId ? (selectedAgent ? playersForAgent(players, selectedAgentId) : []) : (Array.isArray(players) ? players : []);
    const events = selectedAgentId && !selectedAgent ? [] : statusEvents(players, period, now, selectedAgentId);
    const comments = selectedAgentId && !selectedAgent ? [] : commentEvents(players, period, now, selectedAgentId);
    return {
      period,
      now,
      selectedAgent: selectedAgent || null,
      selectedAgentMissing: Boolean(selectedAgentId && !selectedAgent),
      snapshot: snapshotMetrics(scopedPlayers, users, now),
      events: eventMetrics(events, comments),
      agents: agents.map(agent => agentRow(agent, players, users, period, now)),
      detail: selectedAgent ? {
        players: scopedPlayers,
        statusEvents: events.slice(0, 10),
        comments: comments.slice(0, 10),
        followUps: scopedPlayers
          .filter(player => domain.followUpTimestamp(player && player.followUpAt) !== null)
          .sort((a, b) => domain.followUpTimestamp(a.followUpAt) - domain.followUpTimestamp(b.followUpAt))
          .slice(0, 10)
      } : null
    };
  }

  return Object.freeze({
    PERIODS,
    idKey,
    canAccessAnalytics,
    periodBounds,
    isEventInPeriod,
    percentage,
    statusEvents,
    commentEvents,
    snapshotMetrics,
    eventMetrics,
    playersForAgent,
    buildAnalytics
  });
});
