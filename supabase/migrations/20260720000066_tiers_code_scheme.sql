-- =============================================================================
-- Nova Comptabilité — 0066 : schéma de numérotation des comptes tiers
-- =============================================================================
-- La génération automatique du code auxiliaire d'un tiers était figée
-- (collectif + numéro séquentiel, ex. 4110001). On laisse l'entreprise choisir :
--   • 'numerique'      -> 4110001 (défaut, comportement inchangé)
--   • 'alphanumerique' -> 411SOTRA (dérivé du nom, plus lisible)
-- =============================================================================

alter table dossiers add column if not exists tiers_code_scheme text not null default 'numerique';
alter table dossiers drop constraint if exists dossiers_tiers_code_scheme_chk;
alter table dossiers add constraint dossiers_tiers_code_scheme_chk
  check (tiers_code_scheme in ('numerique', 'alphanumerique'));
