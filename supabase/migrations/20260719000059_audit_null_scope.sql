-- =============================================================================
-- Nova Comptabilité — 0059 : durcissement RLS de la piste d'audit
-- =============================================================================
-- La policy de lecture d'audit_log autorisait TOUTES les lignes sans dossier
-- (dossier_id IS NULL, ex. événements niveau cabinet) à n'importe quel
-- utilisateur authentifié. Non exploitable via l'application (listAudit filtre
-- toujours par dossier), mais on ferme la porte par défense en profondeur :
-- une ligne sans dossier n'est visible QUE par son auteur.
-- =============================================================================

drop policy if exists audit_read on audit_log;
create policy audit_read on audit_log for select
  using (
    dossier_id in (select app_dossier_ids())
    or (dossier_id is null and user_id = app_current_user_id())
  );
