-- Secure Contact Boundary (PR A), file 2 of 2: cut-over that removes raw contact access for authenticated.
--
-- Separated from 20260801000100 for reviewability, not for staged rollout: the repository migration
-- process applies both files in one deployment. Cached frontend clients that still select raw contact
-- columns will receive permission errors until they load the updated application, so frontend and
-- backend must be released together. A true multi-release staged rollout is deferred.
--
-- A table level GRANT SELECT implicitly covers every column, and a column level REVOKE cannot subtract from
-- it. The table grant is therefore replaced by an explicit column list that omits phone, email and messenger.
-- Non contact columns stay readable so row level security keeps governing the direct table path and existing
-- operational reads (smoke harness, id/status/agent_id lookups) continue to work unchanged.
begin;

revoke select on public.players from authenticated;

grant select (id, status, agent_id, created_by, imported_at, updated_at, follow_up_at)
  on public.players to authenticated;

-- Raw contacts remain reachable only to service_role and to definer-owned objects (players_secure,
-- the atomic RPCs, check_player_duplicates), never to a browser session through PostgREST or pg_graphql.
commit;
