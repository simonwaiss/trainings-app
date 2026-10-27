-- Minimaler Nachbau der Supabase-Umgebung für Tests: Rollen, auth.users, auth.uid().
create role anon nologin;
create role authenticated nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
grant usage on schema auth to anon, authenticated, supabase_auth_admin;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant insert, select on auth.users to supabase_auth_admin;
