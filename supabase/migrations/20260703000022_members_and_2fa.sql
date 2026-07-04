-- =============================================================================
-- Nova Comptabilité — 0022 : Collaborateurs (rôles) + double authentification
-- =============================================================================
-- Gestion des membres d'un cabinet (owner / associe / collaborateur) et 2FA TOTP.
-- Les fonctions sont SECURITY DEFINER : elles contrôlent explicitement le
-- périmètre (app_current_user_id) car app_users est protégé par RLS.
-- =============================================================================

alter table app_users
  add column totp_secret  text,
  add column totp_enabled boolean not null default false;

-- --- Login : renvoie aussi l'état 2FA -----------------------------------------
drop function if exists get_user_for_login(text);
create function get_user_for_login(p_email text)
returns table(id uuid, password_hash text, name text, email text, totp_secret text, totp_enabled boolean)
language sql security definer set search_path = public as $$
  select id, password_hash, name, email, totp_secret, totp_enabled
    from app_users where email = lower(trim(p_email));
$$;

drop function if exists get_user(uuid);
create function get_user(p_id uuid)
returns table(id uuid, email text, name text, totp_enabled boolean)
language sql security definer set search_path = public as $$
  select id, email, name, totp_enabled from app_users where id = p_id;
$$;

-- --- 2FA : enrôlement / activation / désactivation (sur soi-même) --------------
create or replace function totp_set_pending(p_secret text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update app_users set totp_secret = p_secret, totp_enabled = false where id = app_current_user_id();
end $$;

create or replace function totp_enable() returns void
language plpgsql security definer set search_path = public as $$
begin
  update app_users set totp_enabled = true where id = app_current_user_id() and totp_secret is not null;
end $$;

create or replace function totp_disable() returns void
language plpgsql security definer set search_path = public as $$
begin
  update app_users set totp_secret = null, totp_enabled = false where id = app_current_user_id();
end $$;

-- --- Membres du cabinet -------------------------------------------------------
create or replace function cabinet_members_list(p_cabinet uuid)
returns table(user_id uuid, email text, name text, role cabinet_role, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from cabinet_members cm where cm.cabinet_id = p_cabinet and cm.user_id = app_current_user_id()) then
    raise exception 'Accès refusé à ce cabinet';
  end if;
  return query
    select cm.user_id, u.email, u.name, cm.role, cm.created_at
      from cabinet_members cm join app_users u on u.id = cm.user_id
     where cm.cabinet_id = p_cabinet order by cm.created_at;
end $$;

create or replace function cabinet_member_add(p_cabinet uuid, p_email text, p_role cabinet_role)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_id uuid; v_caller cabinet_role;
begin
  select role into v_caller from cabinet_members where cabinet_id = p_cabinet and user_id = app_current_user_id();
  if v_caller is null or v_caller not in ('owner','associe') then raise exception 'Réservé aux administrateurs du cabinet'; end if;
  select id into v_uid from app_users where email = lower(trim(p_email));
  if v_uid is null then raise exception 'USER_NOT_FOUND'; end if;
  insert into cabinet_members(cabinet_id, user_id, role) values (p_cabinet, v_uid, p_role)
    on conflict (cabinet_id, user_id) do update set role = excluded.role
    returning id into v_id;
  return v_id;
end $$;

create or replace function cabinet_member_set_role(p_cabinet uuid, p_user uuid, p_role cabinet_role)
returns void language plpgsql security definer set search_path = public as $$
declare v_caller cabinet_role;
begin
  select role into v_caller from cabinet_members where cabinet_id = p_cabinet and user_id = app_current_user_id();
  if v_caller is null or v_caller not in ('owner','associe') then raise exception 'Réservé aux administrateurs du cabinet'; end if;
  if p_role <> 'owner'
     and exists (select 1 from cabinet_members where cabinet_id = p_cabinet and user_id = p_user and role = 'owner')
     and (select count(*) from cabinet_members where cabinet_id = p_cabinet and role = 'owner') <= 1 then
    raise exception 'Le cabinet doit conserver au moins un propriétaire';
  end if;
  update cabinet_members set role = p_role where cabinet_id = p_cabinet and user_id = p_user;
end $$;

create or replace function cabinet_member_remove(p_cabinet uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_caller cabinet_role;
begin
  select role into v_caller from cabinet_members where cabinet_id = p_cabinet and user_id = app_current_user_id();
  if v_caller is null or v_caller not in ('owner','associe') then raise exception 'Réservé aux administrateurs du cabinet'; end if;
  if exists (select 1 from cabinet_members where cabinet_id = p_cabinet and user_id = p_user and role = 'owner')
     and (select count(*) from cabinet_members where cabinet_id = p_cabinet and role = 'owner') <= 1 then
    raise exception 'Impossible de retirer le dernier propriétaire';
  end if;
  delete from cabinet_members where cabinet_id = p_cabinet and user_id = p_user;
end $$;

grant execute on function get_user_for_login(text) to nova_app;
grant execute on function get_user(uuid) to nova_app;
grant execute on function totp_set_pending(text) to nova_app;
grant execute on function totp_enable() to nova_app;
grant execute on function totp_disable() to nova_app;
grant execute on function cabinet_members_list(uuid) to nova_app;
grant execute on function cabinet_member_add(uuid, text, cabinet_role) to nova_app;
grant execute on function cabinet_member_set_role(uuid, uuid, cabinet_role) to nova_app;
grant execute on function cabinet_member_remove(uuid, uuid) to nova_app;
