-- =============================================================================
-- Nova Comptabilité — 0031 : Modifier son propre nom d'affichage
-- =============================================================================
-- app_users est protégé par RLS (lecture de sa propre ligne uniquement, pas
-- d'UPDATE). La mise à jour du nom passe par une fonction SECURITY DEFINER qui
-- n'agit que sur l'utilisateur courant.
-- =============================================================================

create or replace function user_set_name(p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'Nom requis'; end if;
  update app_users set name = trim(p_name) where id = app_current_user_id();
end $$;

grant execute on function user_set_name(text) to nova_app;
