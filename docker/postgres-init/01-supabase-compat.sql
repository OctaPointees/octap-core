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
    -- Only a role with BYPASSRLS (or a superuser) may grant it. RDS's admin may (staging's
    -- service_role has it), but a plain non-superuser may not, so fall back to a role without it.
    -- Nothing in Core runs as service_role (the API connects as the table owner, and withRls()
    -- switches to `authenticated`), so without it the role only exists for the grants below.
    begin
      create role service_role nologin noinherit bypassrls;
    exception when insufficient_privilege then
      create role service_role nologin noinherit;
    end;
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

-- Supabase grants its roles table access by default; a vanilla image starts with none, so
-- every RLS-gated query would fail with "permission denied" even when the policy itself
-- would have allowed it. Covers tables that exist now and ones future migrations add.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all privileges on all tables in schema public to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all privileges on tables to service_role;
