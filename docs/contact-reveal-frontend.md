# Contact reveal — frontend integration (PR C)

Third and final part of the Secure Contact Boundary workflow. PR A moved contacts behind a masked
projection, PR B added the audited reveal RPC, and PR C connects an agent's browser to it.

## The invariant

> A raw revealed contact may exist only in the transient `ContactRevealStore` and in the DOM node currently
> rendering that store entry.

It must never enter `players[]`, a player object, `savePlayers()`, `localStorage`, IndexedDB, CSV export,
the search index, analytics, logs, error messages or any persistent application state.

`players[]` is the array that is persisted, exported, searched and fed to analytics. A single assignment of a
revealed value onto a player object would leak it into all of them at once, which is why the store is a
separate structure rather than a field on the player.

Clearing the store drops the transient copy. It does not, and cannot, revoke what a human has already read
on screen. The audit trail — not the UI — is the control that makes that disclosure accountable.

## What PR A and PR B decided, and what follows for the browser

| Server-side fact | Frontend consequence |
| --- | --- |
| `players_secure` exposes only masked displays plus `contact_access_state` | The list can never contain a raw contact. Reveal is a second, separate call. |
| `contact_access_state = 'eligible'` iff `status = 'in_work'`, computed **per row, not per viewer** | An admin sees `eligible` on rows they can never reveal. The UI gates on the viewer's real capability. |
| `reveal_player_contacts` **returns** instead of raising for `denied`, `rate_limited` and `request_id_conflict` | A transport success is not a reveal. The client branches on `outcome`, never on `error === null`. |
| A `denied` request_id is permanently consumed (`prior_denial`) | A retry after a denial needs a **new** uuid; a retry after a lost response needs the **same** one. |
| `reason_code` is deliberately outside the response contract | The UI shows a generic denial and never infers a reason. |
| Replays count toward the 15/min, 150/hour limit | Double-clicks are collapsed locally and a throttle triggers a client-side backoff. |

## Module — `src/contact-reveal.js`

Pure and injectable: the clock, the randomness and the scheduler are parameters, so TTL expiry, uuid
generation and timer lifecycle are asserted directly instead of being timing-dependent.

| Export | Responsibility |
| --- | --- |
| `uuidV4(randomSource)` | RFC-4122 v4 from `getRandomValues`. `crypto.randomUUID` is **not** used: it requires a secure context and is absent when `index.html` is opened over `file://`. |
| `canRequestContactReveal(user, player, mode)` | Eligibility predicate (below). |
| `classifyRevealOutcome(row)` | `revealed` / `denied` / `rate_limited` / `request_id_conflict` / `malformed`. |
| `ContactRevealStore` | TTL-bounded transient store with lazy expiry and revalidation. |
| `RevealRequestLedger` | The request_id lifecycle. |
| `RevealCooldown` | 60-second client backoff after a server throttle. |
| `PruneTimer` | Single-instance 15-second interval. |

### Eligibility

The reveal control is offered only when **all** hold:

- `mode === 'supabase'`
- `currentUser.role === 'agent'` and the agent is active
- `player.agentId === currentUser.id`
- `player.status === 'in_work'`
- `player.contactAccessState === 'eligible'`

The server remains authoritative; this predicate is deliberately redundant with it. It exists so the UI never
offers a button whose only possible result is an audited denial — every denial is a permanent row against
that agent, and the abuse trail must record choices the agent actually made.

### Request-id lifecycle

| Event | Action | Why |
| --- | --- | --- |
| First click | Mint one uuid, mark in flight | One deliberate action, one request_id |
| Further clicks while in flight | Do nothing, issue no RPC | A second call would consume rate budget for one user action |
| Any structured outcome | **Discard** the id | A denied id is permanently spent; replaying a succeeded one only burns budget |
| Transport exception | **Retain** the id | The call may have committed; the same id replays the same canonical decision instead of appending a second one |
| `REVEAL_CONTRACT_VIOLATION` | Discard the id | The server answered, just off-contract; a canonical decision may already exist |

`request_id_conflict` and `rate_limited` are **never** retried automatically. An automatic retry after a
conflict would append a second audit event for a collision the user never caused.

### Transient store

TTL is **5 minutes**. Entry shape: `phone`, `email`, `messenger`, `revealedAt`, `accessEventId`, `expiresAt`.

- **Lazy expiry in `get()` is authoritative.** A background tab may have its timers throttled for minutes;
  reading through `get()` guarantees an expired value can never be rendered.
- `prune()` returns the ids it dropped, so the page re-renders only when something actually changed.
- `revalidate(players, user)` mirrors the server's authorization rule: an entry is dropped when the player
  disappeared, was reassigned, left `in_work`, or the actor stopped being an active agent.

### Timer

One `PruneTimer` for the page. `start()` is idempotent, so re-render, re-login and re-initialization cannot
accumulate intervals; the tick stops itself once nothing is left to watch, and restarts when a new reveal or
cooldown begins. The countdown text is patched into the existing DOM nodes rather than re-rendering the
table, because a 15-second rebuild would destroy expanded detail rows and any comment being typed.

## Data service

`revealPlayerContacts(playerId, requestId)` is added to the base contract. `SupabaseDataService` calls
`reveal_player_contacts` with exactly `p_player_id` and `p_request_id`, and maps exactly the eight approved
response columns. `reason_code`, `channels`, `player_status` and `player_agent_id` are never read, so a
future widening of the RPC cannot start flowing into the browser unnoticed. An empty or malformed result
throws `REVEAL_CONTRACT_VIOLATION`.

`LocalStorageDataService` does not implement it and inherits the contract's throw. The offline prototype has
no reveal feature.

## UI

The control lives in the worklist row's action area only — never in analytics, distribution, manual
assignment, import or admin screens.

| State | Contact cells | Control |
| --- | --- | --- |
| Not eligible | masked, 🔒, hint | none |
| Eligible | masked, no lock | **Show contacts** |
| In flight | masked | disabled, "Revealing…" |
| Revealed | raw values, per-channel copy | **Hide** + `revealed HH:MM · hides in M:SS` |
| Cooldown | masked | disabled with remaining seconds |
| Retry pending | masked | **Retry** (reuses the retained request_id) |

The copy button carries the player id and the channel name, never the value: a raw contact is written into
exactly one text node and is read back out of the store at click time.

**Lock presentation.** A value is shown as unlockable only when the current viewer can actually reveal it.
Previously the icon followed `contact_access_state` alone, so an admin saw the unlocked presentation on an
`in_work` row they can never unlock; admins now get the lock and a hint that says so.

## Clearing

| Trigger | Effect |
| --- | --- |
| Logout, authentication failure, session loss, teardown | `clearRevealedContacts()` — store, ledger, cooldown and timer |
| Every `loadData()` | `revalidate(players, currentUser)` |
| Confirmed status transition out of `in_work` | `forget(playerId)` immediately, before the reload |
| Explicit **Hide** | `forget(playerId)` |
| TTL lapse | lazy expiry on read, plus the prune tick |

## Search, export and analytics

All three stay masked and never consult the store. Revealed values are deliberately not searchable: making
them searchable would turn the store into a queryable side channel and would produce filter results with no
matching audit event.

`analyticsContactLabel` was reading `player.phone`, which has not existed on the player object since PR A, so
the analytics detail view had silently degraded to showing bare player ids. It now reads the masked
`contactText()` path.

## Running the runtime smoke

Requires a disposable **local** Supabase (the harness refuses a non-loopback URL) with the smoke users
provisioned, and the same environment `scripts/Invoke-LocalRuntimeSmokeTest.ps1` exports:

```bash
node scripts/contact-reveal-ui-smoke.cjs <run-id>
```

It drives `SupabaseDataService.revealPlayerContacts` + `ContactRevealStore` — the code path the browser runs —
and proves: an eligible reveal succeeds; raw values enter only the store; `JSON.stringify(players[])` contains
no raw contact; a denial leaves the store empty; an admin is refused with **no RPC sent**; a status change out
of `in_work` clears the store on revalidation; a lost response retried with the same request_id yields exactly
one canonical server decision plus a replay; and search, CSV and analytics stay masked while a reveal is live.

## Deliberately out of scope

No admin reveal path, no audit-viewer UI, no reveal from any surface other than the worklist, no change to
any PR A or PR B SQL object, and no change to the offline localStorage prototype.
