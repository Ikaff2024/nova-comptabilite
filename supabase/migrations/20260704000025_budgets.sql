-- =============================================================================
-- Nova Comptabilité — 0025 : Budgets (suivi budget / réalisé)
-- =============================================================================
-- Montant budgété par compte et par exercice (surtout classes 6 et 7). Le
-- réalisé se lit dans les écritures ; l'écart se calcule à la volée.
-- =============================================================================

create table budgets (
  id             uuid primary key default gen_random_uuid(),
  dossier_id     uuid not null references dossiers(id) on delete cascade,
  fiscal_year_id uuid not null references fiscal_years(id) on delete cascade,
  account_code   text not null,
  amount         numeric(20,4) not null default 0,
  updated_at     timestamptz not null default now(),
  unique (dossier_id, fiscal_year_id, account_code)
);

create index idx_budgets_dossier on budgets(dossier_id, fiscal_year_id);

alter table budgets enable row level security;
create policy budgets_rw on budgets for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
