-- Server-only team management primitives. Deploy only with the matching Edge Function.
begin;

create table if not exists public.admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  action text not null check (action in ('invite_member','update_member_role','set_member_active','reassign_players')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  target_user_id uuid references public.profiles(id) on delete restrict,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  constraint admin_audit_request_action_unique unique (request_id, action)
);

create index if not exists admin_audit_actor_created_idx on public.admin_audit_events(actor_id, created_at desc);
create index if not exists admin_audit_target_created_idx on public.admin_audit_events(target_user_id, created_at desc);

alter table public.admin_audit_events enable row level security;
drop policy if exists admin_audit_select_admin on public.admin_audit_events;
create policy admin_audit_select_admin on public.admin_audit_events for select to authenticated using (public.is_admin());
revoke all on public.admin_audit_events from public, anon, authenticated;
grant select on public.admin_audit_events to authenticated;
grant select on public.profiles to service_role;

create or replace function public.require_team_admin(p_actor_id uuid)
returns public.profiles
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into v_actor from public.profiles where id = p_actor_id and is_active and role = 'admin';
  if not found then raise exception using errcode = '42501', message = 'ACTIVE_ADMIN_REQUIRED'; end if;
  return v_actor;
end $$;

create or replace function public.team_list_members(p_actor_id uuid)
returns table(id uuid, username text, name text, role public.user_role, lang public.user_language, is_active boolean, created_at timestamptz, updated_at timestamptz, assigned_players bigint)
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.require_team_admin(p_actor_id);
  return query
    select pr.id, pr.username, pr.name, pr.role, pr.lang, pr.is_active, pr.created_at, pr.updated_at,
      count(pl.id)::bigint
    from public.profiles pr
    left join public.players pl on pl.agent_id = pr.id
    group by pr.id
    order by lower(pr.name), pr.id;
end $$;

create or replace function public.team_register_invitation(
  p_actor_id uuid, p_target_id uuid, p_username text, p_name text,
  p_role public.user_role, p_request_id uuid
)
returns public.profiles
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_target public.profiles; v_existing public.admin_audit_events;
begin
  v_actor := public.require_team_admin(p_actor_id);
  if p_target_id is null or p_request_id is null or char_length(trim(coalesce(p_username,''))) not between 2 and 50
     or char_length(trim(coalesce(p_name,''))) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_INVITATION';
  end if;
  select * into v_existing from public.admin_audit_events where request_id=p_request_id and action='invite_member';
  if found then
    if v_existing.target_user_id is distinct from p_target_id then raise exception using errcode='22023',message='REQUEST_ID_REUSE'; end if;
    select * into v_target from public.profiles where id=p_target_id; return v_target;
  end if;
  insert into public.profiles(id,username,name,role,lang,is_active)
    values(p_target_id,trim(p_username),trim(p_name),p_role,'ru',true)
    on conflict (id) do update set username=excluded.username, name=excluded.name
    returning * into v_target;
  if v_target.role is distinct from p_role then raise exception using errcode='23505',message='PROFILE_ALREADY_EXISTS'; end if;
  insert into public.admin_audit_events(request_id,action,actor_id,target_user_id,details)
    values(p_request_id,'invite_member',v_actor.id,v_target.id,jsonb_build_object('role',v_target.role,'username',v_target.username));
  return v_target;
end $$;

create or replace function public.team_update_member_role(p_actor_id uuid, p_target_id uuid, p_role public.user_role, p_request_id uuid)
returns public.profiles
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_target public.profiles; v_old public.user_role; v_existing public.admin_audit_events;
begin
  v_actor := public.require_team_admin(p_actor_id);
  if p_request_id is null then raise exception using errcode='22023',message='REQUEST_ID_REQUIRED'; end if;
  if p_target_id = v_actor.id and p_role = 'admin' then raise exception using errcode='42501',message='SELF_PROMOTION_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(746326824991);
  select * into v_existing from public.admin_audit_events where request_id=p_request_id and action='update_member_role';
  if found then
    if v_existing.target_user_id is distinct from p_target_id then raise exception using errcode='22023',message='REQUEST_ID_REUSE'; end if;
    select * into v_target from public.profiles where id=p_target_id; return v_target;
  end if;
  select * into v_target from public.profiles where id=p_target_id for update;
  if not found then raise exception using errcode='P0002',message='MEMBER_NOT_FOUND'; end if;
  v_old := v_target.role;
  if v_old = 'admin' and p_role <> 'admin' and v_target.is_active
     and (select count(*) from public.profiles where role='admin' and is_active) <= 1 then
    raise exception using errcode='42501',message='LAST_ACTIVE_ADMIN';
  end if;
  if p_role = 'agent' and exists(select 1 from public.players where agent_id=p_target_id) and not v_target.is_active then
    raise exception using errcode='22023',message='INACTIVE_AGENT_HAS_PLAYERS';
  end if;
  update public.profiles set role=p_role where id=p_target_id returning * into v_target;
  insert into public.admin_audit_events(request_id,action,actor_id,target_user_id,details)
    values(p_request_id,'update_member_role',v_actor.id,v_target.id,jsonb_build_object('from',v_old,'to',p_role));
  return v_target;
end $$;

create or replace function public.team_set_member_active(
  p_actor_id uuid, p_target_id uuid, p_is_active boolean, p_reassign_to uuid, p_request_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_target public.profiles; v_destination public.profiles; v_count integer:=0; v_existing public.admin_audit_events;
begin
  v_actor := public.require_team_admin(p_actor_id);
  if p_request_id is null or p_is_active is null then raise exception using errcode='22023',message='INVALID_ACTIVE_CHANGE'; end if;
  perform pg_advisory_xact_lock(746326824991);
  select * into v_existing from public.admin_audit_events where request_id=p_request_id and action='set_member_active';
  if found then
    if v_existing.target_user_id is distinct from p_target_id then raise exception using errcode='22023',message='REQUEST_ID_REUSE'; end if;
    return jsonb_build_object('member',(select to_jsonb(p) from public.profiles p where p.id=p_target_id),'reassigned',coalesce((v_existing.details->>'reassigned')::integer,0));
  end if;
  select * into v_target from public.profiles where id=p_target_id for update;
  if not found then raise exception using errcode='P0002',message='MEMBER_NOT_FOUND'; end if;
  if not p_is_active and v_target.role='admin'
     and (select count(*) from public.profiles where role='admin' and is_active) <= 1 then
    raise exception using errcode='42501',message='LAST_ACTIVE_ADMIN';
  end if;
  if not p_is_active and exists(select 1 from public.players where agent_id=p_target_id) then
    if p_reassign_to is null then raise exception using errcode='42501',message='REASSIGNMENT_REQUIRED'; end if;
    select * into v_destination from public.profiles where id=p_reassign_to and role='agent' and is_active for update;
    if not found or p_reassign_to=p_target_id then raise exception using errcode='22023',message='INVALID_REASSIGNMENT_AGENT'; end if;
    update public.players set agent_id=p_reassign_to where agent_id=p_target_id;
    get diagnostics v_count = row_count;
  end if;
  update public.profiles set is_active=p_is_active where id=p_target_id returning * into v_target;
  insert into public.admin_audit_events(request_id,action,actor_id,target_user_id,details)
    values(p_request_id,'set_member_active',v_actor.id,v_target.id,jsonb_build_object('from',not p_is_active,'to',p_is_active,'reassign_to',p_reassign_to,'reassigned',v_count));
  return jsonb_build_object('member',to_jsonb(v_target),'reassigned',v_count);
end $$;

create or replace function public.team_reassign_players(
  p_actor_id uuid, p_from_agent_id uuid, p_to_agent_id uuid, p_player_ids text[], p_request_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_destination public.profiles; v_count integer:=0; v_existing public.admin_audit_events;
begin
  v_actor := public.require_team_admin(p_actor_id);
  if p_request_id is null or p_from_agent_id is null or p_to_agent_id is null or p_from_agent_id=p_to_agent_id then
    raise exception using errcode='22023',message='INVALID_REASSIGNMENT';
  end if;
  select * into v_existing from public.admin_audit_events where request_id=p_request_id and action='reassign_players';
  if found then return jsonb_build_object('reassigned',coalesce((v_existing.details->>'reassigned')::integer,0)); end if;
  select * into v_destination from public.profiles where id=p_to_agent_id and role='agent' and is_active for update;
  if not found then raise exception using errcode='22023',message='INVALID_REASSIGNMENT_AGENT'; end if;
  if not exists(select 1 from public.profiles where id=p_from_agent_id) then raise exception using errcode='P0002',message='SOURCE_MEMBER_NOT_FOUND'; end if;
  if p_player_ids is null then
    update public.players set agent_id=p_to_agent_id where agent_id=p_from_agent_id;
  else
    if coalesce(array_length(p_player_ids,1),0)=0 or exists(select 1 from unnest(p_player_ids) as requested(player_id) where nullif(trim(requested.player_id),'') is null) then
      raise exception using errcode='22023',message='INVALID_PLAYER_IDS';
    end if;
    if exists(select 1 from unnest(p_player_ids) as requested(player_id) left join public.players p on p.id=requested.player_id where p.id is null or p.agent_id is distinct from p_from_agent_id) then
      raise exception using errcode='22023',message='PLAYER_ASSIGNMENT_MISMATCH';
    end if;
    update public.players set agent_id=p_to_agent_id where agent_id=p_from_agent_id and id=any(p_player_ids);
  end if;
  get diagnostics v_count = row_count;
  insert into public.admin_audit_events(request_id,action,actor_id,target_user_id,details)
    values(p_request_id,'reassign_players',v_actor.id,p_from_agent_id,jsonb_build_object('to_agent_id',p_to_agent_id,'reassigned',v_count));
  return jsonb_build_object('reassigned',v_count);
end $$;

revoke all on function public.require_team_admin(uuid), public.team_list_members(uuid),
  public.team_register_invitation(uuid,uuid,text,text,public.user_role,uuid),
  public.team_update_member_role(uuid,uuid,public.user_role,uuid),
  public.team_set_member_active(uuid,uuid,boolean,uuid,uuid),
  public.team_reassign_players(uuid,uuid,uuid,text[],uuid) from public, anon, authenticated;
grant execute on function public.require_team_admin(uuid), public.team_list_members(uuid),
  public.team_register_invitation(uuid,uuid,text,text,public.user_role,uuid),
  public.team_update_member_role(uuid,uuid,public.user_role,uuid),
  public.team_set_member_active(uuid,uuid,boolean,uuid,uuid),
  public.team_reassign_players(uuid,uuid,uuid,text[],uuid) to service_role;

commit;
