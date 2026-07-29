begin;

do $$ begin
  create type public.user_role as enum ('admin', 'agent');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.user_language as enum ('ru', 'en', 'es');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.player_status as enum ('new', 'assigned', 'in_work', 'no_answer', 'success', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (char_length(trim(username)) between 2 and 50),
  name text not null check (char_length(trim(name)) between 1 and 100),
  role public.user_role not null default 'agent',
  lang public.user_language not null default 'ru',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.players (
  id text primary key,
  phone text not null default '',
  email text not null default '',
  messenger text not null default '',
  status public.player_status not null default 'new',
  agent_id uuid references public.profiles(id) on delete set null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  follow_up_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  constraint players_has_contact check (nullif(trim(phone), '') is not null or nullif(trim(email), '') is not null or nullif(trim(messenger), '') is not null)
);

create table if not exists public.player_comments (
  id text primary key,
  player_id text not null references public.players(id) on delete cascade,
  text text not null check (char_length(trim(text)) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  author_id uuid references public.profiles(id) on delete set null,
  author_name text not null default '',
  author_role public.user_role not null default 'agent'
);

create table if not exists public.player_status_history (
  id text primary key,
  player_id text not null references public.players(id) on delete cascade,
  from_status public.player_status,
  to_status public.player_status not null,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid references public.profiles(id) on delete set null,
  user_name text not null default '',
  user_role public.user_role not null default 'agent'
);

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_active_idx on public.profiles(is_active);
create index if not exists players_agent_id_idx on public.players(agent_id);
create index if not exists players_status_idx on public.players(status);
create index if not exists players_updated_at_idx on public.players(updated_at desc);
create index if not exists players_follow_up_at_idx on public.players(follow_up_at) where follow_up_at is not null;
create index if not exists players_phone_normalized_idx on public.players((regexp_replace(phone, '[^0-9+]', '', 'g'))) where nullif(trim(phone), '') is not null;
create index if not exists players_email_normalized_idx on public.players((lower(trim(email)))) where nullif(trim(email), '') is not null;
create index if not exists players_messenger_normalized_idx on public.players((lower(trim(messenger)))) where nullif(trim(messenger), '') is not null;
create index if not exists player_comments_player_idx on public.player_comments(player_id, created_at desc);
create index if not exists player_comments_author_idx on public.player_comments(author_id);
create index if not exists player_status_history_player_idx on public.player_status_history(player_id, changed_at desc);
create index if not exists player_status_history_user_idx on public.player_status_history(user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists players_set_updated_at on public.players;
create trigger players_set_updated_at before update on public.players for each row execute function public.set_updated_at();
drop trigger if exists player_comments_set_updated_at on public.player_comments;
create trigger player_comments_set_updated_at before update on public.player_comments for each row execute function public.set_updated_at();
drop trigger if exists player_status_history_set_updated_at on public.player_status_history;
create trigger player_status_history_set_updated_at before update on public.player_status_history for each row execute function public.set_updated_at();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and is_active); $$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

alter table public.profiles enable row level security;
alter table public.players enable row level security;
alter table public.player_comments enable row level security;
alter table public.player_status_history enable row level security;

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin on public.profiles for select to authenticated
using (auth.uid() is not null and (id = auth.uid() or public.is_admin()));

drop policy if exists players_select_admin_or_assigned on public.players;
create policy players_select_admin_or_assigned on public.players for select to authenticated
using (auth.uid() is not null and (public.is_admin() or agent_id = auth.uid()));

drop policy if exists comments_select_admin_or_assigned on public.player_comments;
create policy comments_select_admin_or_assigned on public.player_comments for select to authenticated
using (public.is_admin() or exists (select 1 from public.players p where p.id = player_id and p.agent_id = auth.uid()));

drop policy if exists history_select_admin_or_assigned on public.player_status_history;
create policy history_select_admin_or_assigned on public.player_status_history for select to authenticated
using (public.is_admin() or exists (select 1 from public.players p where p.id = player_id and p.agent_id = auth.uid()));

revoke all on public.profiles, public.players, public.player_comments, public.player_status_history from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.profiles, public.players, public.player_comments, public.player_status_history from authenticated;
grant select on public.profiles, public.players, public.player_comments, public.player_status_history to authenticated;

commit;
