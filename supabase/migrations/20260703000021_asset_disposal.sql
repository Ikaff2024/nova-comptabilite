-- =============================================================================
-- Nova Comptabilité — 0021 : Cession / sortie d'immobilisation
-- =============================================================================
-- Enregistre la cession (ou mise au rebut) d'une immobilisation : sortie de la
-- valeur brute et des amortissements, constatation du prix et de la plus/moins-
-- value (HAO). status passe à 'disposed'.
-- =============================================================================

alter table fixed_assets
  add column disposal_date      date,
  add column sale_price         numeric(20,4),
  add column plus_value         numeric(20,4),
  add column disposal_entry_id  uuid references entries(id) on delete set null;
