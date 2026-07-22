-- =============================================================================
-- Nova Comptabilité — 0067 : modèle de document de facturation
-- =============================================================================
-- Chaque facture / devis / avoir mémorise le MODÈLE de mise en forme choisi
-- par l'utilisateur, selon la nature de l'opération :
--   'standard' : gabarit générique (défaut, rétro-compatible)
--   'goods'    : vente de biens  (tableau d'articles + modalités de livraison)
--   'services' : prestation de services (livrables + modalités d'exécution)
-- Le modèle est purement présentation (impression) ; il n'affecte pas la
-- comptabilisation. Il est recopié lors des conversions (devis→facture, avoir).
-- =============================================================================

alter table invoices add column if not exists template text not null default 'standard';
