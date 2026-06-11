create extension if not exists vector;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  height_cm numeric,
  weight_kg numeric,
  bmi numeric,
  bmi_band text check (bmi_band in ('underweight', 'normal', 'overweight', 'obese')),
  gender_preference text check (gender_preference in ('womenswear', 'menswear', 'unisex', 'no_preference')),
  style_preferences text[] default '{}',
  disliked_categories text[] default '{}',
  common_scenarios text[] default '{}',
  budget_sensitivity text check (budget_sensitivity in ('low', 'medium', 'high')) default 'medium',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.closet_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  image_path text not null,
  category text not null,
  color text,
  secondary_colors text[] default '{}',
  fit text check (fit in ('slim', 'regular', 'oversized', 'unknown')) default 'unknown',
  style_tags text[] default '{}',
  season text[] default '{}',
  formality int check (formality between 1 and 5),
  scenario_tags text[] default '{}',
  wear_frequency text check (wear_frequency in ('often', 'sometimes', 'rarely', 'unknown')) default 'unknown',
  status text check (status in ('active', 'idle', 'archived')) default 'active',
  summary text,
  embedding_text text,
  embedding vector(1024),
  ai_confidence numeric,
  user_corrected boolean default false,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  status text check (status in ('active', 'archived')) default 'active',
  last_candidate_id uuid,
  last_report_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text check (role in ('user', 'assistant', 'system')) not null,
  content text,
  image_path text,
  candidate_id uuid,
  report_id uuid,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.purchase_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.chat_sessions(id) on delete set null,
  screenshot_path text not null,
  user_intent text,
  category text,
  color text,
  secondary_colors text[] default '{}',
  fit text check (fit in ('slim', 'regular', 'oversized', 'unknown')) default 'unknown',
  style_tags text[] default '{}',
  estimated_price numeric,
  detected_text text,
  selling_points text[] default '{}',
  possible_scenarios text[] default '{}',
  summary text,
  embedding_text text,
  embedding vector(1024),
  ai_confidence numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.fashion_knowledge (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  tags text[] default '{}',
  content text not null,
  source_type text check (source_type in ('builtin', 'external_placeholder')) default 'builtin',
  embedding_text text,
  embedding vector(1024),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.assessment_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.chat_sessions(id) on delete set null,
  candidate_id uuid not null references public.purchase_candidates(id) on delete cascade,
  decision text check (decision in ('buy', 'save', 'skip')) not null,
  decision_label text not null,
  scores jsonb not null,
  summary text not null,
  styling_inspirations text[] default '{}',
  reasons_to_buy text[] default '{}',
  reasons_to_save text[] default '{}',
  risks text[] default '{}',
  body_fit_notes text[] default '{}',
  outfit_combinations jsonb default '[]'::jsonb,
  alternatives_from_closet uuid[] default '{}',
  retrieved_context jsonb default '{}'::jsonb,
  safety_checked boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.decision_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null references public.purchase_candidates(id) on delete cascade,
  report_id uuid references public.assessment_reports(id) on delete set null,
  session_id uuid references public.chat_sessions(id) on delete set null,
  status text check (status in ('decided_to_buy', 'saved_for_later', 'not_considering')) not null,
  snapshot_summary text,
  snapshot_outfit_tips text[] default '{}',
  snapshot_risks text[] default '{}',
  reminder_at timestamptz,
  last_reviewed_at timestamptz,
  final_reflection text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, candidate_id)
);

create table if not exists public.feedback_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  report_id uuid references public.assessment_reports(id) on delete cascade,
  event_type text not null,
  rating int check (rating between 1 and 5),
  comment text,
  created_at timestamptz default now()
);

create index if not exists closet_items_user_id_idx on public.closet_items(user_id);
create index if not exists chat_sessions_user_id_idx on public.chat_sessions(user_id);
create index if not exists chat_messages_session_id_idx on public.chat_messages(session_id);
create index if not exists purchase_candidates_user_id_idx on public.purchase_candidates(user_id);
create index if not exists assessment_reports_user_id_idx on public.assessment_reports(user_id);
create index if not exists decision_items_user_id_idx on public.decision_items(user_id);
create index if not exists decision_items_status_idx on public.decision_items(status);
create index if not exists decision_items_reminder_at_idx on public.decision_items(reminder_at);
create index if not exists feedback_events_user_id_idx on public.feedback_events(user_id);
create index if not exists closet_items_embedding_idx on public.closet_items using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists purchase_candidates_embedding_idx on public.purchase_candidates using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists fashion_knowledge_embedding_idx on public.fashion_knowledge using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.profiles enable row level security;
alter table public.closet_items enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.purchase_candidates enable row level security;
alter table public.assessment_reports enable row level security;
alter table public.decision_items enable row level security;
alter table public.feedback_events enable row level security;
alter table public.fashion_knowledge enable row level security;

create policy "profiles owner access" on public.profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "closet_items owner access" on public.closet_items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "chat_sessions owner access" on public.chat_sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "chat_messages owner access" on public.chat_messages for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "purchase_candidates owner access" on public.purchase_candidates for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "assessment_reports owner access" on public.assessment_reports for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "decision_items owner access" on public.decision_items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "feedback_events owner access" on public.feedback_events for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "fashion_knowledge authenticated read" on public.fashion_knowledge for select to authenticated using (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('closet-images', 'closet-images', false, 8388608, array['image/jpeg', 'image/png', 'image/webp']),
  ('purchase-screenshots', 'purchase-screenshots', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "closet image owner read" on storage.objects for select to authenticated using (bucket_id = 'closet-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "closet image owner insert" on storage.objects for insert to authenticated with check (bucket_id = 'closet-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "closet image owner update" on storage.objects for update to authenticated using (bucket_id = 'closet-images' and (storage.foldername(name))[1] = auth.uid()::text) with check (bucket_id = 'closet-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "closet image owner delete" on storage.objects for delete to authenticated using (bucket_id = 'closet-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "purchase screenshot owner read" on storage.objects for select to authenticated using (bucket_id = 'purchase-screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "purchase screenshot owner insert" on storage.objects for insert to authenticated with check (bucket_id = 'purchase-screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "purchase screenshot owner update" on storage.objects for update to authenticated using (bucket_id = 'purchase-screenshots' and (storage.foldername(name))[1] = auth.uid()::text) with check (bucket_id = 'purchase-screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "purchase screenshot owner delete" on storage.objects for delete to authenticated using (bucket_id = 'purchase-screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
