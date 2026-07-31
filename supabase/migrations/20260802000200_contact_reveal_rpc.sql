-- Audited Contact Reveal (PR B), file 2 of 2: the reveal RPC, retention purge and limit configuration.
--
-- Purely additive. No object created by PR A is modified.
--
-- WHY THIS FUNCTION RETURNS INSTEAD OF RAISING
-- A PostgreSQL function runs in one transaction, so RAISE discards every write the function made, including
-- its own audit row. Raising on a denial would therefore produce an audit trail containing only successes --
-- the exact opposite of what an abuse trail is for. Every controlled business outcome (revealed, denied,
-- rate_limited, request_id_conflict) therefore RETURNS NORMALLY, so the append-only event commits in the same
-- transaction as the decision. Callers must inspect the `outcome` column; a successful transport response
-- does not mean a reveal occurred.
--
-- Two cases still raise, by design:
--   * INVALID_REQUEST_ID and the auth errors from require_active_profile -- no auditable request exists yet
--     (request_id is the audit key, actor_id is a NOT NULL foreign key).
--   * Catastrophic infrastructure failure. Same-transaction audit is guaranteed for controlled business
--     outcomes, NOT for a transaction that dies mid-flight. That limit is real and is stated, not implied away.
begin;

create or replace function public.reveal_player_contacts(p_player_id text, p_request_id uuid)
returns table(
  player_id text,
  outcome text,
  phone text,
  email text,
  messenger text,
  revealed_at timestamptz,
  request_id uuid,
  access_event_id uuid
)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles;
  v_locked_actor public.profiles;
  v_player public.players;
  v_limits public.contact_reveal_limits;
  v_canonical public.contact_reveal_events;
  v_used_minute integer := 0;
  v_used_hour integer := 0;
  v_is_replay boolean := false;
  v_event_id uuid;
  v_channels text[];
  v_now timestamptz := now();
  v_player_key text := coalesce(p_player_id, '');
begin
  -- Pre-audit guards. Nothing can be recorded before an actor and a request key exist.
  v_actor := public.require_active_profile();
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'INVALID_REQUEST_ID';
  end if;

  -- Serializes this actor: makes the rate-limit count exact under concurrency and collapses parallel tabs,
  -- double clicks and browser retries of the same request_id onto one canonical decision.
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id::text, 0));

  select l.* into v_limits from public.contact_reveal_limits l where l.id = true;
  if not found then
    raise exception using errcode = 'P0002', message = 'CONTACT_REVEAL_LIMITS_MISSING';
  end if;

  -- Bounded window scan: at most per_hour + 1 rows are examined no matter how large the audit history is,
  -- so the rate check itself can never become the bottleneck. Ordered so the newest events are the ones
  -- counted. Replays count toward the limit; only rate_limited events are excluded, so being throttled
  -- cannot extend an actor's own lockout.
  select coalesce(w.per_minute, 0), coalesce(w.per_hour, 0)
    into v_used_minute, v_used_hour
  from (
    select count(*) filter (where s.created_at >= v_now - interval '1 minute') as per_minute,
           count(*) as per_hour
    from (
      select e.created_at
        from public.contact_reveal_events e
       where e.actor_id = v_actor.id
         and e.created_at >= v_now - interval '1 hour'
         and e.event_type <> 'rate_limited'
       order by e.created_at desc
       limit v_limits.per_hour + 1
    ) s
  ) w;

  -- Enforced before any audit-writing path so no caller, including a non-agent, can grow the audit unbounded.
  if v_used_minute >= v_limits.per_minute or v_used_hour >= v_limits.per_hour then
    insert into public.contact_reveal_events
      (request_id, actor_id, player_id, event_type, reason_code)
      values (p_request_id, v_actor.id, v_player_key, 'rate_limited', 'rate_limited')
      returning id into v_event_id;
    player_id := p_player_id; outcome := 'rate_limited';
    phone := null; email := null; messenger := null; revealed_at := null;
    request_id := p_request_id; access_event_id := v_event_id;
    return next; return;
  end if;

  -- Everything below may insert a canonical event. The per-actor advisory lock serializes one actor against
  -- itself, but NOT two different actors sharing a request_id: the loser's canonical lookup can run before
  -- the winner commits, so its insert then trips contact_reveal_canonical_request_idx. Catching
  -- unique_violation here keeps the loser auditable and on-contract instead of surfacing a raw 23505 with no
  -- event. The subtransaction rollback discards only the failed insert; the conflict event appended in the
  -- handler commits with the outer transaction, so the same-transaction audit guarantee is preserved and the
  -- index remains the sole authority on canonical uniqueness.
  begin

  -- Agent only. Admins hold no reveal path in PR B.
  if v_actor.role <> 'agent' then
    insert into public.contact_reveal_events
      (request_id, actor_id, player_id, event_type, reason_code)
      values (p_request_id, v_actor.id, v_player_key, 'reveal_denied', 'actor_not_agent')
      returning id into v_event_id;
    player_id := p_player_id; outcome := 'denied';
    phone := null; email := null; messenger := null; revealed_at := null;
    request_id := p_request_id; access_event_id := v_event_id;
    return next; return;
  end if;

  -- Canonical decision for this request_id, if one already exists.
  select e.* into v_canonical
    from public.contact_reveal_events e
   where e.request_id = p_request_id
     and e.event_type in ('reveal_succeeded', 'reveal_denied')
   limit 1;

  if found then
    if v_canonical.actor_id is distinct from v_actor.id or v_canonical.player_id is distinct from v_player_key then
      insert into public.contact_reveal_events
        (request_id, actor_id, player_id, event_type, reason_code)
        values (p_request_id, v_actor.id, v_player_key, 'request_id_conflict', 'request_id_conflict')
        returning id into v_event_id;
      player_id := p_player_id; outcome := 'request_id_conflict';
      phone := null; email := null; messenger := null; revealed_at := null;
      request_id := p_request_id; access_event_id := v_event_id;
      return next; return;
    end if;
    v_is_replay := true;
    -- A denied request_id is permanently consumed; a later attempt needs a new one.
    if v_canonical.event_type = 'reveal_denied' then
      insert into public.contact_reveal_events
        (request_id, actor_id, player_id, event_type, reason_code)
        values (p_request_id, v_actor.id, v_player_key, 'replay_denied', 'prior_denial')
        returning id into v_event_id;
      player_id := p_player_id; outcome := 'denied';
      phone := null; email := null; messenger := null; revealed_at := null;
      request_id := p_request_id; access_event_id := v_event_id;
      return next; return;
    end if;
  end if;

  -- Authorization is revalidated on locked rows, never from the canonical decision. FOR SHARE blocks the
  -- FOR UPDATE taken by change_player_status_atomic, assign_players_atomic and team_set_member_active, so a
  -- concurrent status change, reassignment or deactivation cannot interleave with the disclosure. Lock order
  -- profiles then players matches team_set_member_active and team_reassign_players, so no new deadlock cycle
  -- is introduced. FOR KEY SHARE would be insufficient: it does not block a plain status UPDATE.
  select p.* into v_locked_actor from public.profiles p where p.id = v_actor.id for share;
  select pl.* into v_player from public.players pl where pl.id = v_player_key for share;

  if v_locked_actor.id is null or not v_locked_actor.is_active or v_locked_actor.role <> 'agent' then
    insert into public.contact_reveal_events
      (request_id, actor_id, player_id, event_type, reason_code, player_status, player_agent_id)
      values (p_request_id, v_actor.id, v_player_key,
              case when v_is_replay then 'replay_denied' else 'reveal_denied' end,
              'actor_not_agent', v_player.status, v_player.agent_id)
      returning id into v_event_id;
  elsif v_player.id is null then
    insert into public.contact_reveal_events
      (request_id, actor_id, player_id, event_type, reason_code)
      values (p_request_id, v_actor.id, v_player_key,
              case when v_is_replay then 'replay_denied' else 'reveal_denied' end,
              'player_not_found')
      returning id into v_event_id;
  elsif v_player.agent_id is distinct from v_actor.id then
    insert into public.contact_reveal_events
      (request_id, actor_id, player_id, event_type, reason_code, player_status, player_agent_id)
      values (p_request_id, v_actor.id, v_player_key,
              case when v_is_replay then 'replay_denied' else 'reveal_denied' end,
              'not_assigned', v_player.status, v_player.agent_id)
      returning id into v_event_id;
  elsif v_player.status <> 'in_work' then
    insert into public.contact_reveal_events
      (request_id, actor_id, player_id, event_type, reason_code, player_status, player_agent_id)
      values (p_request_id, v_actor.id, v_player_key,
              case when v_is_replay then 'replay_denied' else 'reveal_denied' end,
              'status_not_in_work', v_player.status, v_player.agent_id)
      returning id into v_event_id;
  else
    v_channels := array_remove(array[
      case when nullif(trim(v_player.phone), '') is not null then 'phone' end,
      case when nullif(trim(v_player.email), '') is not null then 'email' end,
      case when nullif(trim(v_player.messenger), '') is not null then 'messenger' end
    ], null);

    insert into public.contact_reveal_events
      (request_id, actor_id, player_id, event_type, reason_code, channels, player_status, player_agent_id)
      values (p_request_id, v_actor.id, v_player_key,
              case when v_is_replay then 'replay_succeeded' else 'reveal_succeeded' end,
              'granted', v_channels, v_player.status, v_player.agent_id)
      returning id into v_event_id;

    perform set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);

    player_id := p_player_id; outcome := 'revealed';
    phone := v_player.phone; email := v_player.email; messenger := v_player.messenger;
    revealed_at := v_now; request_id := p_request_id; access_event_id := v_event_id;
    return next; return;
  end if;

  player_id := p_player_id; outcome := 'denied';
  phone := null; email := null; messenger := null; revealed_at := null;
  request_id := p_request_id; access_event_id := v_event_id;
  return next; return;

  exception when unique_violation then
    -- Another actor won the canonical row for this request_id while we were deciding.
    insert into public.contact_reveal_events
      (request_id, actor_id, player_id, event_type, reason_code)
      values (p_request_id, v_actor.id, v_player_key, 'request_id_conflict', 'request_id_conflict')
      returning id into v_event_id;
    player_id := p_player_id; outcome := 'request_id_conflict';
    phone := null; email := null; messenger := null; revealed_at := null;
    request_id := p_request_id; access_event_id := v_event_id;
    return next; return;
  end;
end $$;

-- Retention. The audit delete trigger refuses every caller except the table owner, which is reached only
-- from inside this SECURITY DEFINER function, so ordinary admins cannot delete evidence directly.
create or replace function public.purge_contact_reveal_events(p_before timestamptz)
returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_deleted integer := 0;
begin
  if p_before is null or p_before > now() - interval '30 days' then
    raise exception using errcode = '22023', message = 'PURGE_CUTOFF_TOO_RECENT';
  end if;
  delete from public.contact_reveal_events e where e.created_at < p_before;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

-- Limits live in data so policy can be retuned without a migration.
create or replace function public.set_contact_reveal_limits(p_per_minute integer, p_per_hour integer)
returns public.contact_reveal_limits
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_row public.contact_reveal_limits;
begin
  v_actor := public.require_active_profile();
  if v_actor.role <> 'admin' then raise exception using errcode = '42501', message = 'ADMIN_REQUIRED'; end if;
  update public.contact_reveal_limits l
     set per_minute = p_per_minute, per_hour = p_per_hour, updated_at = now(), updated_by = v_actor.id
   where l.id = true
   returning l.* into v_row;
  if not found then raise exception using errcode = 'P0002', message = 'CONTACT_REVEAL_LIMITS_MISSING'; end if;
  return v_row;
end $$;

revoke all on function public.reveal_player_contacts(text, uuid) from public, anon;
grant execute on function public.reveal_player_contacts(text, uuid) to authenticated;

revoke all on function public.set_contact_reveal_limits(integer, integer) from public, anon;
grant execute on function public.set_contact_reveal_limits(integer, integer) to authenticated;

-- Retention is a maintenance operation, never a browser one.
revoke all on function public.purge_contact_reveal_events(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_contact_reveal_events(timestamptz) to service_role;

commit;
