-- Read-only verification. Run after manually applying atomic-writes.sql.
with expected(name) as (values
  ('create_players_atomic'),
  ('assign_players_atomic'),
  ('change_player_status_atomic'),
  ('add_player_comment_atomic'),
  ('set_player_follow_up_atomic')
), actual as (
  select p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
    p.prosecdef as security_definer,
    coalesce(array_to_string(p.proconfig,','),'') like '%search_path=pg_catalog, public%' as fixed_search_path,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in (select name from expected)
)
select e.name, a.arguments, coalesce(a.security_definer,false) as security_definer,
  coalesce(a.fixed_search_path,false) as fixed_search_path,
  coalesce(a.authenticated_execute,false) as authenticated_execute,
  not coalesce(a.anon_execute,true) as anon_blocked,
  (a.name is not null and a.security_definer and a.fixed_search_path and a.authenticated_execute and not a.anon_execute) as ok
from expected e left join actual a on a.name=e.name
order by e.name;
