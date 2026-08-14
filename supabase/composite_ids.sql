-- Per-user composite primary keys for projects, bubbles, notes, connections.
--
-- Ids are generated client-side and were globally unique across ALL users
-- (PRIMARY KEY (id)). The app now seeds fixed, well-known ids (seed:project,
-- seed:ideas, …) that are identical on every install, so uniqueness must be
-- per user: PRIMARY KEY (user_id, id). Without this, the first account to
-- sync claims each seed row and every other account's upsert dies on RLS.
--
-- Run once in the Supabase SQL editor. Single transaction — any failure
-- (including every pre-flight check below) rolls the whole thing back.
-- No DROP ... CASCADE anywhere: every dependent is dropped explicitly.
--
-- Deploy order: run this FIRST, then deploy the app build that upserts with
-- onConflict 'user_id,id'. The old build's syncs fail between the two steps
-- (its ON CONFLICT (id) no longer matches a constraint), so keep the gap
-- short; failed syncs retry by themselves once the new build is live.

begin;

-- ── Pre-flight 0: no unaccounted dependents ─────────────────────────────────
-- The first run aborted because a table we hadn't listed (connections) held
-- FKs into notes. Never again by hand: scan pg_constraint for EVERY foreign
-- key in the database that references projects, bubbles, notes, or
-- connections, and abort — naming them — if anything exists beyond the three
-- this script explicitly drops and re-creates.
do $$
declare
  unexpected text;
begin
  select string_agg(
           format('%s on %s -> %s', conname, conrelid::regclass, confrelid::regclass),
           '; ')
    into unexpected
  from pg_constraint
  where contype = 'f'
    and confrelid in ('public.projects'::regclass,
                      'public.bubbles'::regclass,
                      'public.notes'::regclass,
                      'public.connections'::regclass)
    and conname not in ('bubbles_project_id_fkey',
                        'connections_from_note_id_fkey',
                        'connections_to_note_id_fkey');
  if unexpected is not null then
    raise exception
      'Aborting: unaccounted foreign keys reference tables being migrated: %. Extend this script before running.',
      unexpected;
  end if;
end $$;

-- ── Pre-flight 1: rows that would violate the new composite PKs or FKs ──────
-- (a) NULL user_id anywhere: composite PK forces NOT NULL and would abort.
-- (b) a bubble whose project row belongs to a DIFFERENT user.
-- (c) a connection whose user_id does not match its from-note's user_id.
-- (d) a connection whose user_id does not match its to-note's user_id.
-- Duplicate (user_id, id) pairs are impossible — id alone is already unique.
do $$
declare
  n_projects    bigint;
  n_bubbles     bigint;
  n_notes       bigint;
  n_connections bigint;
  n_fk_project  bigint;
  n_fk_from     bigint;
  n_fk_to       bigint;
begin
  select count(*) into n_projects    from public.projects    where user_id is null;
  select count(*) into n_bubbles     from public.bubbles     where user_id is null;
  select count(*) into n_notes       from public.notes       where user_id is null;
  select count(*) into n_connections from public.connections where user_id is null;
  select count(*) into n_fk_project
    from public.bubbles b
    where b.project_id is not null
      and not exists (
        select 1 from public.projects p
        where p.id = b.project_id and p.user_id = b.user_id
      );
  select count(*) into n_fk_from
    from public.connections c
    where c.from_note_id is not null
      and not exists (
        select 1 from public.notes n
        where n.id = c.from_note_id and n.user_id = c.user_id
      );
  select count(*) into n_fk_to
    from public.connections c
    where c.to_note_id is not null
      and not exists (
        select 1 from public.notes n
        where n.id = c.to_note_id and n.user_id = c.user_id
      );
  if n_projects > 0 or n_bubbles > 0 or n_notes > 0 or n_connections > 0
     or n_fk_project > 0 or n_fk_from > 0 or n_fk_to > 0 then
    raise exception
      'Aborting migration: NULL user_id rows — % projects, % bubbles, % notes, % connections; % bubbles whose project belongs to a different user; % connections whose user_id mismatches the from-note; % whose user_id mismatches the to-note. Fix these rows first.',
      n_projects, n_bubbles, n_notes, n_connections, n_fk_project, n_fk_from, n_fk_to;
  end if;
end $$;

-- ── Drop dependents explicitly, before any PK changes ───────────────────────
alter table public.bubbles     drop constraint bubbles_project_id_fkey;
alter table public.connections drop constraint connections_from_note_id_fkey;
alter table public.connections drop constraint connections_to_note_id_fkey;

-- ── Swap primary keys ───────────────────────────────────────────────────────
alter table public.projects drop constraint projects_pkey;
alter table public.projects add constraint projects_pkey primary key (user_id, id);

alter table public.bubbles drop constraint bubbles_pkey;
alter table public.bubbles add constraint bubbles_pkey primary key (user_id, id);

alter table public.notes drop constraint notes_pkey;
alter table public.notes add constraint notes_pkey primary key (user_id, id);

alter table public.connections drop constraint connections_pkey;
alter table public.connections add constraint connections_pkey primary key (user_id, id);

-- ── Re-add composite FKs so rows can only reference their own user's rows ───
-- ON DELETE CASCADE preserved on all three.
alter table public.bubbles
  add constraint bubbles_project_id_fkey
  foreign key (user_id, project_id) references public.projects (user_id, id)
  on delete cascade;

alter table public.connections
  add constraint connections_from_note_id_fkey
  foreign key (user_id, from_note_id) references public.notes (user_id, id)
  on delete cascade;

alter table public.connections
  add constraint connections_to_note_id_fkey
  foreign key (user_id, to_note_id) references public.notes (user_id, id)
  on delete cascade;

commit;

-- ── Verify: constraints and RLS policies after the swap ─────────────────────
-- Expect: composite PKs on all four tables, the three composite FKs above,
-- the untouched *_user_id_fkey FKs to auth.users, and one unchanged ALL
-- policy per table.
select conrelid::regclass as "table", conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.projects'::regclass,
                   'public.bubbles'::regclass,
                   'public.notes'::regclass,
                   'public.connections'::regclass)
order by 1::text, conname;

select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('projects', 'bubbles', 'notes', 'connections')
order by tablename, policyname;
