-- =============================================================================
-- Nova Comptabilité — 0048 : Email des tiers (pour la relance par mail)
-- =============================================================================
-- Permet à Lexa d'envoyer les relances (individuelles ou groupées) directement
-- aux clients dont l'adresse email est renseignée.
-- =============================================================================

alter table counterparties add column if not exists email text;
