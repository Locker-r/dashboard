begin;

create or replace function public.can_read_player_secure(p_agent_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active
      and (p.role = 'admin' or (p.role = 'agent' and p.id = p_agent_id))
  );
$$;

revoke all on function public.can_read_player_secure(uuid) from public, anon;
grant execute on function public.can_read_player_secure(uuid) to authenticated;

create or replace function public.can_read_player_activity_secure(p_player_id text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.players pl
    join public.profiles pr on pr.id = auth.uid() and pr.is_active
    where pl.id = p_player_id
      and (pr.role = 'admin' or (pr.role = 'agent' and pl.agent_id = pr.id))
  );
$$;

revoke all on function public.can_read_player_activity_secure(text) from public, anon;
grant execute on function public.can_read_player_activity_secure(text) to authenticated;

drop policy if exists comments_select_admin_or_assigned on public.player_comments;
create policy comments_select_admin_or_assigned on public.player_comments for select to authenticated
using (public.can_read_player_activity_secure(player_id));
drop policy if exists history_select_admin_or_assigned on public.player_status_history;
create policy history_select_admin_or_assigned on public.player_status_history for select to authenticated
using (public.can_read_player_activity_secure(player_id));

create or replace view public.players_secure
with (security_barrier = true) as
select
  p.id, p.status, p.agent_id, p.imported_at, p.updated_at, p.follow_up_at, p.created_by,
  case when char_length(regexp_replace(p.phone, '[^0-9]', '', 'g')) >= 7
    then '***' || right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 4) else null end as phone_display,
  case when position('@' in p.email) > 1
    then left(p.email, 1) || '***@' || split_part(p.email, '@', 2) else null end as email_display,
  case when nullif(trim(p.messenger), '') is not null
    then case when left(trim(p.messenger), 1) = '@'
      then '@' || left(substr(trim(p.messenger), 2), 1) || '***'
      else left(trim(p.messenger), 1) || '***' end else null end as messenger_display,
  nullif(trim(p.phone), '') is not null as has_phone,
  nullif(trim(p.email), '') is not null as has_email,
  nullif(trim(p.messenger), '') is not null as has_messenger,
  case when p.status = 'in_work' then 'eligible' else 'locked' end::text as contact_access_state
from public.players p
where public.can_read_player_secure(p.agent_id);

revoke all on public.players_secure from public, anon;
grant select on public.players_secure to authenticated;
revoke select on public.players from authenticated;

create or replace function public.check_player_duplicates_atomic(p_players jsonb)
returns table(row_index integer, duplicate boolean, matched_player_id text, matched_fields text[])
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor public.profiles; v_item jsonb; v_index integer; v_match public.players; v_fields text[];
begin
  v_actor := public.require_active_profile();
  if v_actor.role <> 'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if jsonb_typeof(p_players) <> 'array' or jsonb_array_length(p_players) > 5000 then raise exception using errcode='22023',message='INVALID_PLAYER_BATCH'; end if;
  for v_item, v_index in select value, (ordinality - 1)::integer from jsonb_array_elements(p_players) with ordinality loop
    v_match := null; v_fields := array[]::text[];
    select p.* into v_match from public.players p where
      (nullif(trim(v_item->>'id'),'') is not null and p.id=trim(v_item->>'id')) or
      (nullif(regexp_replace(v_item->>'phone','[^0-9+]','','g'),'') is not null and regexp_replace(p.phone,'[^0-9+]','','g')=regexp_replace(v_item->>'phone','[^0-9+]','','g')) or
      (nullif(lower(trim(v_item->>'email')),'') is not null and lower(trim(p.email))=lower(trim(v_item->>'email'))) or
      (nullif(lower(trim(v_item->>'messenger')),'') is not null and lower(trim(p.messenger))=lower(trim(v_item->>'messenger')))
      order by p.id limit 1;
    if found then
      if v_match.id=trim(coalesce(v_item->>'id','')) then v_fields:=array_append(v_fields,'id'); end if;
      if nullif(regexp_replace(v_item->>'phone','[^0-9+]','','g'),'') is not null and regexp_replace(v_match.phone,'[^0-9+]','','g')=regexp_replace(v_item->>'phone','[^0-9+]','','g') then v_fields:=array_append(v_fields,'phone'); end if;
      if nullif(lower(trim(v_item->>'email')),'') is not null and lower(trim(v_match.email))=lower(trim(v_item->>'email')) then v_fields:=array_append(v_fields,'email'); end if;
      if nullif(lower(trim(v_item->>'messenger')),'') is not null and lower(trim(v_match.messenger))=lower(trim(v_item->>'messenger')) then v_fields:=array_append(v_fields,'messenger'); end if;
    end if;
    return query select v_index, v_match.id is not null, v_match.id, v_fields;
  end loop;
end $$;

revoke all on function public.check_player_duplicates_atomic(jsonb) from public, anon;
grant execute on function public.check_player_duplicates_atomic(jsonb) to authenticated;

-- Ordinary RPCs keep their established signatures but scrub contact attributes from returned rows.
-- Callers use only safe operational state and reload through players_secure.
create or replace function public.secure_player_result(p public.players)
returns public.players language sql immutable set search_path = pg_catalog, public as $$
  select row(p.id,'','','',p.status,p.agent_id,p.imported_at,p.updated_at,p.follow_up_at,p.created_by)::public.players;
$$;
revoke all on function public.secure_player_result(public.players) from public, anon, authenticated;

-- Wrap existing mutation implementations by renaming them once, then expose scrubbed contracts.
alter function public.create_players_atomic(jsonb) rename to create_players_atomic_raw_legacy;
alter function public.assign_players_atomic(text[],uuid[],boolean) rename to assign_players_atomic_raw_legacy;
alter function public.change_player_status_atomic(text,public.player_status,text,boolean) rename to change_player_status_atomic_raw_legacy;
alter function public.set_player_follow_up_atomic(text,timestamptz) rename to set_player_follow_up_atomic_raw_legacy;

create function public.create_players_atomic(p_players jsonb) returns setof public.players language sql security definer set search_path=pg_catalog,public as $$ select public.secure_player_result(p) from public.create_players_atomic_raw_legacy(p_players) p $$;
create function public.assign_players_atomic(p_player_ids text[],p_agent_ids uuid[],p_confirm_final boolean default false) returns setof public.players language sql security definer set search_path=pg_catalog,public as $$ select public.secure_player_result(p) from public.assign_players_atomic_raw_legacy(p_player_ids,p_agent_ids,p_confirm_final) p $$;
create function public.change_player_status_atomic(p_player_id text,p_next_status public.player_status,p_history_id text,p_confirm_reopen boolean default false) returns public.players language sql security definer set search_path=pg_catalog,public as $$ select public.secure_player_result(public.change_player_status_atomic_raw_legacy(p_player_id,p_next_status,p_history_id,p_confirm_reopen)) $$;
create function public.set_player_follow_up_atomic(p_player_id text,p_follow_up_at timestamptz) returns public.players language sql security definer set search_path=pg_catalog,public as $$ select public.secure_player_result(public.set_player_follow_up_atomic_raw_legacy(p_player_id,p_follow_up_at)) $$;

revoke all on function public.create_players_atomic_raw_legacy(jsonb),public.assign_players_atomic_raw_legacy(text[],uuid[],boolean),public.change_player_status_atomic_raw_legacy(text,public.player_status,text,boolean),public.set_player_follow_up_atomic_raw_legacy(text,timestamptz) from public,anon,authenticated;
revoke all on function public.create_players_atomic(jsonb),public.assign_players_atomic(text[],uuid[],boolean),public.change_player_status_atomic(text,public.player_status,text,boolean),public.set_player_follow_up_atomic(text,timestamptz) from public,anon;
grant execute on function public.create_players_atomic(jsonb),public.assign_players_atomic(text[],uuid[],boolean),public.change_player_status_atomic(text,public.player_status,text,boolean),public.set_player_follow_up_atomic(text,timestamptz) to authenticated;

commit;
