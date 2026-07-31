-- Rollback for PR B file 1 (20260802000100_contact_reveal_audit.sql).
--
-- ============================ MANDATORY PRECONDITION ============================
-- THIS SCRIPT DESTROYS THE CONTACT DISCLOSURE AUDIT TRAIL.
--
-- Technically this rollback is clean; evidentially it is irreversible. Every record of who obtained which
-- player's contacts, and of every denial, replay, conflict and throttle, lives in contact_reveal_events and
-- nowhere else. Once dropped it cannot be reconstructed from any other table.
--
-- Before running this file in ANY environment where a reveal has occurred, the operator MUST export
-- contact_reveal_events to the encrypted company archive and confirm the export is readable. Run file 2's
-- rollback first if the goal is only to disable reveal: that removes the RPC and leaves the evidence intact.
--
-- Confirm the export exists, then verify the count you exported matches:
--     select count(*), min(created_at), max(created_at) from public.contact_reveal_events;
--
-- The export destination and its retention are a compliance decision and are recorded in the PR, not here.
-- Do not run this script to "clean up" a local environment that shares a database with real reveal history.
-- ===============================================================================
--
-- Apply the file 2 rollback first; reveal_player_contacts depends on this table.
-- The delete trigger refuses non-owner callers, so this must run as the table owner (the migration role).
begin;

drop trigger if exists contact_reveal_events_no_update on public.contact_reveal_events;
drop trigger if exists contact_reveal_events_no_delete on public.contact_reveal_events;
drop function if exists public.contact_reveal_events_immutable();

drop table if exists public.contact_reveal_events;
drop table if exists public.contact_reveal_limits;

drop type if exists public.contact_reveal_reason;

commit;
