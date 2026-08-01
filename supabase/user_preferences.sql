-- Per-account display preferences (e.g. bubble-view note size).
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.user_preferences (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note_size  text,
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

-- Each user can read/write only their own row.
drop policy if exists "users manage own preferences" on public.user_preferences;
create policy "users manage own preferences"
  on public.user_preferences
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
