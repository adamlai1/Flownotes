-- Deletion tombstones: the durable, account-wide record that an item existed
-- and was deleted. Run once in the Supabase SQL editor. Safe to re-run.
--
-- Why: the routine sync upserts whole projects, so a device that missed a
-- deletion re-inserts the deleted row on its next push ("resurrection").
-- The deleting device's outbox tombstone is local to that device and is
-- discarded once the cloud DELETE lands — nothing shared says "this id was
-- deleted". This table is that shared record.
--
-- Conflict rule (enforced client-side, see src/lib/syncService.js):
-- a tombstone wins only when deleted_at is STRICTLY newer than the row's
-- updated_at. A note edited after the deletion survives, edits intact —
-- ties favor the data, never silent loss.
--
-- `kind` is 'note' today; bubbles/projects/connections may join in later
-- phases without a schema change. Rows are pruned client-side after ~90 days
-- (every device that could resurrect an item will have synced long before).

create table if not exists public.tombstones (
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null,
  item_id    text not null,
  deleted_at timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);

alter table public.tombstones enable row level security;

-- Each user can read/write only their own tombstones.
drop policy if exists "users manage own tombstones" on public.tombstones;
create policy "users manage own tombstones"
  on public.tombstones
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
