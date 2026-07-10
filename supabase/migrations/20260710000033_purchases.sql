-- =============================================================================
-- Nova Comptabilité — 0033 : Cycle achats fournisseurs
-- =============================================================================
-- Factures fournisseurs (symétrique des ventes). La comptabilisation génère
-- l'écriture 60x/2x (débit) + 4452 TVA déductible (débit) / 401 fournisseur
-- (crédit) dans le journal AC. Le règlement génère 401 (débit) / trésorerie
-- (crédit) et lettre le compte fournisseur. Ancienneté = 40x crédit non lettré.
-- =============================================================================

create type purchase_status as enum ('draft', 'recorded', 'paid', 'cancelled');

create table purchase_invoices (
  id               uuid primary key default gen_random_uuid(),
  dossier_id       uuid not null references dossiers(id) on delete cascade,
  supplier_name    text not null,
  counterparty_id  uuid references counterparties(id) on delete restrict,
  supplier_ref     text,                         -- n° de facture du fournisseur
  invoice_date     date not null,
  due_date         date,
  currency         currency_code not null default 'XOF',
  status           purchase_status not null default 'draft',
  total_ht         numeric(20,4) not null default 0,
  total_tva        numeric(20,4) not null default 0,
  total_ttc        numeric(20,4) not null default 0,
  entry_id         uuid references entries(id) on delete set null,   -- écriture d'achat
  payment_entry_id uuid references entries(id) on delete set null,   -- écriture de règlement
  notes            text,
  created_at       timestamptz not null default now()
);

create table purchase_invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  purchase_id   uuid not null references purchase_invoices(id) on delete cascade,
  dossier_id    uuid not null references dossiers(id) on delete cascade,
  line_no       smallint not null default 1,
  description   text not null,
  account_code  text not null default '601',     -- compte de charge/immobilisation
  analytic_axis text,                             -- section analytique (optionnel)
  amount_ht     numeric(20,4) not null default 0,
  vat_rate      numeric(7,4) not null default 0.18,
  amount_tva    numeric(20,4) not null default 0
);

create index idx_purchase_invoices_dossier on purchase_invoices(dossier_id, status);
create index idx_purchase_invoice_lines_purchase on purchase_invoice_lines(purchase_id);

alter table purchase_invoices enable row level security;
alter table purchase_invoice_lines enable row level security;

create policy purchase_invoices_rw on purchase_invoices for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy purchase_invoice_lines_rw on purchase_invoice_lines for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
