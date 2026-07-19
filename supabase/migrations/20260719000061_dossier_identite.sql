-- =============================================================================
-- Nova Comptabilité — 0061 : identité complète de l'entreprise (fiche dossier)
-- =============================================================================
-- Le dossier portait déjà tax_id / rccm / forme_juridique / regime_fiscal /
-- bank_name / rib, mais il manquait les coordonnées et le n° employeur CNPS —
-- indispensables à l'en-tête des bulletins de paie, aux attestations et aux
-- courriers officiels. On complète la fiche.
-- =============================================================================

alter table dossiers add column if not exists adresse     text;  -- siège / adresse postale
alter table dossiers add column if not exists ville       text;  -- ville (liasse, attestations)
alter table dossiers add column if not exists telephone   text;  -- contact employeur
alter table dossiers add column if not exists numero_cnps text;  -- n° employeur CNPS
