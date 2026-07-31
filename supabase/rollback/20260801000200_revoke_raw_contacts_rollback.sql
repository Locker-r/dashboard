-- Rollback for phase 2 (20260801000200_revoke_raw_contacts.sql).
-- Restores the original table level SELECT grant, making raw contact columns readable again for
-- authenticated. Apply this alone if the cut-over must be reverted while the projection stays in place.
begin;

revoke select (id, status, agent_id, created_by, imported_at, updated_at, follow_up_at)
  on public.players from authenticated;

grant select on public.players to authenticated;

commit;
