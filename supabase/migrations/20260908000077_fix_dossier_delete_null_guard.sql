-- =============================================================================
-- Nova Comptabilité — 0077 : faille d'autorisation sur dossier_delete (NULL)
-- =============================================================================
-- FAILLE CRITIQUE CORRIGÉE ICI. La garde de dossier_delete s'écrivait :
--
--     if not (app_is_platform_admin() or v_caller in ('owner','associe')) then
--       raise exception ...
--
-- Quand l'appelant n'est PAS membre du cabinet visé — c'est-à-dire un
-- utilisateur d'un AUTRE cabinet, exactement le cas d'un attaquant — la
-- sous-requête laisse v_caller à NULL. Or, en logique ternaire SQL :
--
--     NULL in ('owner','associe')          -> NULL
--     false or NULL                        -> NULL
--     not NULL                             -> NULL
--     if NULL then raise                   -> l'exception N'EST PAS levée
--
-- La garde ne se déclenchait donc que pour un membre de RANG insuffisant du
-- cabinet, jamais pour un parfait étranger. Conséquence : tout utilisateur
-- authentifié pouvait SUPPRIMER n'importe quel dossier de la plateforme à
-- partir de son seul identifiant (UUID) — opération irréversible, avec toutes
-- ses écritures.
--
-- Toutes les fonctions sœurs (cabinet_rename, cabinet_member_*,
-- dossier_client_grant, dossier_set_agent_mode…) utilisent déjà le motif sûr
-- « v_caller is null or v_caller not in (...) ». dossier_delete, écrite plus
-- tard et différemment, était la seule exception. On l'aligne.
-- =============================================================================

create or replace function dossier_delete(p_dossier uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_cabinet uuid; v_caller cabinet_role;
begin
  select cabinet_id into v_cabinet from dossiers where id = p_dossier;
  if v_cabinet is null then raise exception 'Dossier introuvable'; end if;

  select cm.role into v_caller from cabinet_members cm
   where cm.cabinet_id = v_cabinet and cm.user_id = app_current_user_id();

  -- Motif sûr : on teste explicitement le NULL (non-membre) AVANT le rôle.
  -- Un admin plateforme reste autorisé.
  if not app_is_platform_admin()
     and (v_caller is null or v_caller not in ('owner', 'associe')) then
    raise exception 'Suppression réservée au propriétaire ou à un associé du cabinet';
  end if;

  delete from bank_pointings     where dossier_id = p_dossier;
  delete from lettrage_lines      where dossier_id = p_dossier;
  delete from lettrages           where dossier_id = p_dossier;
  delete from invoices            where dossier_id = p_dossier;
  delete from purchase_invoices   where dossier_id = p_dossier;
  delete from recurring_templates where dossier_id = p_dossier;
  delete from entry_lines         where dossier_id = p_dossier;
  update entries set reverses_entry_id = null, reversed_by_entry_id = null where dossier_id = p_dossier;
  delete from entries             where dossier_id = p_dossier;

  delete from dossiers where id = p_dossier;
end $$;

grant execute on function dossier_delete(uuid) to nova_app;
