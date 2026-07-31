begin;
drop view if exists public.players_secure;
drop function if exists public.check_player_duplicates_atomic(jsonb);
drop function if exists public.create_players_atomic(jsonb);
drop function if exists public.assign_players_atomic(text[],uuid[],boolean);
drop function if exists public.change_player_status_atomic(text,public.player_status,text,boolean);
drop function if exists public.set_player_follow_up_atomic(text,timestamptz);
alter function public.create_players_atomic_raw_legacy(jsonb) rename to create_players_atomic;
alter function public.assign_players_atomic_raw_legacy(text[],uuid[],boolean) rename to assign_players_atomic;
alter function public.change_player_status_atomic_raw_legacy(text,public.player_status,text,boolean) rename to change_player_status_atomic;
alter function public.set_player_follow_up_atomic_raw_legacy(text,timestamptz) rename to set_player_follow_up_atomic;
drop function if exists public.secure_player_result(public.players);
drop policy if exists comments_select_admin_or_assigned on public.player_comments;
create policy comments_select_admin_or_assigned on public.player_comments for select to authenticated
using (public.is_admin() or exists (select 1 from public.players p where p.id = player_id and p.agent_id = auth.uid()));
drop policy if exists history_select_admin_or_assigned on public.player_status_history;
create policy history_select_admin_or_assigned on public.player_status_history for select to authenticated
using (public.is_admin() or exists (select 1 from public.players p where p.id = player_id and p.agent_id = auth.uid()));
drop function if exists public.can_read_player_activity_secure(text);
drop function if exists public.can_read_player_secure(uuid);
grant select on public.players to authenticated;
commit;
