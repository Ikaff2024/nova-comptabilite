-- =============================================================================
-- Nova Comptabilité — 0058 : fonction sécurisée de changement de type de compte
-- =============================================================================
-- La table cabinets n'a qu'une policy SELECT (aucune UPDATE) : un UPDATE direct
-- sous la RLS applicative affecte 0 ligne. Comme onboard_cabinet / cabinet_rename,
-- on passe par une fonction SECURITY DEFINER qui contrôle explicitement le
-- périmètre (l'appelant doit être owner/associé du cabinet).
-- =============================================================================

create or replace function cabinet_set_account_type(p_cabinet_id uuid, p_type text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_type not in ('cabinet', 'entreprise') then
    raise exception 'Type de compte invalide : %', p_type;
  end if;
  -- garde de périmètre : owner/associé du cabinet uniquement (quand un user
  -- est dans le contexte applicatif ; les tâches système en sont exemptées).
  if app_current_user_id() is not null
     and not exists (
       select 1 from cabinet_members m
       where m.cabinet_id = p_cabinet_id
         and m.user_id = app_current_user_id()
         and m.role in ('owner', 'associe')
     ) then
    raise exception 'Accès refusé au cabinet %', p_cabinet_id;
  end if;
  update cabinets set account_type = p_type where id = p_cabinet_id;
end $$;

grant execute on function cabinet_set_account_type(uuid, text) to nova_app;
