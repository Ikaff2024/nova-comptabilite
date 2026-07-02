-- =============================================================================
-- Nova Comptabilité — 0014 : Immobilisations & amortissements
-- =============================================================================
-- Le registre des immobilisations et le plan d'amortissement sont des données
-- AUXILIAIRES (comme le lettrage) : ils ne modifient pas le ledger immuable.
-- Chaque dotation périodique génère une VRAIE écriture (681 -> 28x), tracée ici
-- pour éviter toute double dotation sur un même exercice.
-- =============================================================================

create type depreciation_method as enum ('linear');  -- dégressif/exceptionnel : évolution future

create table fixed_assets (
  id                   uuid primary key default gen_random_uuid(),
  dossier_id           uuid not null references dossiers(id) on delete cascade,
  label                text not null,
  asset_account_code   text not null,               -- immobilisation (classe 2)
  amort_account_code   text not null,               -- amortissements (classe 28)
  expense_account_code text not null default '6813', -- dotation (classe 68)
  acquisition_date     date not null,
  commissioning_date   date not null,               -- mise en service (début de l'amortissement)
  amount               numeric(20,4) not null,       -- valeur d'origine (base + valeur résiduelle)
  residual_value       numeric(20,4) not null default 0,
  duration_years       numeric(6,2) not null,        -- durée d'utilité
  method               depreciation_method not null default 'linear',
  counterparty_id      uuid references counterparties(id) on delete set null,
  notes                text,
  status               text not null default 'active',  -- active | disposed
  created_at           timestamptz not null default now(),
  created_by           uuid,
  check (amount >= 0 and residual_value >= 0 and residual_value <= amount and duration_years > 0)
);

create table fixed_asset_depreciations (
  id             uuid primary key default gen_random_uuid(),
  dossier_id     uuid not null references dossiers(id) on delete cascade,
  fixed_asset_id uuid not null references fixed_assets(id) on delete cascade,
  fiscal_year_id uuid references fiscal_years(id) on delete set null,
  period_year    smallint not null,                 -- exercice (année) de la dotation
  amount         numeric(20,4) not null,
  entry_id       uuid references entries(id) on delete set null,  -- écriture générée (681 -> 28x)
  posted_at      timestamptz not null default now(),
  unique (fixed_asset_id, period_year)              -- une seule dotation par immo et par exercice
);

create index idx_fixed_assets_dossier on fixed_assets(dossier_id, status);
create index idx_fa_dep_dossier on fixed_asset_depreciations(dossier_id);
create index idx_fa_dep_asset on fixed_asset_depreciations(fixed_asset_id);

alter table fixed_assets enable row level security;
alter table fixed_asset_depreciations enable row level security;

create policy fixed_assets_rw on fixed_assets for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy fa_dep_rw on fixed_asset_depreciations for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
