alter table public.purchase_candidates
  add column if not exists product_name text;

alter table public.decision_items
  add column if not exists size_label text;

update public.purchase_candidates
set product_name = nullif(trim(concat_ws('', nullif(color, 'unknown'), category)), '')
where product_name is null;
