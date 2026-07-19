-- =============================================================================
-- Nova Comptabilité — 0062 : besoin de financement (dossier bancaire)
-- =============================================================================
-- Paramètres du dossier de financement préparé pour une banque : montant, objet,
-- durée, taux indicatif, garanties, engagements en cours. Stockés sur le dossier
-- (un brouillon courant par entreprise) — la RLS du dossier s'applique déjà.
--
-- NB : distinct de financing_requests (avance de trésorerie interne, finance
-- embarquée). Ici, Nova ne prête rien : il PRODUIT un dossier que le dirigeant
-- dépose lui-même auprès de SA banque.
-- =============================================================================

alter table dossiers add column if not exists financing_brief jsonb not null default '{}'::jsonb;
