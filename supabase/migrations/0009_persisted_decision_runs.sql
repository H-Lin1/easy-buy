create table public.decision_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  client_request_id uuid not null,
  input_text text not null default '',
  screenshot_path text not null,
  screenshot_mime_type text,
  profile_snapshot jsonb not null default '{}'::jsonb,
  stage_data jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  stage text not null default 'queued'
    check (stage in ('queued', 'analyzing_candidate', 'retrieving_context', 'deciding', 'decision_ready', 'generating_try_ons', 'completed')),
  user_message_id uuid references public.chat_messages(id) on delete set null,
  assistant_message_id uuid references public.chat_messages(id) on delete set null,
  candidate_id uuid references public.purchase_candidates(id) on delete set null,
  report_id uuid references public.assessment_reports(id) on delete set null,
  error_code text,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  recovery_count integer not null default 0 check (recovery_count >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_claimed_at timestamptz,
  last_heartbeat_at timestamptz,
  last_recovered_at timestamptz,
  started_at timestamptz,
  decision_ready_at timestamptz,
  finished_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint decision_runs_lease_pair_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint decision_runs_running_lease_check check (
    (status = 'running' and lease_token is not null)
    or (status <> 'running' and lease_token is null)
  )
);

alter table public.chat_messages
  add column if not exists decision_run_id uuid references public.decision_runs(id) on delete set null;

alter table public.purchase_candidates
  add column if not exists decision_run_id uuid references public.decision_runs(id) on delete set null;

alter table public.assessment_reports
  add column if not exists decision_run_id uuid references public.decision_runs(id) on delete set null;

alter table public.outfit_try_on_images
  add column if not exists decision_run_id uuid references public.decision_runs(id) on delete set null,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_attempt_started_at timestamptz,
  add column if not exists completed_at timestamptz;

alter table public.outfit_try_on_images
  drop constraint if exists outfit_try_on_images_status_check;

alter table public.outfit_try_on_images
  add constraint outfit_try_on_images_status_check
    check (status in ('pending', 'processing', 'ready', 'failed', 'cancelled')),
  add constraint outfit_try_on_images_attempt_count_check
    check (attempt_count >= 0),
  add constraint outfit_try_on_images_lease_pair_check
    check (
      (lease_token is null and lease_expires_at is null)
      or (lease_token is not null and lease_expires_at is not null)
    );

create unique index decision_runs_user_client_request_uidx
  on public.decision_runs(user_id, client_request_id);

create index decision_runs_session_created_idx
  on public.decision_runs(session_id, created_at desc);

create index decision_runs_active_user_created_idx
  on public.decision_runs(user_id, created_at)
  where status in ('queued', 'running');

create index decision_runs_queued_available_idx
  on public.decision_runs(user_id, available_at, created_at)
  where status = 'queued';

create index decision_runs_recoverable_lease_idx
  on public.decision_runs(lease_expires_at)
  where status = 'running';

create unique index chat_messages_decision_run_role_uidx
  on public.chat_messages(decision_run_id, role);

create unique index purchase_candidates_decision_run_uidx
  on public.purchase_candidates(decision_run_id);

create unique index assessment_reports_decision_run_uidx
  on public.assessment_reports(decision_run_id);

create unique index outfit_try_on_images_decision_run_outfit_uidx
  on public.outfit_try_on_images(decision_run_id, outfit_id);

create index outfit_try_on_images_recoverable_lease_idx
  on public.outfit_try_on_images(lease_expires_at)
  where status = 'processing';

alter table public.decision_runs enable row level security;
alter table public.decision_runs replica identity full;

create policy "decision runs owner read"
  on public.decision_runs
  for select
  to authenticated
  using (auth.uid() = user_id);

grant select on public.decision_runs to authenticated;
grant all on public.decision_runs to service_role;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'decision_runs'
  ) then
    alter publication supabase_realtime add table public.decision_runs;
  end if;
end
$$;

create or replace function public.claim_next_decision_run(
  p_user_id uuid,
  p_lease_seconds integer default 360
)
returns setof public.decision_runs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 360), 3600));
  v_active_count integer;
  v_run public.decision_runs%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22004';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  update public.decision_runs
  set status = 'queued',
      lease_token = null,
      lease_expires_at = null,
      available_at = v_now,
      recovery_count = recovery_count + 1,
      last_recovered_at = v_now,
      updated_at = v_now
  where user_id = p_user_id
    and status = 'running'
    and lease_expires_at <= v_now;

  select count(*)
  into v_active_count
  from public.decision_runs
  where user_id = p_user_id
    and status = 'running'
    and lease_expires_at > v_now;

  if v_active_count >= 2 then
    return;
  end if;

  select dr.*
  into v_run
  from public.decision_runs as dr
  where dr.user_id = p_user_id
    and dr.status = 'queued'
    and dr.available_at <= v_now
  order by dr.created_at, dr.id
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.decision_runs
  set status = 'running',
      lease_token = gen_random_uuid(),
      lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
      attempt_count = attempt_count + 1,
      last_claimed_at = v_now,
      last_heartbeat_at = v_now,
      started_at = coalesce(started_at, v_now),
      error_code = null,
      error_message = null,
      updated_at = v_now
  where id = v_run.id
  returning * into v_run;

  return next v_run;
end;
$$;

create or replace function public.renew_decision_run_lease(
  p_run_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 360
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_renewed boolean;
begin
  update public.decision_runs
  set lease_expires_at = v_now + make_interval(
        secs => greatest(30, least(coalesce(p_lease_seconds, 360), 3600))
      ),
      last_heartbeat_at = v_now,
      updated_at = v_now
  where id = p_run_id
    and status = 'running'
    and lease_token = p_lease_token
    and lease_expires_at > v_now
  returning true into v_renewed;

  return coalesce(v_renewed, false);
end;
$$;

create or replace function public.release_decision_run_lease(
  p_run_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_released boolean;
begin
  update public.decision_runs
  set status = 'queued',
      lease_token = null,
      lease_expires_at = null,
      available_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = p_run_id
    and status = 'running'
    and lease_token = p_lease_token
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

create or replace function public.recover_expired_decision_runs(
  p_limit integer default 100
)
returns table(decision_run_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  return query
  with expired as (
    select dr.id
    from public.decision_runs as dr
    where dr.status = 'running'
      and dr.lease_expires_at <= v_now
    order by dr.lease_expires_at, dr.id
    for update skip locked
    limit greatest(coalesce(p_limit, 100), 0)
  ),
  recovered as (
    update public.decision_runs as dr
    set status = 'queued',
        lease_token = null,
        lease_expires_at = null,
        available_at = v_now,
        recovery_count = dr.recovery_count + 1,
        last_recovered_at = v_now,
        updated_at = v_now
    where dr.id in (select expired.id from expired)
    returning dr.id, dr.user_id
  )
  select recovered.id, recovered.user_id
  from recovered;
end;
$$;

create or replace function public.recover_expired_outfit_try_on_images(
  p_limit integer default 100
)
returns table(image_id uuid, decision_run_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  return query
  with expired as (
    select image.id
    from public.outfit_try_on_images as image
    join public.decision_runs as run on run.id = image.decision_run_id
    where image.status = 'processing'
      and image.lease_expires_at <= v_now
      and run.status in ('queued', 'running')
    order by image.lease_expires_at, image.id
    for update of image skip locked
    limit greatest(coalesce(p_limit, 100), 0)
  ),
  recovered as (
    update public.outfit_try_on_images as image
    set status = 'pending',
        lease_token = null,
        lease_expires_at = null,
        updated_at = v_now
    where image.id in (select expired.id from expired)
    returning image.id, image.decision_run_id, image.user_id
  )
  select recovered.id, recovered.decision_run_id, recovered.user_id
  from recovered;
end;
$$;

create or replace function public.cancel_decision_runs_for_session(
  p_user_id uuid,
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_run_ids uuid[];
begin
  if p_user_id is null or p_session_id is null then
    raise exception 'p_user_id and p_session_id are required' using errcode = '22004';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  with cancelled as (
    update public.decision_runs as dr
    set status = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        cancelled_at = v_now,
        finished_at = v_now,
        updated_at = v_now
    where dr.user_id = p_user_id
      and dr.session_id = p_session_id
      and dr.status in ('queued', 'running')
    returning dr.id
  )
  select coalesce(array_agg(cancelled.id), '{}'::uuid[])
  into v_run_ids
  from cancelled;

  update public.outfit_try_on_images as image
  set status = 'cancelled',
      failure_kind = 'run_cancelled',
      lease_token = null,
      lease_expires_at = null,
      completed_at = coalesce(image.completed_at, v_now),
      updated_at = v_now
  where image.decision_run_id = any(v_run_ids)
    and image.status in ('pending', 'processing');

  return cardinality(v_run_ids);
end;
$$;

create or replace function public.archive_chat_session_with_decision_runs(
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_archived_count integer;
begin
  if p_user_id is null or p_session_id is null then
    raise exception 'p_user_id and p_session_id are required' using errcode = '22004';
  end if;

  perform public.cancel_decision_runs_for_session(p_user_id, p_session_id);

  delete from public.decision_items
  where user_id = p_user_id
    and session_id = p_session_id;

  update public.chat_sessions
  set status = 'archived',
      updated_at = clock_timestamp()
  where id = p_session_id
    and user_id = p_user_id;

  get diagnostics v_archived_count = row_count;
  return v_archived_count > 0;
end;
$$;

revoke all on function public.claim_next_decision_run(uuid, integer) from public;
revoke all on function public.renew_decision_run_lease(uuid, uuid, integer) from public;
revoke all on function public.release_decision_run_lease(uuid, uuid) from public;
revoke all on function public.recover_expired_decision_runs(integer) from public;
revoke all on function public.recover_expired_outfit_try_on_images(integer) from public;
revoke all on function public.cancel_decision_runs_for_session(uuid, uuid) from public;
revoke all on function public.archive_chat_session_with_decision_runs(uuid, uuid) from public;

grant execute on function public.claim_next_decision_run(uuid, integer) to service_role;
grant execute on function public.renew_decision_run_lease(uuid, uuid, integer) to service_role;
grant execute on function public.release_decision_run_lease(uuid, uuid) to service_role;
grant execute on function public.recover_expired_decision_runs(integer) to service_role;
grant execute on function public.recover_expired_outfit_try_on_images(integer) to service_role;
grant execute on function public.cancel_decision_runs_for_session(uuid, uuid) to service_role;
grant execute on function public.archive_chat_session_with_decision_runs(uuid, uuid) to service_role;
