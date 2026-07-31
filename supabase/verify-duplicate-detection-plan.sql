-- Live verification for the Secure Contact Boundary duplicate-detection contract.
-- Seeds a realistic player volume, proves each contact channel is matched through its expression index
-- instead of a sequential scan, and proves masked display never disagrees with the has_* presence flags.
-- Runs entirely inside a transaction that is rolled back, so it persists no data.
--
--   docker exec -i <db container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/verify-duplicate-detection-plan.sql

begin;

insert into public.players (id, phone, email, messenger, status, imported_at)
select
  'PLAN_VERIFY_' || g,
  '+5917' || lpad(g::text, 7, '0'),
  'plan_verify_' || g || '@example.invalid',
  'PLAN_VERIFY:' || g,
  'new',
  now()
from generate_series(1, 5000) g;

analyze public.players;

do $$
declare
  v_plan text;
  v_channels text[][] := array[
    array['phone',     'players_phone_normalized_idx',     'regexp_replace(p.phone, ''[^0-9+]'', '''', ''g'') = c.value and nullif(trim(p.phone), '''') is not null'],
    array['email',     'players_email_normalized_idx',     'lower(trim(p.email)) = c.value and nullif(trim(p.email), '''') is not null'],
    array['messenger', 'players_messenger_normalized_idx', 'lower(trim(p.messenger)) = c.value and nullif(trim(p.messenger), '''') is not null']
  ];
  v_probe text[] := array['+59170000042', 'plan_verify_42@example.invalid', 'plan_verify:42'];
  r record;
  i integer;
begin
  for i in 1 .. array_length(v_channels, 1) loop
    v_plan := '';
    for r in execute format(
      'explain (analyze, costs off, timing off, summary off) '
      || 'with c as (select %L::text as value) select p.id from c join public.players p on %s',
      v_probe[i], v_channels[i][3]
    ) loop
      v_plan := v_plan || r."QUERY PLAN" || E'\n';
    end loop;

    if position(v_channels[i][2] in v_plan) = 0 then
      raise exception E'INDEX_NOT_USED for % (expected %)\n%', v_channels[i][1], v_channels[i][2], v_plan;
    end if;
    if position('Seq Scan on players' in v_plan) > 0 then
      raise exception E'SEQUENTIAL_SCAN_REGRESSION for %\n%', v_channels[i][1], v_plan;
    end if;
    raise notice 'plan ok: % uses %', v_channels[i][1], v_channels[i][2];
  end loop;
end $$;

-- The complete matching query body as executed inside check_player_duplicates, over a 200-candidate
-- batch against 5000 stored players. The RPC's authorization path is covered separately by the runtime
-- harness, which calls it as a signed-in admin; here we prove only the plan shape.
do $$
declare
  v_candidates jsonb;
  v_plan text := '';
  v_scans integer;
  r record;
begin
  select jsonb_agg(jsonb_build_object('phone', '+5917' || lpad(g::text, 7, '0')))
    into v_candidates from generate_series(1, 200) g;

  for r in execute format($q$
    explain (analyze, costs off, timing off, summary off)
    with candidates as (
      select (e.ordinality - 1)::integer as row_index,
        nullif(trim(coalesce(e.value->>'id','')), '')                                 as cand_id,
        nullif(regexp_replace(coalesce(e.value->>'phone',''), '[^0-9+]', '', 'g'), '') as cand_phone,
        nullif(lower(trim(coalesce(e.value->>'email',''))), '')                        as cand_email,
        nullif(lower(trim(coalesce(e.value->>'messenger',''))), '')                    as cand_messenger
      from jsonb_array_elements(%L::jsonb) with ordinality as e(value, ordinality)
    ),
    matches as (
      select c.row_index, p.id as player_id, 1 as priority, 'id' as field
        from candidates c join public.players p on p.id = c.cand_id where c.cand_id is not null
      union all
      select c.row_index, p.id, 2, 'phone' from candidates c join public.players p
        on regexp_replace(p.phone, '[^0-9+]', '', 'g') = c.cand_phone
       and nullif(trim(p.phone), '') is not null where c.cand_phone is not null
      union all
      select c.row_index, p.id, 3, 'email' from candidates c join public.players p
        on lower(trim(p.email)) = c.cand_email
       and nullif(trim(p.email), '') is not null where c.cand_email is not null
      union all
      select c.row_index, p.id, 4, 'messenger' from candidates c join public.players p
        on lower(trim(p.messenger)) = c.cand_messenger
       and nullif(trim(p.messenger), '') is not null where c.cand_messenger is not null
    ),
    ranked as (
      select distinct on (m.row_index) m.row_index, m.player_id
        from matches m order by m.row_index, m.priority, m.player_id
    ),
    resolved as (
      select r2.row_index, r2.player_id, array_agg(m.field order by m.priority) as field_list
        from ranked r2 join matches m on m.row_index = r2.row_index and m.player_id = r2.player_id
       group by r2.row_index, r2.player_id
    )
    select c.row_index, resolved.player_id is not null, resolved.player_id,
           coalesce(resolved.field_list, array[]::text[])
      from candidates c left join resolved on resolved.row_index = c.row_index
     order by c.row_index
  $q$, v_candidates) loop
    v_plan := v_plan || r."QUERY PLAN" || E'\n';
  end loop;

  -- The guarantee that matters is that work does not grow with batch size. The old implementation
  -- scanned players once per candidate; this one touches players a bounded number of times (at most one
  -- access per contact channel) no matter how many candidates are submitted. Whether each access is an
  -- index lookup or a single hash-join scan is the planner's cost decision, and at small table sizes a
  -- single scan is legitimately cheaper than many index probes.
  select coalesce((select count(*) from regexp_matches(v_plan, 'Scan on players', 'g')), 0) into v_scans;
  if v_scans > 4 then
    raise exception E'PER_CANDIDATE_SCAN_REGRESSION: % players accesses for a 200 candidate batch\n%', v_scans, v_plan;
  end if;
  raise notice 'full contract plan touches players % time(s) for 200 candidates', v_scans;
end $$;

-- Same query at two batch sizes: the number of players accesses must not grow with candidate count.
do $$
declare
  v_small integer; v_large integer; v_plan text; r record; v_size integer; v_candidates jsonb;
begin
  foreach v_size in array array[10, 500] loop
    select jsonb_agg(jsonb_build_object('phone', '+5917' || lpad(g::text, 7, '0')))
      into v_candidates from generate_series(1, v_size) g;
    v_plan := '';
    for r in execute format($q$
      explain (costs off)
      with candidates as (
        select nullif(regexp_replace(coalesce(e.value->>'phone',''), '[^0-9+]', '', 'g'), '') as cand_phone
        from jsonb_array_elements(%L::jsonb) as e(value)
      )
      select p.id from candidates c join public.players p
        on regexp_replace(p.phone, '[^0-9+]', '', 'g') = c.cand_phone
       and nullif(trim(p.phone), '') is not null
       where c.cand_phone is not null
    $q$, v_candidates) loop
      v_plan := v_plan || r."QUERY PLAN" || E'\n';
    end loop;
    if v_size = 10 then
      select coalesce((select count(*) from regexp_matches(v_plan, 'Scan on players', 'g')), 0) into v_small;
    else
      select coalesce((select count(*) from regexp_matches(v_plan, 'Scan on players', 'g')), 0) into v_large;
    end if;
  end loop;

  if v_large > v_small then
    raise exception 'SCAN_COUNT_GREW_WITH_BATCH: 10 candidates=% accesses, 500 candidates=% accesses', v_small, v_large;
  end if;
  raise notice 'players accesses independent of batch size (10 -> %, 500 -> %)', v_small, v_large;
end $$;

-- Masked display and presence flag must agree for every shape of input, including invalid and Unicode.
do $$
declare r record; v_failures text := '';
begin
  for r in
    select *
    from (values
      (null,             'null'),
      ('',               'empty string'),
      ('   ',            'whitespace only'),
      ('abc',            'alphabetic only'),
      ('+',              'plus with no digits'),
      ('телефон',        'unicode alphabetic'),
      ('☎☎☎',            'unicode symbols'),
      ('123',            'short numeric'),
      ('+1-800-FLOWERS', 'mixed invalid characters'),
      ('+59171234567',   'leading plus valid'),
      ('(591) 7123 4567','formatted valid')
    ) t(value, label)
  loop
    declare
      v_display text := public.mask_contact_phone(r.value);
      v_present boolean := public.normalize_contact_phone(r.value) is not null;
    begin
      if v_present <> (v_display is not null) then
        v_failures := v_failures || format(E'  %s (%L): has_phone=%s display=%L\n', r.label, r.value, v_present, v_display);
      end if;
      if v_display is not null and v_display !~ '^\*+([0-9]{4})?$' and v_display <> '***' then
        v_failures := v_failures || format(E'  %s (%L): unexpected mask shape %L\n', r.label, r.value, v_display);
      end if;
      if v_display is not null and length(regexp_replace(v_display, '[^0-9]', '', 'g')) > 4 then
        v_failures := v_failures || format(E'  %s (%L): mask exposes more than 4 digits: %L\n', r.label, r.value, v_display);
      end if;
    end;
  end loop;
  if v_failures <> '' then raise exception E'PHONE_DISPLAY_INCONSISTENCY\n%', v_failures; end if;
  raise notice 'phone masking consistent across all cases';
end $$;

rollback;
