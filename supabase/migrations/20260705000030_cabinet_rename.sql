-- =============================================================================
-- Nova Comptabilité — 0030 : Renommer un cabinet
-- =============================================================================
-- La table cabinets n'a qu'une policy SELECT (pas d'UPDATE pour nova_app).
-- Le renommage passe par une fonction SECURITY DEFINER, réservée owner/associé.
-- =============================================================================

create or replace function cabinet_rename(p_cabinet uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_caller cabinet_role;
begin
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'Nom du cabinet requis'; end if;
  select cm.role into v_caller from cabinet_members cm where cm.cabinet_id = p_cabinet and cm.user_id = app_current_user_id();
  if v_caller is null or v_caller not in ('owner', 'associe') then raise exception 'Réservé aux administrateurs du cabinet'; end if;
  update cabinets set name = trim(p_name) where id = p_cabinet;
end $$;

grant execute on function cabinet_rename(uuid, text) to nova_app;
