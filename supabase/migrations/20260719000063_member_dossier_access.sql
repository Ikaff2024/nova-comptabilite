-- =============================================================================
-- Nova Comptabilité — 0063 : accès par dossier pour les collaborateurs
-- =============================================================================
-- Jusqu'ici, TOUT membre d'un cabinet voyait TOUS ses dossiers : le rôle
-- (owner/associé/collaborateur) ne gouvernait que les pouvoirs d'administration,
-- pas la visibilité dossier par dossier. Problème de confidentialité dès qu'un
-- cabinet recrute.
--
-- On ajoute un drapeau `restricted` sur l'appartenance : un membre restreint ne
-- reçoit PLUS l'accès global du cabinet ; il ne voit que les dossiers qui lui
-- sont explicitement accordés (dossier_access). Par défaut false → comportement
-- existant strictement inchangé.
-- =============================================================================

alter table cabinet_members add column if not exists restricted boolean not null default false;

-- Périmètre : l'accès « par cabinet » ne s'applique plus aux membres restreints.
create or replace function app_dossier_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select d.id from dossiers d
   where d.cabinet_id in (
     select cabinet_id from cabinet_members
      where user_id = app_current_user_id() and not restricted
   )
  union
  select dossier_id from dossier_access where user_id = app_current_user_id()
$$;

-- --- Lecture : périmètre d'un membre (tous les dossiers + ceux accordés) ------
create or replace function cabinet_member_access_get(p_cabinet uuid, p_user uuid)
returns table(restricted boolean, dossier_id uuid, raison_sociale text, granted boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from cabinet_members cm where cm.cabinet_id = p_cabinet and cm.user_id = app_current_user_id()) then
    raise exception 'Accès refusé à ce cabinet';
  end if;
  return query
    select (select cm.restricted from cabinet_members cm where cm.cabinet_id = p_cabinet and cm.user_id = p_user),
           d.id, d.raison_sociale,
           exists (select 1 from dossier_access da where da.dossier_id = d.id and da.user_id = p_user)
      from dossiers d
     where d.cabinet_id = p_cabinet
     order by d.raison_sociale;
end $$;

-- --- Écriture : définit le périmètre d'un membre -----------------------------
create or replace function cabinet_member_access_set(
  p_cabinet uuid, p_user uuid, p_restricted boolean, p_dossiers uuid[]
) returns void
language plpgsql security definer set search_path = public as $$
declare v_caller cabinet_role; v_target cabinet_role;
begin
  select role into v_caller from cabinet_members where cabinet_id = p_cabinet and user_id = app_current_user_id();
  if v_caller is null or v_caller not in ('owner', 'associe') then
    raise exception 'Réservé aux administrateurs du cabinet';
  end if;
  -- Garde anti-verrouillage : on ne restreint pas son propre accès.
  if p_user = app_current_user_id() then
    raise exception 'Vous ne pouvez pas restreindre votre propre accès';
  end if;
  select role into v_target from cabinet_members where cabinet_id = p_cabinet and user_id = p_user;
  if v_target is null then raise exception 'Cette personne n''est pas membre du cabinet'; end if;
  if v_target = 'owner' then raise exception 'Un propriétaire conserve l''accès à tous les dossiers'; end if;

  update cabinet_members set restricted = p_restricted
   where cabinet_id = p_cabinet and user_id = p_user;

  -- On ne touche QU'aux accès « staff » de ce cabinet : les accès client /
  -- lecture (portail client) ne sont jamais écrasés ici.
  delete from dossier_access da using dossiers d
   where da.dossier_id = d.id and d.cabinet_id = p_cabinet and da.user_id = p_user
     and da.role in ('gestionnaire', 'collaborateur');

  if p_restricted and p_dossiers is not null and array_length(p_dossiers, 1) > 0 then
    insert into dossier_access(dossier_id, user_id, role)
      select d.id, p_user, 'collaborateur'::dossier_role
        from dossiers d
       where d.cabinet_id = p_cabinet and d.id = any(p_dossiers)
      on conflict (dossier_id, user_id) do update set role = 'collaborateur'::dossier_role;
  end if;
end $$;

grant execute on function cabinet_member_access_get(uuid, uuid) to nova_app;
grant execute on function cabinet_member_access_set(uuid, uuid, boolean, uuid[]) to nova_app;
