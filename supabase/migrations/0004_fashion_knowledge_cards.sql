alter table public.fashion_knowledge
  add column if not exists card_id text,
  add column if not exists knowledge_type text,
  add column if not exists locale text default 'zh-CN',
  add column if not exists taxonomy_version text default 'v1',
  add column if not exists category_tags text[] default '{}',
  add column if not exists color_tags text[] default '{}',
  add column if not exists style_tags text[] default '{}',
  add column if not exists scenario_tags text[] default '{}',
  add column if not exists fit_tags text[] default '{}',
  add column if not exists fabric_tags text[] default '{}',
  add column if not exists risk_tags text[] default '{}',
  add column if not exists value_tags text[] default '{}',
  add column if not exists applicable_items text[] default '{}',
  add column if not exists not_applicable_items text[] default '{}',
  add column if not exists decision_points text[] default '{}',
  add column if not exists outfit_suggestions text[] default '{}',
  add column if not exists risk_signals text[] default '{}',
  add column if not exists decision_bias jsonb default '{}'::jsonb,
  add column if not exists source_refs text[] default '{}',
  add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists priority integer default 100,
  add column if not exists status text default 'active';

alter table public.fashion_knowledge
  drop constraint if exists fashion_knowledge_source_type_check;

alter table public.fashion_knowledge
  add constraint fashion_knowledge_source_type_check
  check (source_type in ('builtin', 'external_placeholder', 'curated'));

create unique index if not exists fashion_knowledge_card_id_uidx
  on public.fashion_knowledge(card_id)
  where card_id is not null;

create index if not exists fashion_knowledge_status_idx
  on public.fashion_knowledge(status);

create index if not exists fashion_knowledge_taxonomy_version_idx
  on public.fashion_knowledge(taxonomy_version);
