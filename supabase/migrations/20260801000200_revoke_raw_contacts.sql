-- Secure Contact Boundary (PR A), phase 2: cut-over that removes raw contact access for authenticated.
-- Apply only after the frontend reads public.players_secure (phase 1 plus the application change).
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
