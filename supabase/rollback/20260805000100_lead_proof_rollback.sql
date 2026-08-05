-- Rollback for 20260805000100_lead_proof.sql.
--
-- Restores change_player_status_atomic to its pre-proof definition, removes the
-- proof RPCs, storage policies, table, and enum, and empties the bucket.
--
-- Data note: proof rows and their storage objects are evidence. This script
-- deletes them, so take a copy first if the environment holds anything that
-- must be retained. It is written for a test environment.
begin;

-- Restore the transition function as 20260801000100 left it: masked
-- players_secure return type, no proof gate.
create or replace function public.change_player_status_atomic(p_player_id text, p_next_status public.player_status, p_history_id text, p_confirm_reopen boolean default false)
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

drop function if exists public.discard_lead_proof(uuid);
drop function if exists public.confirm_lead_proof(uuid);
drop function if exists public.request_lead_proof_upload(text, uuid, text, text, bigint);
drop function if exists public.proof_authorize_player(text, boolean);

drop policy if exists lead_proofs_objects_delete_own_discarded on storage.objects;
drop policy if exists lead_proofs_objects_update_own_pending on storage.objects;
drop policy if exists lead_proofs_objects_select_admin_or_assigned on storage.objects;
drop policy if exists lead_proofs_objects_insert_own_pending on storage.objects;

delete from storage.objects where bucket_id = 'lead-proofs';
delete from storage.buckets where id = 'lead-proofs';

drop policy if exists lead_proofs_select_admin_or_assigned on public.lead_proofs;
drop table if exists public.lead_proofs;
drop type if exists public.lead_proof_state;

commit;
