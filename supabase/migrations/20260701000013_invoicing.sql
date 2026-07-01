-- =============================================================================
-- Nova Comptabilité — 0013 : Facturation de vente + Facture Normalisée (FNE)
-- =============================================================================
-- Les factures sont créées ici ; leur émission génère l'écriture comptable
-- (411 client / 70x produit / 443 TVA) et peut être certifiée FNE.
-- =============================================================================

create type invoice_status as enum ('draft', 'issued', 'paid', 'cancelled');
create type fne_status as enum ('none', 'certified', 'failed');

create table invoices (
  id              uuid primary key default gen_random_uuid(),
  dossier_id      uuid not null references dossiers(id) on delete cascade,
  number          text,
  counterparty_id uuid references counterparties(id) on delete restrict,
  client_name     text not null,
  invoice_date    date not null,
  due_date        date,
  currency        currency_code not null default 'XOF',
  status          invoice_status not null default 'draft',
  total_ht        numeric(20,4) not null default 0,
  total_tva       numeric(20,4) not null default 0,
  total_ttc       numeric(20,4) not null default 0,
  entry_id        uuid references entries(id) on delete set null,
  fne_status      fne_status not null default 'none',
  fne_reference   text,
  fne_qr          text,
  notes           text,
  created_at      timestamptz not null default now()
);

create table invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  line_no      smallint not null default 1,
  description  text not null,
  quantity     numeric(20,4) not null default 1,
  unit_price   numeric(20,4) not null default 0,
  vat_rate     numeric(7,4) not null default 0.18,
  account_code text not null default '701',
  amount_ht    numeric(20,4) not null default 0,
  amount_tva   numeric(20,4) not null default 0
);

create index idx_invoices_dossier on invoices(dossier_id, status);
create index idx_invoice_lines_invoice on invoice_lines(invoice_id);

alter table invoices enable row level security;
alter table invoice_lines enable row level security;

create policy invoices_rw on invoices for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy invoice_lines_rw on invoice_lines for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
