-- =============================================================================
-- Nova Comptabilité — 0019 : Relances clients
-- =============================================================================
-- Historique des relances envoyées à un tiers (client). Le niveau s'incrémente à
-- chaque relance (1re, 2e, 3e…). Données auxiliaires — n'affectent pas le ledger.
-- =============================================================================

create table relances (
  id              uuid primary key default gen_random_uuid(),
  dossier_id      uuid not null references dossiers(id) on delete cascade,
  counterparty_id uuid not null references counterparties(id) on delete cascade,
  level           smallint not null default 1,
  amount          numeric(20,4) not null default 0,
  as_of           date not null,
  note            text,
  sent_at         timestamptz not null default now(),
  created_by      uuid
);

create index idx_relances_dossier on relances(dossier_id, counterparty_id, sent_at desc);

alter table relances enable row level security;
create policy relances_rw on relances for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
