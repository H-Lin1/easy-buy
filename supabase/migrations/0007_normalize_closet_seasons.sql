do $$
declare
  unknown_values text[];
  updated_rows integer;
begin
  lock table public.closet_items in share row exclusive mode;

  select array_agg(display_value order by display_value collate "C")
  into unknown_values
  from (
    select distinct quote_nullable(season_value) as display_value
    from public.closet_items
    cross join lateral unnest(coalesce(season, '{}'::text[])) as seasons(season_value)
    where season_value is null
      or regexp_replace(
        lower(btrim(normalize(season_value, NFKC))),
        '[[:space:]_-]+',
        '',
        'g'
      ) not in (
        'spring',
        'springseason',
        '春',
        '春天',
        '春季',
        'summer',
        'summerseason',
        '夏',
        '夏天',
        '夏季',
        'autumn',
        'autumnseason',
        'fall',
        'fallseason',
        '秋',
        '秋天',
        '秋季',
        'winter',
        'winterseason',
        '冬',
        '冬天',
        '冬季',
        'allseason',
        'allseasons',
        'yearround',
        '四季',
        '全季',
        '全年',
        '全年适用',
        '全年可穿',
        '四季皆宜',
        '四季可穿'
      )
  ) as unknown_seasons;

  if unknown_values is not null then
    raise exception 'Cannot normalize closet_items.season; unknown values: %', unknown_values;
  end if;

  with normalized as materialized (
    select closet_item.id, normalized_seasons.season
    from public.closet_items as closet_item
    cross join lateral (
      select coalesce(array_agg(mapped_season order by first_ordinality), '{}'::text[]) as season
      from (
        select mapped_season, min(ordinality) as first_ordinality
        from unnest(coalesce(closet_item.season, '{}'::text[])) with ordinality as seasons(season_value, ordinality)
        cross join lateral (
          select case
            when regexp_replace(
              lower(btrim(normalize(season_value, NFKC))),
              '[[:space:]_-]+',
              '',
              'g'
            ) in ('spring', 'springseason', '春', '春天', '春季') then '春季'
            when regexp_replace(
              lower(btrim(normalize(season_value, NFKC))),
              '[[:space:]_-]+',
              '',
              'g'
            ) in ('summer', 'summerseason', '夏', '夏天', '夏季') then '夏季'
            when regexp_replace(
              lower(btrim(normalize(season_value, NFKC))),
              '[[:space:]_-]+',
              '',
              'g'
            ) in ('autumn', 'autumnseason', 'fall', 'fallseason', '秋', '秋天', '秋季') then '秋季'
            when regexp_replace(
              lower(btrim(normalize(season_value, NFKC))),
              '[[:space:]_-]+',
              '',
              'g'
            ) in ('winter', 'winterseason', '冬', '冬天', '冬季') then '冬季'
            when regexp_replace(
              lower(btrim(normalize(season_value, NFKC))),
              '[[:space:]_-]+',
              '',
              'g'
            ) in (
              'allseason',
              'allseasons',
              'yearround',
              '四季',
              '全季',
              '全年',
              '全年适用',
              '全年可穿',
              '四季皆宜',
              '四季可穿'
            ) then '四季'
          end as mapped_season
        ) as mapped
        group by mapped_season
      ) as deduplicated
    ) as normalized_seasons
  )
  update public.closet_items as closet_item
  set season = normalized.season
  from normalized
  where closet_item.id = normalized.id
    and closet_item.season is distinct from normalized.season;

  get diagnostics updated_rows = row_count;
  raise notice 'Normalized closet_items.season for % row(s).', updated_rows;
end
$$;
