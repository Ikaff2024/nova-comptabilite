-- =============================================================================
-- Nova Comptabilité — 0052 : Secteur d'activité du dossier
-- =============================================================================
-- L'imputation comptable dépend de l'ACTIVITÉ de l'entreprise : un même bien
-- peut être une immobilisation (classe 2) OU une marchandise/stock (classe 3/6)
-- selon ce que fait la société. Exemple : un véhicule est une immobilisation
-- pour un cabinet de services, mais une marchandise pour un concessionnaire
-- automobile. Lexa et la Capture IA doivent connaître ce secteur pour imputer
-- correctement.
-- =============================================================================

alter table dossiers add column if not exists secteur_activite text;  -- description libre de l'activité

-- Démo convaincante : activité réaliste pour le dossier de démonstration.
update dossiers set
  secteur_activite = coalesce(secteur_activite, 'Commerce de détail — prêt-à-porter et textile (wax, pagnes) ; deux boutiques à Abidjan')
where raison_sociale ilike '%démo%' or raison_sociale ilike '%demo%';
