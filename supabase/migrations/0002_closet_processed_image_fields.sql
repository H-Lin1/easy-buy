alter table public.closet_items
  add column if not exists processed_image_path text,
  add column if not exists image_quality_flags text[] default '{}';

update public.closet_items
set image_quality_flags = '{}'
where image_quality_flags is null;
