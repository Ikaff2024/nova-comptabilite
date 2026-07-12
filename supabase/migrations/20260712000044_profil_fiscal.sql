-- =============================================================================
-- Nova Comptabilité — 0044 : Profil fiscal & légal du dossier
-- =============================================================================
-- Lexa doit connaître l'identité fiscale de l'entreprise pour se comporter en
-- comptable (régime → obligations déclaratives, forme juridique, coordonnées
-- bancaires). Les identifiants tax_id (NCC/IFU) et rccm existent déjà ; on
-- ajoute la forme juridique, le régime fiscal et le RIB.
-- =============================================================================

alter table dossiers add column if not exists forme_juridique text;  -- EI, SARL, SUARL, SA, SAS, SCI...
alter table dossiers add column if not exists regime_fiscal   text;  -- reel_normal | reel_simplifie | synthetique
alter table dossiers add column if not exists bank_name       text;  -- banque principale
alter table dossiers add column if not exists rib             text;  -- RIB / IBAN du compte principal

alter table dossiers drop constraint if exists dossiers_regime_fiscal_chk;
alter table dossiers add constraint dossiers_regime_fiscal_chk
  check (regime_fiscal is null or regime_fiscal in ('reel_normal', 'reel_simplifie', 'synthetique'));

-- Démo convaincante : profil fiscal réaliste pour le dossier de démonstration.
update dossiers set
  forme_juridique = coalesce(forme_juridique, 'SARL'),
  regime_fiscal   = coalesce(regime_fiscal, 'reel_simplifie'),
  tax_id          = coalesce(tax_id, 'CI-2021-B-045178'),
  rccm            = coalesce(rccm, 'CI-ABJ-2021-B-12345'),
  bank_name       = coalesce(bank_name, 'Ecobank Côte d''Ivoire'),
  rib             = coalesce(rib, 'CI93 CI000 01234 5678901234 56')
where raison_sociale ilike '%démo%' or raison_sociale ilike '%demo%';
