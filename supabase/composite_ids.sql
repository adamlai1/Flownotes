-- Per-user composite primary keys for projects, bubbles, and notes.
--
-- Ids are generated client-side and were globally unique across ALL users
-- (PRIMARY KEY (id)). The app now seeds fixed, well-known ids (seed:project,
-- seed:ideas, …) that are identical on every install, so uniqueness must be
-- per user: PRIMARY KEY (user_id, id). Without this, the first account to
-- sync claims each seed row and every other account's upsert dies on RLS.
--
-- Run once in the Supabase SQL editor. Single transaction — any failure
-- (including the data pre-check below) rolls the whole thing back.
--
-- Deploy order: run this FIRST, then deploy the app build that upserts with
-- onConflict 'user_id,id'. The old build's syncs fail between the two steps
-- (its ON CONFLICT (id) no longer matches a constraint), so keep the gap
-- short; failed syncs retry by themselves once the new build is live.

begin;

-- ── Pre-check: rows that would violate the new composite PK or FK ──────────
-- (a) NULL user_id anywhere: composite PK forces NOT NULL and would abort.
-- (b) a bubble whose project row belongs to a DIFFERENT user: legal under the
--     old FK (project_id -> projects.id), illegal under the composite FK.
-- Duplicate (user_id, id) pairs are impossible — id alone is already unique.
do $$
declare
  n_projects bigint;
  n_bubbles  bigint;
  n_notes    bigint;
  n_fk       bigint;
begin
  select count(*) into n_projects from public.projects where user_id is null;
  select count(*) into n_bubbles  from public.bubbles  where user_id is null;
  select count(*) into n_notes    from public.notes    where user_id is null;
  select count(*) into n_fk
    from public.bubbles b
    where b.project_id is not null
      and not exists (
        select 1 from public.projects p
        where p.id = b.project_id and p.user_id = b.user_id
      );
  if n_projects > 0 or n_bubbles > 0 or n_notes > 0 or n_fk > 0 then
    raise exception
      'Aborting migration: % projects / % bubbles / % notes with NULL user_id; % bubbles whose project belongs to a different user. Fix these rows first.',
      n_projects, n_bubbles, n_notes, n_fk;
  end if;
end $$;

-- ── Constraint swap ─────────────────────────────────────────────────────────
-- bubbles_project_id_fkey depends on projects_pkey, so it goes first.
alter table public.bubbles drop constraint bubbles_project_id_fkey;

alter table public.projects drop constraint projects_pkey;
alter table public.projects add constraint projects_pkey primary key (user_id, id);

alter table public.bubbles drop constraint bubbles_pkey;
alter table public.bubbles add constraint bubbles_pkey primary key (user_id, id);

alter table public.notes drop constraint notes_pkey;
alter table public.notes add constraint notes_pkey primary key (user_id, id);

-- Re-add as a composite FK so a bubble can only reference its own user's
-- project. ON DELETE CASCADE preserved.
alter table public.bubbles
  add constraint bubbles_project_id_fkey
  foreign key (user_id, project_id) references public.projects (user_id, id)
  on delete cascade;

commit;

-- ── Verify: constraints and RLS policies after the swap ─────────────────────
-- Expect: composite PKs on all three tables, the composite bubbles FK, the
-- untouched user_id FKs to auth.users, and one unchanged ALL policy per table.
select conrelid::regclass as "table", conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.projects'::regclass, 'public.bubbles'::regclass, 'public.notes'::regclass)
order by 1::text, conname;

select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('projects', 'bubbles', 'notes')
order by tablename, policyname;
