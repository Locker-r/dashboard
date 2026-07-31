-- Rollback for PR B file 2 (20260802000200_contact_reveal_rpc.sql).
-- Removes the reveal, purge and configuration functions. Destroys no audit evidence: the event table and
-- its history are untouched by this file, so this rollback alone is always safe to run.
-- Effect: the reveal path disappears and the application returns to fully masked behaviour, which is the
-- safe direction of failure.
begin;

drop function if exists public.reveal_player_contacts(text, uuid);
drop function if exists public.set_contact_reveal_limits(integer, integer);
drop function if exists public.purge_contact_reveal_events(timestamptz);

commit;
