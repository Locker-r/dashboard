-- Run manually in Supabase SQL Editor only after reviewing and backing up the project.
-- This migration is transactional and exposes narrowly scoped writes to authenticated users.
begin;

create or replace function public.require_active_profile()
returns public.profiles
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_profile public.profiles;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  select * into v_profile from public.profiles where id = auth.uid() and is_active;
  if not found then raise exception using errcode = '42501', message = 'ACTIVE_PROFILE_REQUIRED'; end if;
  return v_profile;
end $$;

create or replace function public.create_players_atomic(p_players jsonb)
returns setof public.players
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
  return query select p.* from public.players p where p.id in (select value->>'id' from jsonb_array_elements(p_players)) order by p.imported_at, p.id;
end $$;

create or replace function public.assign_players_atomic(p_player_ids text[], p_agent_ids uuid[], p_confirm_final boolean default false)
returns setof public.players
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
  return query select p.* from public.players p where p.id=any(p_player_ids) order by p.id;
end $$;

create or replace function public.change_player_status_atomic(p_player_id text, p_next_status public.player_status, p_history_id text, p_confirm_reopen boolean default false)
returns public.players language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor public.profiles; v_player public.players; v_from public.player_status; v_allowed boolean;
begin
  v_actor:=public.require_active_profile(); select * into v_player from public.players where id=p_player_id for update;
  if not found then raise exception using errcode='P0002',message='PLAYER_NOT_FOUND'; end if; v_from:=v_player.status;
  if v_actor.role<>'admin' and v_player.agent_id is distinct from v_actor.id then raise exception using errcode='42501',message='NOT_OWNER'; end if;
  v_allowed:=(v_from='new' and p_next_status='assigned') or (v_from='assigned' and p_next_status='in_work') or (v_from='in_work' and p_next_status in ('success','no_answer','failed')) or (v_from='no_answer' and p_next_status='assigned') or (v_from in ('success','failed') and p_next_status='in_work');
  if not v_allowed then raise exception using errcode='22023',message='INVALID_STATUS_TRANSITION'; end if;
  if v_actor.role<>'admin' and v_from in ('new','success','failed') then raise exception using errcode='42501',message='ROLE_FORBIDDEN'; end if;
  if v_from in ('success','failed') and not p_confirm_reopen then raise exception using errcode='42501',message='CONFIRMATION_REQUIRED'; end if;
  if nullif(trim(p_history_id),'') is null then raise exception using errcode='22023',message='HISTORY_ID_REQUIRED'; end if;
  update public.players set status=p_next_status where id=p_player_id returning * into v_player;
  insert into public.player_status_history(id,player_id,from_status,to_status,user_id,user_name,user_role) values(p_history_id,p_player_id,v_from,p_next_status,v_actor.id,v_actor.name,v_actor.role);
  return v_player;
end $$;

create or replace function public.add_player_comment_atomic(p_player_id text,p_comment_id text,p_text text)
returns public.player_comments language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor public.profiles; v_player public.players; v_comment public.player_comments;
begin
  v_actor:=public.require_active_profile(); select * into v_player from public.players where id=p_player_id for update;
  if not found then raise exception using errcode='P0002',message='PLAYER_NOT_FOUND'; end if;
  if v_actor.role<>'admin' and v_player.agent_id is distinct from v_actor.id then raise exception using errcode='42501',message='NOT_OWNER'; end if;
  if nullif(trim(p_comment_id),'') is null or char_length(trim(coalesce(p_text,''))) not between 1 and 1000 then raise exception using errcode='22023',message='INVALID_COMMENT'; end if;
  insert into public.player_comments(id,player_id,text,author_id,author_name,author_role) values(p_comment_id,p_player_id,trim(p_text),v_actor.id,v_actor.name,v_actor.role) returning * into v_comment;
  update public.players set updated_at=now() where id=p_player_id; return v_comment;
end $$;

create or replace function public.set_player_follow_up_atomic(p_player_id text,p_follow_up_at timestamptz)
returns public.players language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor public.profiles; v_player public.players;
begin
  v_actor:=public.require_active_profile(); select * into v_player from public.players where id=p_player_id for update;
  if not found then raise exception using errcode='P0002',message='PLAYER_NOT_FOUND'; end if;
  if v_actor.role<>'admin' and v_player.agent_id is distinct from v_actor.id then raise exception using errcode='42501',message='NOT_OWNER'; end if;
  update public.players set follow_up_at=p_follow_up_at where id=p_player_id returning * into v_player; return v_player;
end $$;

revoke all on function public.require_active_profile() from public,anon,authenticated;
revoke all on function public.create_players_atomic(jsonb),public.assign_players_atomic(text[],uuid[],boolean),public.change_player_status_atomic(text,public.player_status,text,boolean),public.add_player_comment_atomic(text,text,text),public.set_player_follow_up_atomic(text,timestamptz) from public,anon;
grant execute on function public.create_players_atomic(jsonb),public.assign_players_atomic(text[],uuid[],boolean),public.change_player_status_atomic(text,public.player_status,text,boolean),public.add_player_comment_atomic(text,text,text),public.set_player_follow_up_atomic(text,timestamptz) to authenticated;

commit;
