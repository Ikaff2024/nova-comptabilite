-- =============================================================================
-- À exécuter UNE FOIS sur la base de PRODUCTION avec un rôle PROPRIÉTAIRE/ADMIN
-- (ex. onglet « Query » du service Postgres sur Railway, ou psql avec l'URL admin).
-- Le rôle applicatif runtime n'a pas les droits de création de table : ce script
-- crée les tables manquantes (catalogue + clôtures) et les enregistre comme
-- migrations appliquées. Idempotent : peut être relancé sans risque.
-- =============================================================================

-- 0053 — Catalogue des articles et services -----------------------------------
do $$ begin
  create type catalog_kind as enum ('bien', 'service');
exception when duplicate_object then null; end $$;

create table if not exists catalog_items (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  kind         catalog_kind not null default 'bien',
  reference    text,
  label        text not null,
  unit         text,
  unit_price   numeric(20,4) not null default 0,
  vat_rate     numeric(7,4) not null default 0.18,
  account_code text not null default '701',
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists idx_catalog_items_dossier on catalog_items(dossier_id, active);
alter table catalog_items enable row level security;
do $$ begin
  create policy catalog_items_rw on catalog_items for all
    using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
exception when duplicate_object then null; end $$;

-- 0054 — Clôtures mensuelles --------------------------------------------------
create table if not exists period_closures (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  year        smallint not null,
  month       smallint not null check (month between 1 and 12),
  closed_at   timestamptz not null default now(),
  closed_by   uuid,
  unique (dossier_id, year, month)
);
create index if not exists idx_period_closures_dossier on period_closures(dossier_id, year, month);
alter table period_closures enable row level security;
do $$ begin
  create policy period_closures_rw on period_closures for all
    using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
exception when duplicate_object then null; end $$;

-- 0056 — Decision Ledger (journal de preuves de Lexa : AQM / explicabilité) ----
create table if not exists decision_ledger (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  user_id      uuid,
  created_at   timestamptz not null default now(),
  question     text,
  mode         text,
  model        text,
  answer       text,
  tools        jsonb not null default '[]'::jsonb,
  validations  jsonb not null default '[]'::jsonb,
  confidence   smallint,
  tokens_in    integer,
  tokens_out   integer
);
create index if not exists idx_decision_ledger_dossier on decision_ledger(dossier_id, created_at desc);
alter table decision_ledger enable row level security;
do $$ begin
  create policy decision_ledger_rw on decision_ledger for all
    using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
exception when duplicate_object then null; end $$;

-- Marque ces migrations (et la 0052 neutralisée) comme appliquées -------------
create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now());
insert into _migrations(name) values
  ('20260715000052_secteur_activite.sql'),
  ('20260715000053_catalog_items.sql'),
  ('20260715000054_period_closures.sql'),
  ('20260716000055_voice_xai.sql'),
  ('20260718000056_decision_ledger.sql')
on conflict do nothing;
