-- The schema and migrations assume a Supabase-hosted Postgres, which provisions the
-- anon/authenticated/service_role roles and an auth.uid() helper on every project.
-- A vanilla postgres:* image has neither, so migrations fail on a fresh local container
-- without this. Mirrors exactly what Supabase itself defines, not a simplification: real
-- RLS policies here reference these by name, and api/src/infra/db/rls.ts's withRls() sets
-- the same session GUCs (request.jwt.claim.sub / request.jwt.claims) auth.uid() reads.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
