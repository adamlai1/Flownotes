-- Run once in the Supabase SQL editor BEFORE deploying the delete-account
-- edge function.
--
-- Account deletion works by deleting the auth.users row and letting the
-- user_id foreign keys cascade. The four content tables' *_user_id_fkey FKs
-- were created in the dashboard, so their delete rule isn't recorded in this
-- repo, and custom_tags may have no FK to auth.users at all. This script
-- normalizes all five per-user tables to ON DELETE CASCADE, idempotently:
-- any existing user_id FK to auth.users is dropped (whatever its name or
-- rule) and re-added as CASCADE. user_preferences is already CASCADE
-- (user_preferences.sql) and is left alone; feedback deliberately stays
-- ON DELETE SET NULL — reports survive anonymized, matching its
-- accepts-anonymous design.
--
-- The orphan cleanup before each ADD is required for the constraint to
-- validate: rows whose auth user is already gone (deleted before the FK
-- existed) belong to no one and cannot be reached by any client.

do $$
declare
  t text;
  fk record;
begin
  foreach t in array array['projects', 'bubbles', 'notes', 'connections', 'custom_tags'] loop
    for fk in
      select tc.constraint_name
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
       and ccu.constraint_schema = tc.constraint_schema
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
       and kcu.constraint_schema = tc.constraint_schema
      where tc.table_schema = 'public' and tc.table_name = t
        and tc.constraint_type = 'FOREIGN KEY'
        and ccu.table_schema = 'auth' and ccu.table_name = 'users'
        and kcu.column_name = 'user_id'
    loop
      execute format('alter table public.%I drop constraint %I', t, fk.constraint_name);
    end loop;

    execute format(
      'delete from public.%I where user_id is not null and not exists (select 1 from auth.users u where u.id = public.%I.user_id)',
      t, t);

    execute format(
      'alter table public.%I add constraint %I foreign key (user_id) references auth.users(id) on delete cascade',
      t, t || '_user_id_fkey');
  end loop;
end $$;

-- Verify: every listed table should now show delete_rule = 'CASCADE'
-- (feedback intentionally shows 'SET NULL').
select tc.table_name, tc.constraint_name, rc.delete_rule
from information_schema.table_constraints tc
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.constraint_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
where tc.constraint_type = 'FOREIGN KEY'
  and ccu.table_schema = 'auth' and ccu.table_name = 'users'
order by tc.table_name;
