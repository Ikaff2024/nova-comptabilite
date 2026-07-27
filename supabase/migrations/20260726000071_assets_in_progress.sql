-- =============================================================================
-- Nova Comptabilité — 0071 : immobilisations produites en interne (en cours)
-- =============================================================================
-- Une entreprise qui construit quelque chose pour elle-même — un logiciel, un
-- agencement, un bâtiment — engage des charges par nature (salaires 66, services
-- extérieurs 62…) qui ne doivent pas rester en charges de l'exercice : elles
-- constituent un actif. Le SYSCOHADA les neutralise par le compte 72
-- « Production immobilisée » et les accumule en compte d'en-cours (219 / 239),
-- puis les vire au compte définitif à la mise en service, qui ouvre
-- l'amortissement.
--
-- Nova ne savait pas produire ces écritures : elles se passaient à la main en
-- OD. Cette table suit le chantier de bout en bout et garde le lien avec les
-- écritures produites, pour que le cumul soit toujours justifiable.
--
-- Rappel de fond porté par le module : seule la phase de DÉVELOPPEMENT est
-- capitalisable, la recherche reste en charges. Et on ne capitalise que des
-- coûts réellement enregistrés — du temps non rémunéré ne s'immobilise pas.
-- =============================================================================

create table assets_in_progress (
  id                   uuid primary key default gen_random_uuid(),
  dossier_id           uuid not null references dossiers(id) on delete cascade,
  label                text not null,
  wip_account_code     text not null,              -- en-cours : 2191, 2193, 2391…
  target_account_code  text not null,              -- définitif à la mise en service : 211, 212, 231…
  production_account_code text not null default '721', -- production immobilisée : 721 / 722
  analytic_section     text,                       -- section analytique qui porte les coûts
  started_on           date not null,
  commissioned_on      date,                       -- null tant que le chantier est ouvert
  fixed_asset_id       uuid references fixed_assets(id) on delete set null,
  notes                text,
  created_at           timestamptz not null default now(),
  created_by           uuid
);

-- Chaque capitalisation passée, avec son écriture : le cumul d'un chantier est
-- la somme de ses capitalisations, et chacune reste rattachée à sa pièce.
create table assets_in_progress_costs (
  id                   uuid primary key default gen_random_uuid(),
  dossier_id           uuid not null references dossiers(id) on delete cascade,
  wip_id               uuid not null references assets_in_progress(id) on delete cascade,
  entry_id             uuid references entries(id) on delete set null,
  amount               numeric(20,4) not null check (amount > 0),
  period_from          date,
  period_to            date,
  note                 text,
  created_at           timestamptz not null default now()
);

create index assets_in_progress_dossier_idx on assets_in_progress(dossier_id);
create index aip_costs_wip_idx on assets_in_progress_costs(wip_id);

alter table assets_in_progress enable row level security;
alter table assets_in_progress_costs enable row level security;

create policy aip_rw on assets_in_progress for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy aip_costs_rw on assets_in_progress_costs for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
