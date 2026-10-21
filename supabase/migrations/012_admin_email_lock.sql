-- The admin is the ADMIN_EMAILS allowlist on Vercel (no default; unset means no admin). Revoke the old role grants.
-- Applying by hand on a fresh project: run `set app.admin_emails = 'you@example.com';` in the same session first
-- (comma-separated), or set profiles.is_admin for your account afterwards.
update profiles set is_admin = (id in (select id from auth.users where lower(email) = any(
  string_to_array(replace(lower(coalesce(current_setting('app.admin_emails', true), '')), ' ', ''), ','))));
