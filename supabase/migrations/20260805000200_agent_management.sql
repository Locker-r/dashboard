-- Supabase-native cashier management.
--
-- Adds the country a cashier works, and the two server-only primitives the
-- team-management Edge Function needs to create a member with a usable
-- credential and to move a member between countries. Existing team RPCs are
-- untouched; `team_register_invitation` keeps its exact signature and behaviour
-- so the deployed function and its runtime suite continue to pass.
--
-- Country format: ISO 3166-1 alpha-2, uppercase. The repository has no country
-- dictionary to defer to, so the column validates the shape rather than a
-- business allowlist. A narrower CHECK or a lookup table can be layered on later
-- without touching any caller.
begin;

alter table public.profiles
  add column if not exists country text;

do $$ begin
  alter table public.profiles
    add constraint profiles_country_format check (country is null or country ~ '^[A-Z]{2}$');
exception when duplicate_object then null; end $$;

create index if not exists profiles_country_idx on public.profiles(country) where country is not null;

comment on column public.profiles.country is
  'ISO 3166-1 alpha-2 country the member operates in. Null means unassigned; set only by an admin through team_register_member or team_update_member_country.';

-- Creates the profile for an Auth user the Edge Function has just provisioned.
-- Distinct from team_register_invitation: role is forced to agent, a country is
-- recorded, and the audit request payload carries the country so a replayed
-- request with a different country is refused rather than silently accepted.
create or replace function public.team_register_member(
  p_actor_id uuid, p_target_id uuid, p_username text, p_name text,
  p_country text, p_request_id uuid
)
returns public.profiles
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles; v_target public.profiles; v_existing public.admin_audit_events;
  v_request jsonb; v_username text; v_name text; v_country text;
begin
  v_actor := public.require_team_admin(p_actor_id);
  if p_target_id is null or p_request_id is null
     or char_length(trim(coalesce(p_username,''))) not between 2 and 50
     or char_length(trim(coalesce(p_name,''))) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_INVITATION';
  end if;
  v_username := trim(p_username);
  v_name := trim(p_name);
  v_country := upper(trim(coalesce(p_country, '')));
  if v_country !~ '^[A-Z]{2}$' then
    raise exception using errcode = '22023', message = 'INVALID_COUNTRY';
  end if;

  -- Role is server-assigned. The Edge Function cannot request an admin here and
  -- neither can anything upstream of it.
  v_request := jsonb_build_object(
    'target_id', p_target_id, 'username', v_username, 'name', v_name,
    'role', 'agent', 'country', v_country
  );
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into v_existing from public.admin_audit_events
   where request_id = p_request_id and action = 'invite_member';
  if found then
    if v_existing.details->'request' is distinct from v_request then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSE';
    end if;
    return jsonb_populate_record(null::public.profiles, v_existing.details->'result');
  end if;

  if exists (select 1 from public.profiles where id = p_target_id) then
    raise exception using errcode = '23505', message = 'PROFILE_ALREADY_EXISTS';
  end if;
  if exists (select 1 from public.profiles where lower(username) = lower(v_username)) then
    raise exception using errcode = '23505', message = 'USERNAME_ALREADY_EXISTS';
  end if;

  insert into public.profiles(id, username, name, role, lang, is_active, country)
    values (p_target_id, v_username, v_name, 'agent', 'es', true, v_country)
  returning * into v_target;

  insert into public.admin_audit_events(request_id, action, actor_id, target_user_id, details)
    values (p_request_id, 'invite_member', v_actor.id, v_target.id,
            jsonb_build_object('request', v_request, 'result', to_jsonb(v_target)));
  return v_target;
end $$;

-- Changing a country never touches existing assignments: it applies to future
-- distribution only. The response reports how many leads the member still holds
-- so the caller can warn without this function performing a mass reassignment.
create or replace function public.team_update_member_country(
  p_actor_id uuid, p_target_id uuid, p_country text, p_request_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles; v_target public.profiles; v_existing public.admin_audit_events;
  v_request jsonb; v_result jsonb; v_country text; v_previous text; v_assigned integer := 0;
begin
  v_actor := public.require_team_admin(p_actor_id);
  if p_request_id is null or p_target_id is null then
    raise exception using errcode = '22023', message = 'INVALID_COUNTRY_CHANGE';
  end if;
  v_country := upper(trim(coalesce(p_country, '')));
  if v_country !~ '^[A-Z]{2}$' then
    raise exception using errcode = '22023', message = 'INVALID_COUNTRY';
  end if;

  v_request := jsonb_build_object('target_id', p_target_id, 'country', v_country);
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into v_existing from public.admin_audit_events
   where request_id = p_request_id and action = 'update_member_country';
  if found then
    if v_existing.details->'request' is distinct from v_request then
      raise exception using errcode = '22023', message = 'REQUEST_ID_REUSE';
    end if;
    return v_existing.details->'result';
  end if;

  select * into v_target from public.profiles where id = p_target_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'MEMBER_NOT_FOUND'; end if;
  v_previous := v_target.country;

  select count(*) into v_assigned from public.players where agent_id = p_target_id;

  update public.profiles set country = v_country where id = p_target_id returning * into v_target;

  v_result := jsonb_build_object(
    'member', to_jsonb(v_target),
    'previous_country', v_previous,
    'assigned_players', v_assigned
  );
  insert into public.admin_audit_events(request_id, action, actor_id, target_user_id, details)
    values (p_request_id, 'update_member_country', v_actor.id, v_target.id,
            jsonb_build_object('request', v_request, 'result', v_result));
  return v_result;
end $$;

-- team_list_members gains country. PostgreSQL cannot replace a function whose
-- OUT columns changed, so it is dropped and recreated with its grants restored.
drop function if exists public.team_list_members(uuid);
create function public.team_list_members(p_actor_id uuid)
returns table(id uuid, username text, name text, role public.user_role, lang public.user_language,
              is_active boolean, country text, created_at timestamptz, updated_at timestamptz,
              assigned_players bigint)
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.require_team_admin(p_actor_id);
  return query
    select pr.id, pr.username, pr.name, pr.role, pr.lang, pr.is_active, pr.country,
      pr.created_at, pr.updated_at, count(pl.id)::bigint
    from public.profiles pr
    left join public.players pl on pl.agent_id = pr.id
    group by pr.id
    order by lower(pr.name), pr.id;
end $$;

-- The audit action allowlist has to learn the new action.
alter table public.admin_audit_events drop constraint if exists admin_audit_events_action_check;
alter table public.admin_audit_events add constraint admin_audit_events_action_check
  check (action in ('invite_member','update_member_role','set_member_active','reassign_players','update_member_country'));

revoke all on function
  public.team_list_members(uuid),
  public.team_register_member(uuid, uuid, text, text, text, uuid),
  public.team_update_member_country(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function
  public.team_list_members(uuid),
  public.team_register_member(uuid, uuid, text, text, text, uuid),
  public.team_update_member_country(uuid, uuid, text, uuid)
  to service_role;

commit;
