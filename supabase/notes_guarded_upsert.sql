-- Guarded note upsert: upsert_notes_if_newer(rows jsonb) → integer.
--
-- The push half of the stale-overwrite fix. The client's note sync is a
-- whole-project upsert, which is last-writer-wins: a device holding a stale
-- copy of a note (its pull predates another device's edit) re-uploads that
-- stale copy along with whatever it actually changed, silently reverting the
-- newer edit. This function applies each incoming row only where the stored
-- updated_at is NOT newer than the incoming one, making the decision atomic
-- in Postgres — no read-then-write race, and no extra round-trip over the
-- plain upsert it replaces.
--
-- Conflict rule (mirrors the client's pull guard and the tombstone rule):
--   older incoming        → skipped, the newer stored row survives
--   newer incoming        → written
--   equal updated_at      → WRITTEN. locked / pinned / project_id changes
--     deliberately don't bump updated_at (a lock isn't an edit), and the
--     adoption path persists project_id on otherwise-untouched notes — ties
--     must go through or those fields could never sync. An older copy still
--     can never clobber a newer one, which is the destroyer being guarded.
--
-- Returns the number of rows actually written; the client logs the
-- difference as "stale note(s) not pushed".
--
-- security invoker: runs as the calling user, so the notes RLS policies
-- apply exactly as they do to the direct upsert this replaces.
--
-- jsonb_populate_recordset(null::public.notes, …) types each field from the
-- live notes table (bubble_ids/tags were created outside these SQL files, so
-- their concrete types are never assumed — same reasoning as
-- note_project_id.sql). If updated_at is text rather than timestamptz the
-- comparison still orders correctly: every value is toISOString() output
-- (fixed-width UTC), which compares lexicographically in timestamp order.
--
-- Prerequisites (checked below, aborting with a message if missing):
--   composite_ids.sql    — the (user_id, id) conflict target
--   note_project_id.sql  — notes.project_id
--   locks.sql            — notes.locked
--
-- Until this is run the client detects the missing function and falls back
-- to the unguarded upsert (today's behavior), logging a warning.

begin;

do $$
declare
  missing text := '';
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'notes'
                   and column_name = 'project_id') then
    missing := missing || ' notes.project_id (run note_project_id.sql);';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'notes'
                   and column_name = 'locked') then
    missing := missing || ' notes.locked (run locks.sql);';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.notes'::regclass
                   and contype = 'p'
                   and pg_get_constraintdef(oid) like '%(user_id, id)%') then
    missing := missing || ' composite primary key (user_id, id) on notes (run composite_ids.sql);';
  end if;
  if missing <> '' then
    raise exception 'Aborting: prerequisites missing —%', missing;
  end if;
end $$;

create or replace function public.upsert_notes_if_newer(rows jsonb)
returns integer
language sql
security invoker
set search_path = public
as $func$
  with incoming as (
    select * from jsonb_populate_recordset(null::public.notes, rows)
  ), written as (
    insert into public.notes as n
      (id, user_id, project_id, title, content, created_at, updated_at,
       bubble_ids, tags, pinned, locked)
    select id, user_id, project_id, title, content, created_at, updated_at,
           bubble_ids, tags, coalesce(pinned, false), coalesce(locked, false)
    from incoming
    on conflict (user_id, id) do update set
      project_id = excluded.project_id,
      title      = excluded.title,
      content    = excluded.content,
      updated_at = excluded.updated_at,
      bubble_ids = excluded.bubble_ids,
      tags       = excluded.tags,
      pinned     = excluded.pinned,
      locked     = excluded.locked
      -- created_at deliberately not updated: creation time is immutable.
    where n.updated_at is null or n.updated_at <= excluded.updated_at
    returning 1
  )
  select count(*)::integer from written;
$func$;

grant execute on function public.upsert_notes_if_newer(jsonb) to authenticated;

commit;

-- Supabase reloads PostgREST's schema cache on DDL automatically; this makes
-- the new function visible immediately even where that trigger is missing.
notify pgrst, 'reload schema';

-- Verification: the function exists, takes jsonb, runs as invoker.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       case when p.prosecdef then 'definer' else 'invoker' end as security
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'upsert_notes_if_newer';
