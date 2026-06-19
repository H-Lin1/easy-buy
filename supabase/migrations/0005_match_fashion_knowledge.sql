create or replace function public.match_fashion_knowledge(
  query_embedding vector(1024),
  match_count int default 24
)
returns table (
  card_id text,
  topic text,
  knowledge_type text,
  tags text[],
  content text,
  category_tags text[],
  color_tags text[],
  style_tags text[],
  scenario_tags text[],
  fit_tags text[],
  fabric_tags text[],
  risk_tags text[],
  value_tags text[],
  applicable_items text[],
  decision_points text[],
  outfit_suggestions text[],
  risk_signals text[],
  decision_bias jsonb,
  source_refs text[],
  priority int,
  similarity double precision
)
language sql
stable
as $$
  select
    fk.card_id,
    fk.topic,
    fk.knowledge_type,
    fk.tags,
    fk.content,
    fk.category_tags,
    fk.color_tags,
    fk.style_tags,
    fk.scenario_tags,
    fk.fit_tags,
    fk.fabric_tags,
    fk.risk_tags,
    fk.value_tags,
    fk.applicable_items,
    fk.decision_points,
    fk.outfit_suggestions,
    fk.risk_signals,
    fk.decision_bias,
    fk.source_refs,
    fk.priority,
    1 - (fk.embedding <=> query_embedding) as similarity
  from public.fashion_knowledge fk
  where fk.status = 'active'
    and fk.taxonomy_version = 'v1'
    and fk.embedding is not null
  order by fk.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 100);
$$;
