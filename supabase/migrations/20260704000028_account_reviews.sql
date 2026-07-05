-- =============================================================================
-- Nova Comptabilité — 0028 : Dossier de révision (justification des comptes)
-- =============================================================================
-- Suivi de révision par compte et par exercice : statut (à réviser / justifié) et
-- note de justification. Aide le cabinet à boucler son dossier de travail.
-- =============================================================================

create table account_reviews (
  id             uuid primary key default gen_random_uuid(),
  dossier_id     uuid not null references dossiers(id) on delete cascade,
  fiscal_year_id uuid not null references fiscal_years(id) on delete cascade,
  account_code   text not null,
  status         text not null default 'todo',   -- 'todo' | 'reviewed'
  note           text,
  reviewed_at    timestamptz,
  reviewed_by    uuid,
  unique (dossier_id, fiscal_year_id, account_code)
);

create index idx_account_reviews_dossier on account_reviews(dossier_id, fiscal_year_id);

alter table account_reviews enable row level security;
create policy account_reviews_rw on account_reviews for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
