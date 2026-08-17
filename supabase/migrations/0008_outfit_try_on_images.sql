create table if not exists public.outfit_try_on_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  report_id uuid not null references public.assessment_reports(id) on delete cascade,
  outfit_id text not null,
  position smallint not null check (position between 0 and 2),
  closet_item_ids uuid[] not null default '{}',
  image_path text,
  status text not null check (status in ('pending', 'processing', 'ready', 'failed')) default 'pending',
  model text,
  prompt_version text,
  failure_kind text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(report_id, outfit_id)
);

create index if not exists outfit_try_on_images_report_position_idx
  on public.outfit_try_on_images(report_id, position);

create index if not exists outfit_try_on_images_user_id_idx
  on public.outfit_try_on_images(user_id);

alter table public.outfit_try_on_images enable row level security;

create policy "outfit try-on owner access"
  on public.outfit_try_on_images
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
