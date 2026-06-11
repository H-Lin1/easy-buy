alter table public.closet_items
  add column if not exists display_image_path text,
  add column if not exists display_image_status text default 'not_started'
    check (display_image_status in ('not_started', 'queued', 'processing', 'ready', 'failed')),
  add column if not exists display_image_model text,
  add column if not exists display_image_prompt_version text;

update public.closet_items
set display_image_status = 'not_started'
where display_image_status is null;
