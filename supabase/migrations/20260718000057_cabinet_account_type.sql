-- =============================================================================
-- Nova Comptabilité — 0057 : type de compte (cabinet vs entreprise)
-- =============================================================================
-- Nova s'ouvre aux entreprises directes (PME sans cabinet). Un compte
-- « entreprise » est un cabinet mono-dossier avec une interface dédiée
-- (atterrissage direct dans son entreprise, pas de portefeuille). Le modèle de
-- données et la sécurité (RLS) sont inchangés : seul le parcours diffère.
-- =============================================================================

alter table cabinets add column if not exists account_type text not null default 'cabinet';

alter table cabinets drop constraint if exists cabinets_account_type_chk;
alter table cabinets add constraint cabinets_account_type_chk
  check (account_type in ('cabinet', 'entreprise'));
