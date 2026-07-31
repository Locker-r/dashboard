-- Secure Contact Boundary (PR A), file 1 of 2: additive masked projection, helpers and safe RPC shapes.
--
-- This file and 20260801000200_revoke_raw_contacts.sql separate additive objects from the privilege
-- cut-over LOGICALLY only. The repository migration process applies both in a single deployment, so this
-- is NOT a staged multi-release rollout: after deployment, a browser still running cached JavaScript that
-- selects players.phone/email/messenger receives a permission error. Deployment therefore requires a
-- coordinated frontend and backend release. A true staged rollout across releases is deferred.
begin;

-- Canonical normalization used by the projection for the has_* flags and by the masking helpers.
-- These carry SET search_path, which means PostgreSQL will NOT inline them, so they must never appear
-- inside an indexed predicate. Duplicate detection therefore uses the literal index expressions instead
-- (see check_player_duplicates below); these helpers are for display and presence flags only.
-- A phone is canonically present only when it contains at least one digit, so that phone_display and
-- has_phone can never disagree: no digits means both NULL and false.
create or replace function public.normalize_contact_phone(p_value text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when regexp_replace(coalesce(p_value,''), '[^0-9]', '', 'g') = '' then null
    else nullif(regexp_replace(coalesce(p_value,''), '[^0-9+]', '', 'g'), '')
  end
$$;

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
-- Derived from the same canonical result as has_phone, so the display and the flag always agree:
-- normalize returns null (flag false) exactly when this returns null.
create or replace function public.mask_contact_phone(p_value text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when digits.value is null then null
    when char_length(digits.value) < 6 then '***'
    else repeat('*', char_length(digits.value) - 4) || right(digits.value, 4)
  end
  from (select nullif(regexp_replace(coalesce(public.normalize_contact_phone(p_value), ''), '[^0-9]', '', 'g'), '') as value) digits
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

-- EXECUTE must be granted to authenticated even though these helpers are only referenced by the view.
-- A view resolves TABLE permissions as the view owner, but FUNCTIONS invoked by the view are executed with
-- the calling role's privileges; revoking these produces "permission denied for function
-- mask_contact_phone" on every list query. Verified at runtime, do not "harden" this away.
-- The helpers are pure and take only a caller-supplied text, so this grant discloses nothing:
-- can_read_player merely reports whether the caller itself may read a row.
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
declare v_actor public.profiles;
begin
  v_actor := public.require_active_profile();
  if v_actor.role <> 'admin' then raise exception using errcode = '42501', message = 'ADMIN_REQUIRED'; end if;
  if jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) > 5000 then
    raise exception using errcode = '22023', message = 'INVALID_CANDIDATE_BATCH';
  end if;
  if exists (select 1 from jsonb_array_elements(p_candidates) e where jsonb_typeof(e.value) <> 'object') then
    raise exception using errcode = '22023', message = 'INVALID_CANDIDATE';
  end if;

  -- One set-based pass instead of a scan per candidate. Each channel joins on the exact literal
  -- expression and partial predicate of its expression index (players_phone_normalized_idx,
  -- players_email_normalized_idx, players_messenger_normalized_idx), so the planner can use them.
  -- The non-inlinable normalize_contact_* helpers are deliberately not called on the players side.
  return query
  with candidates as (
    select
      (e.ordinality - 1)::integer as row_index,
      nullif(trim(coalesce(e.value->>'id','')), '')                                  as cand_id,
      nullif(regexp_replace(coalesce(e.value->>'phone',''), '[^0-9+]', '', 'g'), '')  as cand_phone,
      nullif(lower(trim(coalesce(e.value->>'email',''))), '')                         as cand_email,
      nullif(lower(trim(coalesce(e.value->>'messenger',''))), '')                     as cand_messenger
    from jsonb_array_elements(p_candidates) with ordinality as e(value, ordinality)
  ),
  matches as (
    select c.row_index, p.id as player_id, 1 as priority, 'id' as field
      from candidates c join public.players p on p.id = c.cand_id
     where c.cand_id is not null
    union all
    select c.row_index, p.id, 2, 'phone'
      from candidates c join public.players p
        on regexp_replace(p.phone, '[^0-9+]', '', 'g') = c.cand_phone
       and nullif(trim(p.phone), '') is not null
     where c.cand_phone is not null
    union all
    select c.row_index, p.id, 3, 'email'
      from candidates c join public.players p
        on lower(trim(p.email)) = c.cand_email
       and nullif(trim(p.email), '') is not null
     where c.cand_email is not null
    union all
    select c.row_index, p.id, 4, 'messenger'
      from candidates c join public.players p
        on lower(trim(p.messenger)) = c.cand_messenger
       and nullif(trim(p.messenger), '') is not null
     where c.cand_messenger is not null
  ),
  -- Deterministic: lowest channel priority wins, then lowest player id.
  ranked as (
    select distinct on (m.row_index) m.row_index, m.player_id
      from matches m order by m.row_index, m.priority, m.player_id
  ),
  resolved as (
    select r.row_index, r.player_id, array_agg(m.field order by m.priority) as field_list
      from ranked r join matches m on m.row_index = r.row_index and m.player_id = r.player_id
     group by r.row_index, r.player_id
  )
  select c.row_index, resolved.player_id is not null, resolved.player_id,
         coalesce(resolved.field_list, array[]::text[])
    from candidates c left join resolved on resolved.row_index = c.row_index
   order by c.row_index;
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
