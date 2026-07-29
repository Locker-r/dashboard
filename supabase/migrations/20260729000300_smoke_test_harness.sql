-- SMOKE-TEST ONLY. Apply to local Supabase or a dedicated staging project.
-- Never include this helper in a production deployment.
begin;

create or replace function public.provision_local_smoke_test_profile(p_id uuid, p_username text, p_role public.user_role)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare v_email text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'LOCAL_SERVICE_ROLE_REQUIRED';
  end if;
  select email into v_email from auth.users where id = p_id;
  if not found or lower(v_email) not like 'smoke\_test%' escape '\' then
    raise exception using errcode = '22023', message = 'SMOKE_ACCOUNT_PREFIX_REQUIRED';
  end if;
  if p_username not like 'SMOKE\_TEST\_%' escape '\' then
    raise exception using errcode = '22023', message = 'SMOKE_USERNAME_PREFIX_REQUIRED';
  end if;
  insert into public.profiles(id, username, name, role, lang, is_active)
    values(p_id, p_username, p_username, p_role, 'en', true)
  on conflict (id) do update set
    username = excluded.username, name = excluded.name, role = excluded.role,
    lang = excluded.lang, is_active = true;
end $$;

create or replace function public.cleanup_smoke_test_run_atomic(p_run_id text, p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles;
  v_prefix text;
  v_marker text;
  v_players integer;
  v_comments integer;
  v_history integer;
begin
  v_actor := public.require_active_profile();
  if v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  if p_run_id !~ '^[a-z0-9]{12,40}$' then
    raise exception using errcode = '22023', message = 'INVALID_SMOKE_RUN_ID';
  end if;
  if p_confirmation <> 'DELETE_SMOKE_TEST_' || p_run_id then
    raise exception using errcode = '22023', message = 'SMOKE_CLEANUP_CONFIRMATION_REQUIRED';
  end if;

  v_prefix := 'SMOKE_TEST_' || p_run_id || '_';
  v_marker := 'SMOKE_TEST:' || p_run_id;

  select count(*) into v_comments
  from public.player_comments c
  join public.players p on p.id = c.player_id
  where left(p.id, char_length(v_prefix)) = v_prefix
    and left(p.messenger, char_length(v_marker) + 1) = v_marker || ':'
    and p.created_by = v_actor.id;

  select count(*) into v_history
  from public.player_status_history h
  join public.players p on p.id = h.player_id
  where left(p.id, char_length(v_prefix)) = v_prefix
    and left(p.messenger, char_length(v_marker) + 1) = v_marker || ':'
    and p.created_by = v_actor.id;

  delete from public.players p
  where left(p.id, char_length(v_prefix)) = v_prefix
    and left(p.messenger, char_length(v_marker) + 1) = v_marker || ':'
    and p.created_by = v_actor.id;
  get diagnostics v_players = row_count;

  return jsonb_build_object(
    'run_id', p_run_id,
    'players_deleted', v_players,
    'comments_deleted', v_comments,
    'history_deleted', v_history
  );
end $$;

revoke all on function public.cleanup_smoke_test_run_atomic(text, text) from public, anon;
grant execute on function public.cleanup_smoke_test_run_atomic(text, text) to authenticated;
revoke all on function public.provision_local_smoke_test_profile(uuid, text, public.user_role) from public, anon, authenticated;
grant execute on function public.provision_local_smoke_test_profile(uuid, text, public.user_role) to service_role;

commit;
