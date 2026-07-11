-- =============================================================================
-- Nova Comptabilité — 0034 : Portail client (accès dossier restreint)
-- =============================================================================
-- Un client final accède à SON dossier uniquement, en consultation + dépôt de
-- pièces. L'isolation est déjà assurée par la RLS (dossier_access alimente
-- app_dossier_ids). Ici : fonctions SECURITY DEFINER pour gérer ces accès et
-- exposer le rôle effectif du demandeur (utilisé par le garde-fou de capacités
-- côté API : un rôle 'client'/'lecture' ne peut pas écrire, sauf déposer une
-- pièce). Les fonctions contrôlent explicitement le périmètre (app_users est
-- protégé par RLS ; la création d'accès est réservée aux admins du cabinet).
-- =============================================================================

-- Rôle effectif du demandeur sur un dossier : 'staff' (membre du cabinet),
-- sinon le rôle d'accès direct (gestionnaire/collaborateur/client/lecture),
-- sinon NULL (aucun accès).
create or replace function dossier_role_for(p_dossier uuid)
returns text language sql security definer set search_path = public stable as $$
  select case
    when exists (
      select 1 from cabinet_members cm join dossiers d on d.cabinet_id = cm.cabinet_id
       where d.id = p_dossier and cm.user_id = app_current_user_id()
    ) then 'staff'
    else (select role::text from dossier_access where dossier_id = p_dossier and user_id = app_current_user_id())
  end
$$;

-- Accorde (ou met à jour) un accès 'client' à un dossier, par email.
-- Réservé aux propriétaires/associés du cabinet propriétaire du dossier.
create or replace function dossier_client_grant(p_dossier uuid, p_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_role cabinet_role;
begin
  select cm.role into v_role from cabinet_members cm join dossiers d on d.cabinet_id = cm.cabinet_id
    where d.id = p_dossier and cm.user_id = app_current_user_id();
  if v_role is null or v_role not in ('owner','associe') then
    raise exception 'Réservé aux administrateurs du cabinet';
  end if;
  select id into v_uid from app_users where email = lower(trim(p_email));
  if v_uid is null then raise exception 'USER_NOT_FOUND'; end if;
  -- On n'écrase jamais un accès "staff" direct (gestionnaire/collaborateur).
  insert into dossier_access(dossier_id, user_id, role) values (p_dossier, v_uid, 'client')
    on conflict (dossier_id, user_id) do update set role = 'client'
      where dossier_access.role in ('client','lecture');
  return v_uid;
end $$;

-- Liste les accès client/lecture d'un dossier. Réservé aux membres du cabinet.
create or replace function dossier_clients_list(p_dossier uuid)
returns table(user_id uuid, email text, name text, role dossier_role, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from cabinet_members cm join dossiers d on d.cabinet_id = cm.cabinet_id
     where d.id = p_dossier and cm.user_id = app_current_user_id()
  ) then raise exception 'Accès refusé à ce dossier'; end if;
  return query
    select da.user_id, u.email, u.name, da.role, da.created_at
      from dossier_access da join app_users u on u.id = da.user_id
     where da.dossier_id = p_dossier and da.role in ('client','lecture')
     order by da.created_at;
end $$;

-- Révoque un accès client/lecture. Réservé aux propriétaires/associés.
create or replace function dossier_client_revoke(p_dossier uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_role cabinet_role;
begin
  select cm.role into v_role from cabinet_members cm join dossiers d on d.cabinet_id = cm.cabinet_id
    where d.id = p_dossier and cm.user_id = app_current_user_id();
  if v_role is null or v_role not in ('owner','associe') then
    raise exception 'Réservé aux administrateurs du cabinet';
  end if;
  delete from dossier_access where dossier_id = p_dossier and user_id = p_user and role in ('client','lecture');
end $$;

grant execute on function dossier_role_for(uuid) to nova_app;
grant execute on function dossier_client_grant(uuid, text) to nova_app;
grant execute on function dossier_clients_list(uuid) to nova_app;
grant execute on function dossier_client_revoke(uuid, uuid) to nova_app;
