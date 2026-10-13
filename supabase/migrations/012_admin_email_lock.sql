-- The admin is one account (ADMIN_EMAILS on Vercel, default patrickbrownai@gmail.com). Revoke the old role grants.
update profiles set is_admin = (id in (select id from auth.users where lower(email) = 'patrickbrownai@gmail.com'));
