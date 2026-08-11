-- In-app feedback submitted from Settings.
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  message     text not null,
  -- Free-text context captured with the report so a vague message is still actionable.
  user_agent  text,
  app_version text,
  created_at  timestamptz not null default now()
);

create index if not exists feedback_created_at_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

-- Anyone using the app may leave feedback, signed in or not (guest mode has no user).
-- Insert only: a client can post a report but can never read the table back, so one
-- user's feedback is never visible to another.
drop policy if exists "anyone can submit feedback" on public.feedback;
create policy "anyone can submit feedback"
  on public.feedback for insert
  with check (
    -- A signed-in client may only attribute a report to itself; anonymous is allowed.
    user_id is null or user_id = auth.uid()
  );
