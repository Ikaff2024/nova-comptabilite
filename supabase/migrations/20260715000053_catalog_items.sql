-- =============================================================================
-- Nova Comptabilité — 0053 : Catalogue des articles et services
-- =============================================================================
-- Enregistrer en amont les biens/services vendus avec leur prix, leur taux de
-- TVA et leur compte de produit (classe 7). À la facturation, on choisit un
-- article du catalogue : la désignation, le prix, la TVA et l'imputation sont
-- pré-remplis (moins d'erreurs, imputation cohérente et rapide).
-- =============================================================================

create type catalog_kind as enum ('bien', 'service');

create table catalog_items (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  kind         catalog_kind not null default 'bien',
  reference    text,                                   -- code article (optionnel)
  label        text not null,                          -- désignation
  unit         text,                                   -- unité (unité, jour, heure, kg…)
  unit_price   numeric(20,4) not null default 0,       -- prix unitaire HT
  vat_rate     numeric(7,4) not null default 0.18,     -- taux de TVA
  account_code text not null default '701',            -- compte de produit (classe 7)
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create index idx_catalog_items_dossier on catalog_items(dossier_id, active);

alter table catalog_items enable row level security;
create policy catalog_items_rw on catalog_items for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
