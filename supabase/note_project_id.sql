-- Adds notes.project_id: a stored, authoritative note→project assignment,
-- replacing inference through bubble membership (and the silent
-- first-project display fallback for notes with no bubbles).
--
-- Run once in the Supabase SQL editor. The schema change and backfill run in
-- a single transaction; the verification query at the end runs after commit.
--
-- Multi-project bubble spans: where a note's bubbles live in more than one
-- project, the backfill takes the project of the FIRST bubble in bubble_ids
-- array order. This is not a new choice — it is exactly the rule the client
-- has always used to display such notes (loadAllFromCloud walks bubble_ids in
-- order and takes the first match), so the stored assignment matches what
-- every user already sees on screen.
--
-- Delete rule: ON DELETE SET NULL. CASCADE would destroy notes when a project
-- row is deleted, and project deletion in this app deletes notes EXPLICITLY,
-- first (deleteProjectFromCloud removes connections and notes before the
-- project row). RESTRICT/NO ACTION would hard-fail a project deletion if any
-- straggler note row exists (e.g. written by another device between load and
-- delete), resurrecting the whole project over one note. SET NULL degrades a
-- crashed partial deletion to recoverable unassigned notes, which the
-- client's standing adoption path then re-homes visibly — never silently.

begin;

alter table public.notes add column if not exists project_id text;

-- Backfill from current bubble membership (first bubble in array order; see
-- header). Notes with no bubbles stay NULL — the client adopts them into the
-- account's oldest project (by created_at, id tiebreak), once, logs the
-- adoption, and persists the result.
-- bubble_ids was created outside the repo's SQL files, so its concrete type
-- (text[] vs jsonb) is detected here rather than assumed.
do $$
declare
  bubble_ids_type text;
begin
  select data_type into bubble_ids_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'notes' and column_name = 'bubble_ids';

  if bubble_ids_type = 'ARRAY' then
    update public.notes n
    set project_id = sub.project_id
    from (
      select n2.user_id, n2.id,
             (select b.project_id
              from unnest(n2.bubble_ids) with ordinality as x(bubble_id, ord)
              join public.bubbles b on b.user_id = n2.user_id and b.id = x.bubble_id
              order by x.ord
              limit 1) as project_id
      from public.notes n2
      where n2.project_id is null
    ) sub
    where n.user_id = sub.user_id and n.id = sub.id and sub.project_id is not null;
  elsif bubble_ids_type = 'jsonb' then
    update public.notes n
    set project_id = sub.project_id
    from (
      select n2.user_id, n2.id,
             (select b.project_id
              from jsonb_array_elements_text(n2.bubble_ids) with ordinality as x(bubble_id, ord)
              join public.bubbles b on b.user_id = n2.user_id and b.id = x.bubble_id
              order by x.ord
              limit 1) as project_id
      from public.notes n2
      where n2.project_id is null
    ) sub
    where n.user_id = sub.user_id and n.id = sub.id and sub.project_id is not null;
  else
    raise exception 'Unexpected notes.bubble_ids type: % — extend this script before running.', bubble_ids_type;
  end if;
end $$;

-- Composite FK matching the per-user id scheme (see composite_ids.sql).
-- Backfilled values are valid by construction: they come from
-- bubbles.project_id, which already has a CASCADE FK to projects.
alter table public.notes
  add constraint notes_project_id_fkey
  foreign key (user_id, project_id) references public.projects (user_id, id)
  on delete set null;

commit;

-- Verification: note counts per project, with remaining NULLs grouped as
-- '(no project — NULL)'. The NULL rows are the ones the client migration
-- adopts on their owner's next sign-in.
select n.user_id,
       coalesce(p.name, '(no project — NULL)') as project,
       count(*) as notes
from public.notes n
left join public.projects p
  on p.user_id = n.user_id and p.id = n.project_id
group by n.user_id, p.name
order by n.user_id, notes desc;
