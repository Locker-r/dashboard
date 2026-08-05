-- Rollback for 20260805000200_agent_management.sql.
--
-- Removes the country column and the two new team primitives, and restores
-- team_list_members and the audit action allowlist to their prior shape.
--
-- Data note: dropping profiles.country discards every recorded country. Export
-- it first if the environment holds anything worth keeping.
begin;

-- Remove country audit rows before narrowing the allowlist, otherwise the
-- restored CHECK constraint cannot validate.
delete from public.admin_audit_events where action = 'update_member_country';

alter table public.admin_audit_events drop constraint if exists admin_audit_events_action_check;
alter table public.admin_audit_events add constraint admin_audit_events_action_check
  check (action in ('invite_member','update_member_role','set_member_active','reassign_players'));

drop function if exists public.team_update_member_country(uuid, uuid, text, uuid);
drop function if exists public.team_register_member(uuid, uuid, text, text, text, uuid);

drop function if exists public.team_list_members(uuid);
create function public.team_list_members(p_actor_id uuid)
returns table(id uuid, username text, name text, role public.user_role, lang public.user_language,
              is_active boolean, created_at timestamptz, updated_at timestamptz, assigned_players bigint)
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.require_team_admin(p_actor_id);
  return query
    select pr.id, pr.username, pr.name, pr.role, pr.lang, pr.is_active, pr.created_at, pr.updated_at,
      count(pl.id)::bigint
    from public.profiles pr
    left join public.players pl on pl.agent_id = pr.id
    group by pr.id
    order by lower(pr.name), pr.id;
end $$;

revoke all on function public.team_list_members(uuid) from public, anon, authenticated;
grant execute on function public.team_list_members(uuid) to service_role;

drop index if exists public.profiles_country_idx;
alter table public.profiles drop constraint if exists profiles_country_format;
alter table public.profiles drop column if exists country;

commit;
