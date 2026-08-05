-- Mandatory closing proof for a lead.
--
-- Design notes that are load-bearing, not commentary:
--
-- * The storage path is generated entirely by the server from two UUIDs and a
--   whitelisted extension. The client never proposes a path, so traversal,
--   bucket substitution, and collisions are impossible by construction rather
--   than by sanitisation.
-- * `lead_proofs.storage_path` is unique and is the join key used by every
--   `storage.objects` policy. A storage object is therefore reachable only
--   through a proof row that already encodes the lead, the uploader, and the
--   lifecycle state.
-- * A proof only counts once the server has re-read the object's real size and
--   MIME type out of `storage.objects.metadata`. Client-declared values are
--   recorded for display, never trusted for authorisation.
-- * `change_player_status_atomic` takes the proof row FOR UPDATE inside the same
--   transaction as the status write, so a proof cannot be discarded in the
--   window between the check and the close.
begin;

do $$ begin
  create type public.lead_proof_state as enum ('pending', 'active', 'discarded');
exception when duplicate_object then null; end $$;

create table if not exists public.lead_proofs (
  id uuid primary key,
  player_id text not null references public.players(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  storage_bucket text not null default 'lead-proofs'
    check (storage_bucket = 'lead-proofs'),
  storage_path text not null unique
    check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'),
  original_filename text not null default ''
    check (char_length(original_filename) <= 200),
  mime_type text not null
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  declared_file_size bigint not null
    check (declared_file_size between 1 and 10485760),
  verified_file_size bigint
    check (verified_file_size is null or verified_file_size between 1 and 10485760),
  state public.lead_proof_state not null default 'pending',
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  discarded_at timestamptz,
  constraint lead_proofs_active_is_verified
    check (state <> 'active' or (confirmed_at is not null and verified_file_size is not null)),
  constraint lead_proofs_discarded_has_timestamp
    check (state <> 'discarded' or discarded_at is not null)
);

-- One active proof per lead. Superseding a proof discards the previous row first,
-- so this index is the structural guarantee behind the replacement policy.
create unique index if not exists lead_proofs_one_active_per_player_idx
  on public.lead_proofs(player_id) where state = 'active';
create index if not exists lead_proofs_player_idx on public.lead_proofs(player_id, created_at desc);
create index if not exists lead_proofs_uploader_idx on public.lead_proofs(uploaded_by, created_at desc);

comment on table public.lead_proofs is
  'Closing evidence for a lead. Rows are created only by request_lead_proof_upload and are the sole authorisation source for lead-proofs storage objects.';

alter table public.lead_proofs enable row level security;

drop policy if exists lead_proofs_select_admin_or_assigned on public.lead_proofs;
create policy lead_proofs_select_admin_or_assigned on public.lead_proofs for select to authenticated
using (
  auth.uid() is not null
  and (
    public.is_admin()
    or exists (select 1 from public.players p where p.id = player_id and p.agent_id = auth.uid())
  )
);

revoke all on public.lead_proofs from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.lead_proofs from authenticated;
grant select on public.lead_proofs to authenticated;

-- The private bucket. `public = false` means no unsigned URL can ever resolve;
-- every read goes through an authenticated request or a short-lived signed URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lead-proofs', 'lead-proofs', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

-- Storage policies. Each one resolves the object name back to its proof row, so
-- a caller can only touch bytes that a server-issued proof already granted them.
drop policy if exists lead_proofs_objects_insert_own_pending on storage.objects;
create policy lead_proofs_objects_insert_own_pending on storage.objects for insert to authenticated
with check (
  bucket_id = 'lead-proofs'
  and exists (
    select 1 from public.lead_proofs lp
    where lp.storage_path = storage.objects.name
      and lp.uploaded_by = auth.uid()
      and lp.state = 'pending'
  )
);

drop policy if exists lead_proofs_objects_select_admin_or_assigned on storage.objects;
create policy lead_proofs_objects_select_admin_or_assigned on storage.objects for select to authenticated
using (
  bucket_id = 'lead-proofs'
  and exists (
    select 1 from public.lead_proofs lp
    join public.players p on p.id = lp.player_id
    where lp.storage_path = storage.objects.name
      and lp.state <> 'discarded'
      and (public.is_admin() or p.agent_id = auth.uid())
  )
);

-- Overwriting is allowed only while the uploader's own proof is still pending,
-- which covers a retried upload. A confirmed proof's bytes are immutable.
drop policy if exists lead_proofs_objects_update_own_pending on storage.objects;
create policy lead_proofs_objects_update_own_pending on storage.objects for update to authenticated
using (
  bucket_id = 'lead-proofs'
  and exists (
    select 1 from public.lead_proofs lp
    where lp.storage_path = storage.objects.name
      and lp.uploaded_by = auth.uid()
      and lp.state = 'pending'
  )
)
with check (
  bucket_id = 'lead-proofs'
  and exists (
    select 1 from public.lead_proofs lp
    where lp.storage_path = storage.objects.name
      and lp.uploaded_by = auth.uid()
      and lp.state = 'pending'
  )
);

drop policy if exists lead_proofs_objects_delete_own_discarded on storage.objects;
create policy lead_proofs_objects_delete_own_discarded on storage.objects for delete to authenticated
using (
  bucket_id = 'lead-proofs'
  and exists (
    select 1 from public.lead_proofs lp
    where lp.storage_path = storage.objects.name
      and lp.uploaded_by = auth.uid()
      and lp.state in ('pending', 'discarded')
  )
);

-- Resolves the caller against a lead once, for every proof operation.
-- Returns the player row; raises the project's standard codes otherwise.
create or replace function public.proof_authorize_player(p_player_id text, p_lock boolean)
returns public.players
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_player public.players;
begin
  v_actor := public.require_active_profile();
  if p_lock then
    select * into v_player from public.players where id = p_player_id for update;
  else
    select * into v_player from public.players where id = p_player_id;
  end if;
  if not found then raise exception using errcode = 'P0002', message = 'PLAYER_NOT_FOUND'; end if;
  if v_actor.role <> 'admin' and v_player.agent_id is distinct from v_actor.id then
    raise exception using errcode = '42501', message = 'PROOF_ACCESS_DENIED';
  end if;
  return v_player;
end $$;

create or replace function public.request_lead_proof_upload(
  p_player_id text, p_proof_id uuid, p_filename text, p_mime_type text, p_file_size bigint
)
returns public.lead_proofs
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles; v_player public.players; v_proof public.lead_proofs;
  v_extension text; v_filename text;
begin
  v_actor := public.require_active_profile();
  v_player := public.proof_authorize_player(p_player_id, true);

  -- Proof belongs to the working phase. Refusing any other status keeps a proof
  -- from being attached to an already-closed lead, which is what makes the
  -- "no replacement after closing" rule structural rather than advisory.
  if v_player.status <> 'in_work' then
    raise exception using errcode = '22023', message = 'PROOF_LEAD_NOT_IN_WORK';
  end if;
  if p_proof_id is null then
    raise exception using errcode = '22023', message = 'PROOF_ID_REQUIRED';
  end if;
  if exists (select 1 from public.lead_proofs where id = p_proof_id) then
    raise exception using errcode = '23505', message = 'PROOF_ID_CONFLICT';
  end if;

  v_extension := case p_mime_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'application/pdf' then 'pdf'
    else null end;
  if v_extension is null then
    raise exception using errcode = '22023', message = 'INVALID_FILE_TYPE';
  end if;
  if p_file_size is null or p_file_size < 1 or p_file_size > 10485760 then
    raise exception using errcode = '22023', message = 'FILE_TOO_LARGE';
  end if;

  -- The original name is display metadata only. It never reaches the path, but
  -- it is still stripped of separators and control characters before storage.
  v_filename := left(regexp_replace(coalesce(p_filename, ''), '[[:cntrl:]/\\]', '', 'g'), 200);

  insert into public.lead_proofs(
    id, player_id, uploaded_by, storage_bucket, storage_path,
    original_filename, mime_type, declared_file_size, state
  )
  values (
    p_proof_id, v_player.id, v_actor.id, 'lead-proofs',
    v_actor.id::text || '/' || p_proof_id::text || '.' || v_extension,
    v_filename, p_mime_type, p_file_size, 'pending'
  )
  returning * into v_proof;

  return v_proof;
end $$;

create or replace function public.confirm_lead_proof(p_proof_id uuid)
returns public.lead_proofs
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.profiles; v_proof public.lead_proofs; v_player public.players;
  v_metadata jsonb; v_size bigint; v_mime text;
begin
  v_actor := public.require_active_profile();
  select * into v_proof from public.lead_proofs where id = p_proof_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'PROOF_NOT_FOUND'; end if;
  if v_proof.uploaded_by <> v_actor.id then
    raise exception using errcode = '42501', message = 'PROOF_ACCESS_DENIED';
  end if;
  if v_proof.state = 'active' then return v_proof; end if;
  if v_proof.state = 'discarded' then
    raise exception using errcode = '22023', message = 'PROOF_DISCARDED';
  end if;

  v_player := public.proof_authorize_player(v_proof.player_id, true);
  if v_player.status <> 'in_work' then
    raise exception using errcode = '22023', message = 'PROOF_LEAD_NOT_IN_WORK';
  end if;

  -- Server-side verification: the object must exist, and its real size and MIME
  -- type come from storage, not from the caller.
  select o.metadata into v_metadata
  from storage.objects o
  where o.bucket_id = v_proof.storage_bucket and o.name = v_proof.storage_path;
  if not found then
    raise exception using errcode = '22023', message = 'PROOF_NOT_READY';
  end if;

  v_size := nullif(v_metadata->>'size', '')::bigint;
  v_mime := nullif(v_metadata->>'mimetype', '');
  if v_size is null or v_size < 1 then
    raise exception using errcode = '22023', message = 'PROOF_NOT_READY';
  end if;
  if v_size > 10485760 then
    raise exception using errcode = '22023', message = 'FILE_TOO_LARGE';
  end if;
  if v_mime is null or v_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
     or v_mime <> v_proof.mime_type then
    raise exception using errcode = '22023', message = 'INVALID_FILE_TYPE';
  end if;

  -- Replacement: the previous active proof for this lead is discarded in the
  -- same transaction, so the partial unique index can never see two active rows
  -- and no stale proof can authorise a later close.
  update public.lead_proofs
     set state = 'discarded', discarded_at = now()
   where player_id = v_proof.player_id and state = 'active' and id <> v_proof.id;

  -- The proof row is its own audit record: uploaded_by is the actor, created_at
  -- is the upload, confirmed_at the confirmation, discarded_at a replacement or
  -- deletion. Rows are never removed, only discarded, and the closing event
  -- itself is already recorded in player_status_history. No separate event
  -- table is introduced.
  update public.lead_proofs
     set state = 'active', confirmed_at = now(), verified_file_size = v_size
   where id = v_proof.id
  returning * into v_proof;

  return v_proof;
end $$;

create or replace function public.discard_lead_proof(p_proof_id uuid)
returns public.lead_proofs
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_proof public.lead_proofs; v_player public.players;
begin
  v_actor := public.require_active_profile();
  select * into v_proof from public.lead_proofs where id = p_proof_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'PROOF_NOT_FOUND'; end if;
  if v_proof.uploaded_by <> v_actor.id then
    raise exception using errcode = '42501', message = 'PROOF_ACCESS_DENIED';
  end if;
  if v_proof.state = 'discarded' then return v_proof; end if;

  select * into v_player from public.players where id = v_proof.player_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'PLAYER_NOT_FOUND'; end if;
  -- Once the lead is closed its evidence is immutable.
  if v_player.status in ('success', 'failed') then
    raise exception using errcode = '42501', message = 'PROOF_LOCKED_AFTER_CLOSE';
  end if;

  update public.lead_proofs set state = 'discarded', discarded_at = now()
   where id = v_proof.id returning * into v_proof;
  return v_proof;
end $$;

-- Replaces the transition function as it stands after the secure contact
-- projection (20260801000100): it returns public.players_secure, never the raw
-- players row. That masked return type is preserved exactly. The only
-- behavioural change is the proof gate on the two closing transitions; every
-- other rule is carried over verbatim so the current runtime suites keep their
-- meaning.
create or replace function public.change_player_status_atomic(p_player_id text, p_next_status public.player_status, p_history_id text, p_confirm_reopen boolean default false)
returns public.players_secure
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.profiles; v_player public.players; v_from public.player_status; v_allowed boolean; v_secure public.players_secure; v_proof_id uuid;
begin
  v_actor:=public.require_active_profile(); select * into v_player from public.players where id=p_player_id for update;
  if not found then raise exception using errcode='P0002',message='PLAYER_NOT_FOUND'; end if; v_from:=v_player.status;
  if v_actor.role<>'admin' and v_player.agent_id is distinct from v_actor.id then raise exception using errcode='42501',message='NOT_OWNER'; end if;
  v_allowed:=(v_from='new' and p_next_status='assigned') or (v_from='assigned' and p_next_status='in_work') or (v_from='in_work' and p_next_status in ('success','no_answer','failed')) or (v_from='no_answer' and p_next_status='assigned') or (v_from in ('success','failed') and p_next_status='in_work');
  if not v_allowed then raise exception using errcode='22023',message='INVALID_STATUS_TRANSITION'; end if;
  if v_actor.role<>'admin' and v_from in ('new','success','failed') then raise exception using errcode='42501',message='ROLE_FORBIDDEN'; end if;
  if v_from in ('success','failed') and not p_confirm_reopen then raise exception using errcode='42501',message='CONFIRMATION_REQUIRED'; end if;
  if nullif(trim(p_history_id),'') is null then raise exception using errcode='22023',message='HISTORY_ID_REQUIRED'; end if;

  -- Closing a lead requires evidence. The proof row is locked in this same
  -- transaction, so a concurrent discard cannot slip between check and write.
  if p_next_status in ('success','failed') then
    select id into v_proof_id from public.lead_proofs
     where player_id = p_player_id and state = 'active'
     for update;
    if v_proof_id is null then
      raise exception using errcode='42501',message='PROOF_REQUIRED';
    end if;
  end if;

  update public.players set status=p_next_status where id=p_player_id;
  insert into public.player_status_history(id,player_id,from_status,to_status,user_id,user_name,user_role) values(p_history_id,p_player_id,v_from,p_next_status,v_actor.id,v_actor.name,v_actor.role);
  select ps.* into v_secure from public.players_secure ps where ps.id=p_player_id;
  return v_secure;
end $$;

revoke all on function public.proof_authorize_player(text, boolean) from public, anon, authenticated;
revoke all on function
  public.request_lead_proof_upload(text, uuid, text, text, bigint),
  public.confirm_lead_proof(uuid),
  public.discard_lead_proof(uuid)
  from public, anon;
grant execute on function
  public.request_lead_proof_upload(text, uuid, text, text, bigint),
  public.confirm_lead_proof(uuid),
  public.discard_lead_proof(uuid)
  to authenticated;

commit;
