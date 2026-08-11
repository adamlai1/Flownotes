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

-- RLS decides WHICH rows a role may write; it does not grant the right to write at all.
-- Without this the anon role fails with "permission denied for table feedback" before
-- the policy below is ever evaluated. Supabase's default privileges usually cover new
-- public tables, but that depends on the project, so state it outright.
--
-- INSERT only, deliberately: submitFeedback calls .insert() with no .select() chained,
-- which supabase-js v2 sends as `Prefer: return=minimal`. Nothing is read back, so no
-- SELECT grant is needed — and withholding it is what keeps one user's feedback from
-- being readable by another. Read the table from the dashboard, which bypasses RLS.
grant insert on public.feedback to anon, authenticated;

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
