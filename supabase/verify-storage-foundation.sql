-- Read-only verification for the Dashboard Supabase storage foundation.
-- The statement returns one result set: check_name | status | details.

with
expected_tables(table_name) as (
  values
    ('profiles'),
    ('players'),
    ('player_comments'),
    ('player_status_history')
),
required_tables as (
  select
    count(*) filter (where to_regclass(format('public.%I', table_name)) is not null) as found_count,
    coalesce(
      string_agg(table_name, ', ' order by table_name)
        filter (where to_regclass(format('public.%I', table_name)) is null),
      'none'
    ) as missing
  from expected_tables
),
required_rls as (
  select
    count(*) filter (where coalesce(c.relrowsecurity, false)) as enabled_count,
    coalesce(
      string_agg(e.table_name, ', ' order by e.table_name)
        filter (where not coalesce(c.relrowsecurity, false)),
      'none'
    ) as missing
  from expected_tables e
  left join pg_namespace n on n.nspname = 'public'
  left join pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.table_name
   and c.relkind in ('r', 'p')
),
expected_policies(table_name, policy_name) as (
  values
    ('profiles', 'profiles_select_own_or_admin'),
    ('players', 'players_select_admin_or_assigned'),
    ('player_comments', 'comments_select_admin_or_assigned'),
    ('player_status_history', 'history_select_admin_or_assigned')
),
required_policies as (
  select
    count(*) filter (where p.policyname is not null) as found_count,
    coalesce(
      string_agg(e.table_name || '.' || e.policy_name, ', ' order by e.table_name)
        filter (where p.policyname is null),
      'none'
    ) as missing
  from expected_policies e
  left join pg_policies p
    on p.schemaname = 'public'
   and p.tablename = e.table_name
   and p.policyname = e.policy_name
   and p.cmd = 'SELECT'
   and 'authenticated' = any(p.roles)
   and p.qual like '%is_admin()%'
   and (
     e.table_name = 'profiles'
     or p.qual like '%agent_id%'
   )
),
anon_table_access as (
  select count(*) as access_count
  from expected_tables e
  join pg_namespace n on n.nspname = 'public'
  join pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.table_name
   and c.relkind in ('r', 'p')
  cross join (
    values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
  ) privilege(privilege_name)
  where has_table_privilege('anon', c.oid, privilege.privilege_name)
),
admin_function as (
  select count(*) as found_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'is_admin'
    and pg_get_function_identity_arguments(p.oid) = ''
    and p.prosecdef
),
security_definer_functions as (
  select
    count(*) as function_count,
    count(*) filter (
      where exists (
        select 1
        from unnest(coalesce(p.proconfig, array[]::text[])) setting
        where setting ~ '^search_path='
          and setting <> 'search_path='
      )
    ) as fixed_count,
    coalesce(
      string_agg(p.proname, ', ' order by p.proname)
        filter (
          where not exists (
            select 1
            from unnest(coalesce(p.proconfig, array[]::text[])) setting
            where setting ~ '^search_path='
              and setting <> 'search_path='
          )
        ),
      'none'
    ) as missing
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
),
expected_indexes(index_name) as (
  values
    ('profiles_role_idx'),
    ('profiles_active_idx'),
    ('players_agent_id_idx'),
    ('players_status_idx'),
    ('players_updated_at_idx'),
    ('players_follow_up_at_idx'),
    ('players_phone_normalized_idx'),
    ('players_email_normalized_idx'),
    ('players_messenger_normalized_idx'),
    ('player_comments_player_idx'),
    ('player_comments_author_idx'),
    ('player_status_history_player_idx'),
    ('player_status_history_user_idx')
),
required_indexes as (
  select
    count(*) filter (where i.indexname is not null) as found_count,
    coalesce(
      string_agg(e.index_name, ', ' order by e.index_name)
        filter (where i.indexname is null),
      'none'
    ) as missing
  from expected_indexes e
  left join pg_indexes i
    on i.schemaname = 'public'
   and i.indexname = e.index_name
),
expected_foreign_keys(source_table, source_column, target_schema, target_table, target_column) as (
  values
    ('profiles', 'id', 'auth', 'users', 'id'),
    ('players', 'agent_id', 'public', 'profiles', 'id'),
    ('players', 'created_by', 'public', 'profiles', 'id'),
    ('player_comments', 'player_id', 'public', 'players', 'id'),
    ('player_comments', 'author_id', 'public', 'profiles', 'id'),
    ('player_status_history', 'player_id', 'public', 'players', 'id'),
    ('player_status_history', 'user_id', 'public', 'profiles', 'id')
),
actual_foreign_keys as (
  select
    source_table.relname as source_table,
    source_attribute.attname as source_column,
    target_namespace.nspname as target_schema,
    target_table.relname as target_table,
    target_attribute.attname as target_column
  from pg_constraint constraint_row
  join pg_class source_table on source_table.oid = constraint_row.conrelid
  join pg_namespace source_namespace on source_namespace.oid = source_table.relnamespace
  join pg_class target_table on target_table.oid = constraint_row.confrelid
  join pg_namespace target_namespace on target_namespace.oid = target_table.relnamespace
  cross join lateral unnest(constraint_row.conkey) with ordinality source_key(attnum, position)
  join lateral unnest(constraint_row.confkey) with ordinality target_key(attnum, position)
    on target_key.position = source_key.position
  join pg_attribute source_attribute
    on source_attribute.attrelid = source_table.oid
   and source_attribute.attnum = source_key.attnum
  join pg_attribute target_attribute
    on target_attribute.attrelid = target_table.oid
   and target_attribute.attnum = target_key.attnum
  where constraint_row.contype = 'f'
    and source_namespace.nspname = 'public'
),
required_foreign_keys as (
  select
    count(*) filter (where a.source_table is not null) as found_count,
    coalesce(
      string_agg(e.source_table || '.' || e.source_column, ', ' order by e.source_table, e.source_column)
        filter (where a.source_table is null),
      'none'
    ) as missing
  from expected_foreign_keys e
  left join actual_foreign_keys a
    on a.source_table = e.source_table
   and a.source_column = e.source_column
   and a.target_schema = e.target_schema
   and a.target_table = e.target_table
   and a.target_column = e.target_column
),
authenticated_write_access as (
  select count(*) as access_count
  from expected_tables e
  join pg_namespace n on n.nspname = 'public'
  join pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.table_name
   and c.relkind in ('r', 'p')
  cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) privilege(privilege_name)
  where has_table_privilege(
    'authenticated',
    c.oid,
    privilege.privilege_name
  )
),
checks(check_order, check_name, passed, details) as (
  select 1, 'required_tables', found_count = 4,
    format('%s/4 present; missing: %s', found_count, missing)
  from required_tables
  union all
  select 2, 'rls_enabled', enabled_count = 4,
    format('%s/4 enabled; missing: %s', enabled_count, missing)
  from required_rls
  union all
  select 3, 'select_policies', found_count = 4,
    format('%s/4 present; missing: %s', found_count, missing)
  from required_policies
  union all
  select 4, 'anon_table_access', access_count = 0,
    format('%s effective table grants found', access_count)
  from anon_table_access
  union all
  select 5, 'is_admin_function', found_count = 1,
    format('%s matching SECURITY DEFINER function(s) found', found_count)
  from admin_function
  union all
  select 6, 'security_definer_search_path', function_count = fixed_count,
    format('%s/%s fixed; missing: %s', fixed_count, function_count, missing)
  from security_definer_functions
  union all
  select 7, 'required_indexes', found_count = 13,
    format('%s/13 present; missing: %s', found_count, missing)
  from required_indexes
  union all
  select 8, 'required_foreign_keys', found_count = 7,
    format('%s/7 present; missing: %s', found_count, missing)
  from required_foreign_keys
  union all
  select 9, 'authenticated_direct_writes', access_count = 0,
    format('%s effective write privileges found', access_count)
  from authenticated_write_access
)
select
  check_name,
  case when passed then 'PASS' else 'FAIL' end as status,
  details
from checks
order by check_order;
