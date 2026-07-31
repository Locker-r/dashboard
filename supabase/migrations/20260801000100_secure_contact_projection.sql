-- Secure Contact Boundary (PR A), phase 1: additive masked projection, helpers and safe RPC shapes.
-- Phase 1 changes no existing privilege. The cut-over that removes raw contact access is phase 2
-- (20260801000200_revoke_raw_contacts.sql) so an already-deployed frontend keeps working until it is switched.
begin;

-- Canonical normalization. Declared immutable and written in SQL so the planner inlines them and the
-- existing expression indexes on players(phone/email/messenger) remain usable.
create or replace function public.normalize_contact_phone(p_value text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$ select nullif(regexp_replace(coalesce(p_value,''), '[^0-9+]', '', 'g'), '') $$;

create or replace function public.normalize_contact_email(p_value text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$ select nullif(lower(trim(coalesce(p_value,''))), '') $$;

create or replace function public.normalize_contact_messenger(p_value text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$ select nullif(lower(trim(coalesce(p_value,''))), '') $$;

-- Masking. Applied inside the database; the raw value never leaves Postgres through these paths.
-- left()/right() are character based, so multi-byte local parts and handles stay intact.
create or replace function public.mask_contact_phone(p_value text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when nullif(trim(coalesce(p_value,'')), '') is null then null
    when char_length(regexp_replace(p_value, '[^0-9]', '', 'g')) < 6 then '***'
    else repeat('*', char_length(regexp_replace(p_value, '[^0-9]', '', 'g')) - 4)
         || right(regexp_replace(p_value, '[^0-9]', '', 'g'), 4)
  end
$$;

create or replace function public.mask_contact_email(p_value text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when nullif(trim(coalesce(p_value,'')), '') is null then null
    when position('@' in trim(p_value)) > 1
     and char_length(split_part(trim(p_value), '@', 2)) > 0
      then left(split_part(trim(p_value), '@', 1), 1) || '***@' || split_part(trim(p_value), '@', 2)
    else '***'
  end
$$;

create or replace function public.mask_contact_messenger(p_value text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when nullif(trim(coalesce(p_value,'')), '') is null then null
    when left(trim(p_value), 1) = '@' then
      case when char_length(trim(p_value)) > 1
        then '@' || left(substr(trim(p_value), 2), 1) || '***'
        else '***' end
    else left(trim(p_value), 1) || '***'
  end
$$;

-- Row authorization for the projection. The view below runs with definer semantics (see the note on
-- players_secure), so RLS on public.players is bypassed for it and this predicate is the only row control.
-- It mirrors policy players_select_admin_or_assigned and additionally requires the actor to be active.
create or replace function public.can_read_player(p_agent_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.profiles actor
    where actor.id = auth.uid()
      and actor.is_active
      and (actor.role = 'admin' or actor.id = p_agent_id)
  )
$$;

revoke all on function public.normalize_contact_phone(text), public.normalize_contact_email(text),
  public.normalize_contact_messenger(text), public.mask_contact_phone(text), public.mask_contact_email(text),
  public.mask_contact_messenger(text), public.can_read_player(uuid) from public, anon;
grant execute on function public.normalize_contact_phone(text), public.normalize_contact_email(text),
  public.normalize_contact_messenger(text), public.mask_contact_phone(text), public.mask_contact_email(text),
  public.mask_contact_messenger(text), public.can_read_player(uuid) to authenticated;

-- The sanctioned player list projection. Explicit column list; raw phone/email/messenger are never selected
-- out. Contacts are masked unconditionally for every caller, including admins: contact_access_state reports
-- reveal eligibility only and never changes the masking level. Reveal itself is out of scope for PR A.
-- security_invoker is deliberately NOT set: phase 2 revokes the raw contact columns from authenticated, so an
-- invoker-rights view could not read them. Definer semantics bypass RLS, hence the explicit where clause.
create or replace view public.players_secure
with (security_barrier = true) as
select
  p.id,
  p.status,
  p.agent_id,
  p.created_by,
  p.imported_at,
  p.updated_at,
  p.follow_up_at,
  public.mask_contact_phone(p.phone)          as phone_display,
  public.mask_contact_email(p.email)          as email_display,
  public.mask_contact_messenger(p.messenger)  as messenger_display,
  public.normalize_contact_phone(p.phone)     is not null as has_phone,
  public.normalize_contact_email(p.email)     is not null as has_email,
  public.normalize_contact_messenger(p.messenger) is not null as has_messenger,
  case when p.status = 'in_work' then 'eligible' else 'locked' end as contact_access_state
from public.players p
where public.can_read_player(p.agent_id);

revoke all on public.players_secure from public, anon;
grant select on public.players_secure to authenticated;

-- Server-side duplicate detection for the admin import preflight. Replaces the browser workflow that read raw
-- contact columns. Returns only match metadata, never a stored contact value and never a players rowtype.
create or replace function public.check_player_duplicates(p_candidates jsonb)
returns table(row_index integer, duplicate boolean, matched_player_id text, matched_fields text[])
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles; v_item jsonb; v_index integer;
  v_id text; v_phone text; v_email text; v_messenger text;
  v_match_id text; v_fields text[];
begin
  v_actor := public.require_active_profile();
  if v_actor.role <> 'admin' then raise exception using errcode = '42501', message = 'ADMIN_REQUIRED'; end if;
  if jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) > 5000 then
    raise exception using errcode = '22023', message = 'INVALID_CANDIDATE_BATCH';
  end if;

  for v_item, v_index in
    select value, (ordinality - 1)::integer from jsonb_array_elements(p_candidates) with ordinality
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = '22023', message = 'INVALID_CANDIDATE';
    end if;
    v_id        := nullif(trim(coalesce(v_item->>'id','')), '');
    v_phone     := public.normalize_contact_phone(v_item->>'phone');
    v_email     := public.normalize_contact_email(v_item->>'email');
    v_messenger := public.normalize_contact_messenger(v_item->>'messenger');
    v_match_id  := null;
    v_fields    := array[]::text[];

    -- Resolve one match by a fixed priority so matched_fields always describes the reported player.
    select p.id into v_match_id from public.players p
    where (v_id is not null and p.id = v_id)
    order by p.id limit 1;
    if v_match_id is null and v_phone is not null then
      select p.id into v_match_id from public.players p
      where public.normalize_contact_phone(p.phone) = v_phone order by p.id limit 1;
    end if;
    if v_match_id is null and v_email is not null then
      select p.id into v_match_id from public.players p
      where public.normalize_contact_email(p.email) = v_email order by p.id limit 1;
    end if;
    if v_match_id is null and v_messenger is not null then
      select p.id into v_match_id from public.players p
      where public.normalize_contact_messenger(p.messenger) = v_messenger order by p.id limit 1;
    end if;

    if v_match_id is not null then
      select
        case when v_id is not null and p.id = v_id then array['id'] else array[]::text[] end
        || case when v_phone is not null and public.normalize_contact_phone(p.phone) = v_phone then array['phone'] else array[]::text[] end
        || case when v_email is not null and public.normalize_contact_email(p.email) = v_email then array['email'] else array[]::text[] end
        || case when v_messenger is not null and public.normalize_contact_messenger(p.messenger) = v_messenger then array['messenger'] else array[]::text[] end
      into v_fields
      from public.players p where p.id = v_match_id;
    end if;

    row_index := v_index;
    duplicate := v_match_id is not null;
    matched_player_id := v_match_id;
    matched_fields := coalesce(v_fields, array[]::text[]);
    return next;
  end loop;
end $$;

revoke all on function public.check_player_duplicates(jsonb) from public, anon;
grant execute on function public.check_player_duplicates(jsonb) to authenticated;

-- Mutation RPCs are re-created returning the masked projection rowtype instead of public.players. Their
-- authorization, validation, locking, status rules and error codes are unchanged; only the result shape is
-- narrowed so no ordinary RPC response can carry a stored contact value. A return type cannot be altered with
-- create or replace, so each function is dropped and re-created with an identical signature.
drop function if exists public.create_players_atomic(jsonb);
drop function if exists public.assign_players_atomic(text[],uuid[],boolean);
drop function if exists public.change_player_status_atomic(text,public.player_status,text,boolean);
drop function if exists public.set_player_follow_up_atomic(text,timestamptz);

create function public.create_players_atomic(p_players jsonb)
returns setof public.players_secure
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_item jsonb; v_id text; v_phone text; v_email text; v_messenger text; v_imported timestamptz;
begin
  v_actor := public.require_active_profile();
  if v_actor.role <> 'admin' then raise exception using errcode = '42501', message = 'ADMIN_REQUIRED'; end if;
  if jsonb_typeof(p_players) <> 'array' or jsonb_array_length(p_players) < 1 or jsonb_array_length(p_players) > 5000 then
    raise exception using errcode = '22023', message = 'INVALID_PLAYER_BATCH';
  end if;
  for v_item in select value from jsonb_array_elements(p_players) loop
    v_id := trim(coalesce(v_item->>'id','')); v_phone := trim(coalesce(v_item->>'phone',''));
    v_email := lower(trim(coalesce(v_item->>'email',''))); v_messenger := trim(coalesce(v_item->>'messenger',''));
    if v_id = '' or (v_phone = '' and v_email = '' and v_messenger = '') then raise exception using errcode='22023', message='INVALID_PLAYER'; end if;
    if exists(select 1 from public.players where id=v_id) then raise exception using errcode='23505', message='PLAYER_ID_CONFLICT'; end if;
    if (v_phone <> '' and exists(select 1 from public.players where regexp_replace(phone,'[^0-9+]','','g')=regexp_replace(v_phone,'[^0-9+]','','g')))
       or (v_email <> '' and exists(select 1 from public.players where lower(trim(email))=v_email))
       or (v_messenger <> '' and exists(select 1 from public.players where lower(trim(messenger))=lower(v_messenger))) then
      raise exception using errcode='23505', message='PLAYER_CONTACT_CONFLICT';
    end if;
    begin v_imported := nullif(v_item->>'imported_at','')::timestamptz; exception when others then raise exception using errcode='22023',message='INVALID_IMPORTED_AT'; end;
    insert into public.players(id,phone,email,messenger,status,agent_id,imported_at,created_by)
      values(v_id,v_phone,v_email,v_messenger,'new',null,coalesce(v_imported,now()),v_actor.id);
  end loop;
  return query select ps.* from public.players_secure ps
    where ps.id in (select value->>'id' from jsonb_array_elements(p_players)) order by ps.imported_at, ps.id;
end $$;

create function public.assign_players_atomic(p_player_ids text[], p_agent_ids uuid[], p_confirm_final boolean default false)
returns setof public.players_secure
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_player_id text; v_agent_id uuid; v_index integer := 0; v_player public.players;
begin
  v_actor := public.require_active_profile();
  if v_actor.role <> 'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if coalesce(array_length(p_player_ids,1),0)=0 or coalesce(array_length(p_agent_ids,1),0)=0 then raise exception using errcode='22023',message='EMPTY_ASSIGNMENT'; end if;
  if exists(select 1 from unnest(p_agent_ids) a where not exists(select 1 from public.profiles where id=a and role='agent' and is_active)) then raise exception using errcode='22023',message='INVALID_AGENT'; end if;
  foreach v_player_id in array p_player_ids loop
    select * into v_player from public.players where id=v_player_id for update;
    if not found then raise exception using errcode='P0002',message='PLAYER_NOT_FOUND'; end if;
    if v_player.status in ('success','failed') and not p_confirm_final then raise exception using errcode='42501',message='CONFIRMATION_REQUIRED'; end if;
    v_agent_id := p_agent_ids[(v_index % array_length(p_agent_ids,1))+1]; v_index := v_index+1;
    update public.players set agent_id=v_agent_id,
      status=case when status in ('new','no_answer') then 'assigned'::public.player_status else status end
      where id=v_player_id;
  end loop;
  return query select ps.* from public.players_secure ps where ps.id=any(p_player_ids) order by ps.id;
end $$;

create function public.change_player_status_atomic(p_player_id text, p_next_status public.player_status, p_history_id text, p_confirm_reopen boolean default false)
returns public.players_secure
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_player public.players; v_from public.player_status; v_allowed boolean; v_secure public.players_secure;
begin
  v_actor:=public.require_active_profile(); select * into v_player from public.players where id=p_player_id for update;
  if not found then raise exception using errcode='P0002',message='PLAYER_NOT_FOUND'; end if; v_from:=v_player.status;
  if v_actor.role<>'admin' and v_player.agent_id is distinct from v_actor.id then raise exception using errcode='42501',message='NOT_OWNER'; end if;
  v_allowed:=(v_from='new' and p_next_status='assigned') or (v_from='assigned' and p_next_status='in_work') or (v_from='in_work' and p_next_status in ('success','no_answer','failed')) or (v_from='no_answer' and p_next_status='assigned') or (v_from in ('success','failed') and p_next_status='in_work');
  if not v_allowed then raise exception using errcode='22023',message='INVALID_STATUS_TRANSITION'; end if;
  if v_actor.role<>'admin' and v_from in ('new','success','failed') then raise exception using errcode='42501',message='ROLE_FORBIDDEN'; end if;
  if v_from in ('success','failed') and not p_confirm_reopen then raise exception using errcode='42501',message='CONFIRMATION_REQUIRED'; end if;
  if nullif(trim(p_history_id),'') is null then raise exception using errcode='22023',message='HISTORY_ID_REQUIRED'; end if;
  update public.players set status=p_next_status where id=p_player_id;
  insert into public.player_status_history(id,player_id,from_status,to_status,user_id,user_name,user_role) values(p_history_id,p_player_id,v_from,p_next_status,v_actor.id,v_actor.name,v_actor.role);
  select ps.* into v_secure from public.players_secure ps where ps.id=p_player_id;
  return v_secure;
end $$;

create function public.set_player_follow_up_atomic(p_player_id text, p_follow_up_at timestamptz)
returns public.players_secure
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_player public.players; v_secure public.players_secure;
begin
  v_actor:=public.require_active_profile(); select * into v_player from public.players where id=p_player_id for update;
  if not found then raise exception using errcode='P0002',message='PLAYER_NOT_FOUND'; end if;
  if v_actor.role<>'admin' and v_player.agent_id is distinct from v_actor.id then raise exception using errcode='42501',message='NOT_OWNER'; end if;
  update public.players set follow_up_at=p_follow_up_at where id=p_player_id;
  select ps.* into v_secure from public.players_secure ps where ps.id=p_player_id;
  return v_secure;
end $$;

revoke all on function public.create_players_atomic(jsonb), public.assign_players_atomic(text[],uuid[],boolean),
  public.change_player_status_atomic(text,public.player_status,text,boolean),
  public.set_player_follow_up_atomic(text,timestamptz) from public, anon;
grant execute on function public.create_players_atomic(jsonb), public.assign_players_atomic(text[],uuid[],boolean),
  public.change_player_status_atomic(text,public.player_status,text,boolean),
  public.set_player_follow_up_atomic(text,timestamptz) to authenticated;

commit;
