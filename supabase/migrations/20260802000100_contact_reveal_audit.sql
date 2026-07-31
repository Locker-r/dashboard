-- Audited Contact Reveal (PR B), file 1 of 2: append-only audit store, reason codes and rate-limit policy.
--
-- Purely additive. No object created by PR A is modified. This file ships the storage and the immutability
-- guarantees; the reveal, purge and configuration functions arrive in 20260802000200_contact_reveal_rpc.sql.
--
-- The audit is strictly append-only: one row is one event. Nothing is ever updated, and the original
-- decision plus every replay attempt are correlated by request_id rather than by mutating a counter.
begin;

-- Structured reason codes instead of free text, so denial analytics are aggregatable without parsing.
do $$ begin
  create type public.contact_reveal_reason as enum (
    'granted',
    'actor_not_agent',
    'player_not_found',
    'not_assigned',
    'status_not_in_work',
    'prior_denial',
    'request_id_conflict',
    'rate_limited'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.contact_reveal_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  -- Intentionally not a foreign key: the audit trail must survive deletion of the player it describes.
  player_id text not null,
  event_type text not null check (event_type in (
    'reveal_succeeded','reveal_denied','replay_succeeded','replay_denied','request_id_conflict','rate_limited'
  )),
  reason_code public.contact_reveal_reason not null,
  -- Which contact channels existed and were disclosed. Never the values themselves.
  channels text[] not null default '{}'::text[]
    check (channels <@ array['phone','email','messenger']::text[]),
  player_status public.player_status,
  player_agent_id uuid,
  created_at timestamptz not null default now()
);

-- Exactly one canonical decision per request_id. Replays, conflicts and throttled attempts are appended as
-- non-canonical events, so idempotency is enforced without ever updating a row. This index is also the
-- concurrency backstop when two different actors race the same request_id.
create unique index if not exists contact_reveal_canonical_request_idx
  on public.contact_reveal_events(request_id)
  where event_type in ('reveal_succeeded','reveal_denied');

-- Serves both the agent's own audit reads and the rate-limit window scan.
create index if not exists contact_reveal_actor_created_idx on public.contact_reveal_events(actor_id, created_at desc);
create index if not exists contact_reveal_request_created_idx on public.contact_reveal_events(request_id, created_at);
create index if not exists contact_reveal_created_idx on public.contact_reveal_events(created_at);

-- Immutability. UPDATE is refused unconditionally; DELETE is refused for every role except the table owner,
-- which is reached only from the SECURITY DEFINER retention function. Browser roles hold no write grant at
-- all, so this trigger is defence in depth rather than the primary control.
create or replace function public.contact_reveal_events_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_owner name;
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '42501', message = 'CONTACT_REVEAL_AUDIT_IMMUTABLE';
  end if;
  select tableowner into v_owner from pg_catalog.pg_tables
   where schemaname = 'public' and tablename = 'contact_reveal_events';
  if current_user is distinct from v_owner then
    raise exception using errcode = '42501', message = 'CONTACT_REVEAL_AUDIT_IMMUTABLE';
  end if;
  return old;
end $$;

revoke all on function public.contact_reveal_events_immutable() from public, anon, authenticated;

drop trigger if exists contact_reveal_events_no_update on public.contact_reveal_events;
create trigger contact_reveal_events_no_update
  before update on public.contact_reveal_events
  for each row execute function public.contact_reveal_events_immutable();

drop trigger if exists contact_reveal_events_no_delete on public.contact_reveal_events;
create trigger contact_reveal_events_no_delete
  before delete on public.contact_reveal_events
  for each row execute function public.contact_reveal_events_immutable();

alter table public.contact_reveal_events enable row level security;
drop policy if exists contact_reveal_events_select_own_or_admin on public.contact_reveal_events;
create policy contact_reveal_events_select_own_or_admin on public.contact_reveal_events
  for select to authenticated
  using (auth.uid() is not null and (actor_id = auth.uid() or public.is_admin()));

revoke all on public.contact_reveal_events from public, anon, authenticated;
grant select on public.contact_reveal_events to authenticated;

-- Rate-limit policy lives in data, not in the function body, so limits can be retuned without a migration.
create table if not exists public.contact_reveal_limits (
  id boolean primary key default true check (id),
  per_minute integer not null check (per_minute between 1 and 10000),
  per_hour integer not null check (per_hour between 1 and 100000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint contact_reveal_limits_window_order check (per_hour >= per_minute)
);

insert into public.contact_reveal_limits(id, per_minute, per_hour)
  values (true, 15, 150)
  on conflict (id) do nothing;

-- Read only by the definer functions; no browser role needs it.
revoke all on public.contact_reveal_limits from public, anon, authenticated;

commit;
