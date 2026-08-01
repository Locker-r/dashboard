(function exposeContactReveal(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationContactReveal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createContactReveal() {
  'use strict';

  // Frontend half of the Audited Contact Reveal workflow (PR C).
  //
  // THE INVARIANT THIS MODULE EXISTS TO HOLD
  // A raw revealed contact may live in exactly two places: a ContactRevealStore entry and the DOM node
  // currently rendering that entry. It must never be written onto a player object, because `players[]` is the
  // array that is persisted, exported to CSV, searched and fed to analytics -- one assignment would leak a
  // raw value into all four at once. Nothing in this file serializes, stores or logs a contact value.
  //
  // Everything here is pure and injectable: the clock and the randomness are parameters, never globals, so
  // TTL expiry and UUID generation are directly testable instead of being timing-dependent.

  const REVEAL_TTL_MS = 5 * 60 * 1000;      // Approved product decision: 5 minutes.
  const RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // Approved product decision: 60 seconds.
  const PRUNE_INTERVAL_MS = 15 * 1000;

  // The four controlled outcomes of reveal_player_contacts, plus the client-side classification of a
  // response that does not match the contract at all. `malformed` is never a server outcome; it means the
  // response could not be trusted, and it is treated as a failure, never as a silent success.
  const REVEAL_OUTCOMES = Object.freeze({
    REVEALED: 'revealed',
    DENIED: 'denied',
    RATE_LIMITED: 'rate_limited',
    CONFLICT: 'request_id_conflict',
    MALFORMED: 'malformed'
  });

  const CONTRACT_VIOLATION = 'REVEAL_CONTRACT_VIOLATION';

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value) {
    return value == null ? '' : String(value);
  }

  // RFC 4122 version 4 from getRandomValues. crypto.randomUUID is deliberately NOT used: it requires a
  // secure context and is absent when index.html is opened over file://, which is exactly how the page is
  // verified locally. getRandomValues is already the project's randomness source (randomHex in index.html).
  function uuidV4(randomSource) {
    if (!randomSource || typeof randomSource.getRandomValues !== 'function') {
      throw new Error('RANDOM_SOURCE_REQUIRED');
    }
    const bytes = new Uint8Array(16);
    randomSource.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = [];
    for (let index = 0; index < bytes.length; index += 1) hex.push(bytes[index].toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
  }

  // Deliberately redundant with the server, which stays authoritative. This predicate exists so the UI never
  // offers a button whose only possible result is an audited denial: every denial is a permanent row against
  // that agent, and the abuse trail must record choices the agent actually made.
  //
  // contact_access_state is computed per row (status = 'in_work'), NOT per viewer, so an admin sees
  // 'eligible' on a row they can never reveal. Role and assignment are therefore checked separately.
  function canRequestContactReveal(user, player, mode) {
    if (mode !== 'supabase') return false;
    if (!isPlainObject(user) || !isPlainObject(player)) return false;
    if (user.role !== 'agent') return false;
    if (user.isActive === false) return false;
    if (!user.id || player.agentId !== user.id) return false;
    if (player.status !== 'in_work') return false;
    return player.contactAccessState === 'eligible';
  }

  // A transport-level success says nothing about the business outcome: reveal_player_contacts returns
  // normally for denied, rate_limited and request_id_conflict so that its audit event commits in the same
  // transaction as the decision. Callers must branch on this, never on `error === null`.
  function classifyRevealOutcome(row) {
    if (!isPlainObject(row)) return REVEAL_OUTCOMES.MALFORMED;
    switch (row.outcome) {
      case REVEAL_OUTCOMES.REVEALED:
        // A revealed row with no channel at all is not a usable disclosure; treat it as off-contract rather
        // than rendering an empty "revealed" state that looks like a bug in the database.
        if (!text(row.phone) && !text(row.email) && !text(row.messenger)) return REVEAL_OUTCOMES.MALFORMED;
        return REVEAL_OUTCOMES.REVEALED;
      case REVEAL_OUTCOMES.DENIED: return REVEAL_OUTCOMES.DENIED;
      case REVEAL_OUTCOMES.RATE_LIMITED: return REVEAL_OUTCOMES.RATE_LIMITED;
      case REVEAL_OUTCOMES.CONFLICT: return REVEAL_OUTCOMES.CONFLICT;
      default: return REVEAL_OUTCOMES.MALFORMED;
    }
  }

  class ContactRevealStore {
    constructor(options) {
      const config = options || {};
      this.ttlMs = Number.isFinite(config.ttlMs) && config.ttlMs > 0 ? config.ttlMs : REVEAL_TTL_MS;
      this.now = typeof config.now === 'function' ? config.now : () => Date.now();
      this.entries = new Map();
    }

    put(playerId, reveal) {
      const id = text(playerId);
      if (!id || !isPlainObject(reveal)) return null;
      const revealedAt = Number.isFinite(reveal.revealedAt) ? reveal.revealedAt : this.now();
      const entry = {
        playerId: id,
        phone: text(reveal.phone),
        email: text(reveal.email),
        messenger: text(reveal.messenger),
        revealedAt,
        accessEventId: text(reveal.accessEventId),
        expiresAt: revealedAt + this.ttlMs
      };
      this.entries.set(id, entry);
      return entry;
    }

    // Lazy expiry is the authoritative control. A throttled or suspended background tab may not run the
    // prune timer for minutes; reading through get() guarantees an expired value can never be rendered.
    get(playerId) {
      const id = text(playerId);
      const entry = this.entries.get(id);
      if (!entry) return null;
      if (this.now() >= entry.expiresAt) {
        this.entries.delete(id);
        return null;
      }
      return entry;
    }

    has(playerId) {
      return this.get(playerId) !== null;
    }

    remainingMs(playerId) {
      const entry = this.get(playerId);
      return entry ? Math.max(0, entry.expiresAt - this.now()) : 0;
    }

    forget(playerId) {
      return this.entries.delete(text(playerId));
    }

    clearAll() {
      const count = this.entries.size;
      this.entries.clear();
      return count;
    }

    size() {
      return this.entries.size;
    }

    // Returns the ids dropped so the caller can re-render only when something actually changed.
    prune() {
      const now = this.now();
      const dropped = [];
      this.entries.forEach((entry, id) => { if (now >= entry.expiresAt) dropped.push(id); });
      dropped.forEach(id => this.entries.delete(id));
      return dropped;
    }

    // Run after every loadData(). Mirrors the server's authorization rule so a store entry can never outlive
    // the grounds on which it was disclosed: the player vanished, was reassigned, left in_work, or the actor
    // stopped being an active agent.
    revalidate(players, user) {
      const dropped = this.prune();
      const stillAgent = isPlainObject(user) && user.role === 'agent' && user.isActive !== false && Boolean(user.id);
      if (!stillAgent) {
        this.entries.forEach((_entry, id) => dropped.push(id));
        this.entries.clear();
        return dropped;
      }
      const byId = new Map();
      (Array.isArray(players) ? players : []).forEach(player => {
        if (isPlainObject(player) && player.id != null) byId.set(String(player.id), player);
      });
      const stale = [];
      this.entries.forEach((_entry, id) => {
        const player = byId.get(id);
        if (!player || player.agentId !== user.id || player.status !== 'in_work') stale.push(id);
      });
      stale.forEach(id => this.entries.delete(id));
      return dropped.concat(stale);
    }
  }

  // The request_id lifecycle. Two retry policies live here and must not be confused:
  //   * a structured outcome CONSUMES the id -- a denied request_id is permanently spent server-side
  //     (reason_code = prior_denial), and replaying a succeeded one only burns rate budget;
  //   * a transport exception RETAINS the id -- the call may have committed, so reusing the same id makes
  //     the retry idempotent and returns the same canonical decision instead of appending a second event.
  class RevealRequestLedger {
    constructor(options) {
      const config = options || {};
      this.randomSource = config.randomSource || null;
      this.newId = typeof config.newId === 'function'
        ? config.newId
        : () => uuidV4(this.randomSource);
      this.pending = new Map();
    }

    // Returns { requestId, started }. started === false means a request is already in flight for this
    // player and the caller must issue no RPC: local double-click collapse, so a second call cannot consume
    // rate budget for an action the user took once.
    begin(playerId) {
      const id = text(playerId);
      if (!id) return { requestId: null, started: false };
      const existing = this.pending.get(id);
      if (existing) {
        if (existing.inFlight) return { requestId: existing.requestId, started: false };
        existing.inFlight = true;
        return { requestId: existing.requestId, started: true, retried: true };
      }
      const requestId = this.newId();
      this.pending.set(id, { requestId, inFlight: true });
      return { requestId, started: true, retried: false };
    }

    // A structured outcome arrived: the id is spent.
    resolve(playerId) {
      return this.pending.delete(text(playerId));
    }

    // Transport failure: keep the id, release the in-flight flag so an explicit retry can reuse it.
    fail(playerId) {
      const entry = this.pending.get(text(playerId));
      if (!entry) return null;
      entry.inFlight = false;
      return entry.requestId;
    }

    isInFlight(playerId) {
      const entry = this.pending.get(text(playerId));
      return Boolean(entry && entry.inFlight);
    }

    retryableId(playerId) {
      const entry = this.pending.get(text(playerId));
      return entry && !entry.inFlight ? entry.requestId : null;
    }

    clearAll() {
      const count = this.pending.size;
      this.pending.clear();
      return count;
    }

    size() {
      return this.pending.size;
    }
  }

  // Client-side courtesy backoff after the server throttles. It does not replace the server limit; it stops
  // the UI from re-firing into a limit that is already exhausted.
  class RevealCooldown {
    constructor(options) {
      const config = options || {};
      this.durationMs = Number.isFinite(config.durationMs) && config.durationMs > 0
        ? config.durationMs : RATE_LIMIT_COOLDOWN_MS;
      this.now = typeof config.now === 'function' ? config.now : () => Date.now();
      this.until = 0;
    }

    start() {
      this.until = this.now() + this.durationMs;
      return this.until;
    }

    isActive() {
      return this.now() < this.until;
    }

    remainingMs() {
      return Math.max(0, this.until - this.now());
    }

    clear() {
      this.until = 0;
    }
  }

  // Single-instance timer. start() is idempotent: calling it again while running does not create a second
  // interval, so re-render, re-login and re-initialization cannot accumulate timers.
  class PruneTimer {
    constructor(options) {
      const config = options || {};
      this.intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs > 0
        ? config.intervalMs : PRUNE_INTERVAL_MS;
      this.setInterval = typeof config.setInterval === 'function' ? config.setInterval : null;
      this.clearInterval = typeof config.clearInterval === 'function' ? config.clearInterval : null;
      this.onTick = typeof config.onTick === 'function' ? config.onTick : () => {};
      this.handle = null;
    }

    isRunning() {
      return this.handle !== null;
    }

    start() {
      if (this.handle !== null || !this.setInterval) return false;
      this.handle = this.setInterval(() => this.onTick(), this.intervalMs);
      return true;
    }

    stop() {
      if (this.handle === null) return false;
      if (this.clearInterval) this.clearInterval(this.handle);
      this.handle = null;
      return true;
    }
  }

  return {
    REVEAL_TTL_MS,
    RATE_LIMIT_COOLDOWN_MS,
    PRUNE_INTERVAL_MS,
    REVEAL_OUTCOMES,
    CONTRACT_VIOLATION,
    uuidV4,
    canRequestContactReveal,
    classifyRevealOutcome,
    ContactRevealStore,
    RevealRequestLedger,
    RevealCooldown,
    PruneTimer
  };
});
