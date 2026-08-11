-- Password locking for bubbles and notes.
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- NOTE: `locked` is a UI gate, not encryption. Locked notes and bubbles are stored
-- here in plain text exactly like unlocked ones — the flag only tells the client to
-- withhold the name/preview until the password is entered.

alter table public.notes   add column if not exists locked boolean not null default false;
alter table public.bubbles add column if not exists locked boolean not null default false;

-- The lock password itself, stored only as a salted hash (see src/utils/locks.js),
-- so it syncs across a signed-in user's devices.
alter table public.user_preferences add column if not exists lock_hash text;
alter table public.user_preferences add column if not exists lock_salt text;
