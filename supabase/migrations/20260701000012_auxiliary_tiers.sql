-- =============================================================================
-- Nova Comptabilité — 0012 : Comptabilité auxiliaire des tiers
-- =============================================================================
-- Chaque client/fournisseur = un compte auxiliaire (aux_code) rattaché à son
-- compte collectif (411 clients, 401 fournisseurs). Les lignes d'écriture sur
-- ces comptes portent counterparty_id (déjà présent) -> balance & grand livre
-- auxiliaires. Les tiers sont créés à la volée depuis le nom capturé.
-- =============================================================================

alter table counterparties add column if not exists aux_code text;

create unique index if not exists uq_counterparties_aux
  on counterparties(dossier_id, aux_code) where aux_code is not null;

create index if not exists idx_counterparties_type on counterparties(dossier_id, type);
