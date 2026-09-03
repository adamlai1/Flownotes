-- Synced Bouncy Animations and Quick Create preferences.
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Why: both were device-local, so the + button (and motion) could behave
-- differently on a user's phone and on the web. They now follow the Note
-- Size pattern — localStorage for instant load, this row as the source of
-- truth when signed in (see src/contexts/PreferencesContext.jsx).
--
-- Columns are NULLABLE on purpose: NULL means "no choice made on this
-- account yet", which the client seeds from the device's local choice on
-- sign-in (exactly how a device class missing from note_size is handled).
-- Bouncy's default is not a stored value at all — with NULL the client
-- follows the OS reduced-motion setting live.
--
-- Until this is run, the client degrades: it detects the missing columns,
-- logs a warning, keeps syncing note_size and the lock fields, and leaves
-- these two device-local. Nothing breaks.

-- Preflight: the preferences table must exist (supabase/user_preferences.sql).
do $$
begin
  if to_regclass('public.user_preferences') is null then
    raise exception 'public.user_preferences does not exist — run supabase/user_preferences.sql first';
  end if;
end $$;

alter table public.user_preferences add column if not exists bouncy       boolean;
alter table public.user_preferences add column if not exists quick_create boolean;

-- Verification: both rows should come back.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'user_preferences'
  and column_name in ('bouncy', 'quick_create')
order by column_name;
