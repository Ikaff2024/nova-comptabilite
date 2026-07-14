-- =============================================================================
-- Nova Comptabilité — 0049 : Factures de vente récurrentes (abonnements)
-- =============================================================================
-- Modèles de factures de vente répétées (abonnements, forfaits mensuels) qui
-- génèrent, à chaque échéance, une FACTURE BROUILLON (à émettre par l'humain).
-- Distinct des écritures récurrentes (OD). Portée dossier + RLS.
-- =============================================================================

create table recurring_invoice_templates (
  id            uuid primary key default gen_random_uuid(),
  dossier_id    uuid not null references dossiers(id) on delete cascade,
  label         text not null,
  client_name   text not null,
  lines         jsonb not null,                 -- [{description, quantity, unit_price, vat_rate, account_code}]
  frequency     text not null default 'monthly' check (frequency in ('monthly', 'quarterly', 'yearly')),
  day_of_month  integer not null default 1,
  start_date    date not null,
  end_date      date,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table recurring_invoice_occurrences (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  template_id uuid not null references recurring_invoice_templates(id) on delete cascade,
  period_date date not null,
  invoice_id  uuid,
  created_at  timestamptz not null default now(),
  unique (template_id, period_date)
);

create index idx_recinv_templates_dossier on recurring_invoice_templates(dossier_id);
create index idx_recinv_occ_template on recurring_invoice_occurrences(template_id);

alter table recurring_invoice_templates enable row level security;
alter table recurring_invoice_occurrences enable row level security;
create policy recinv_templates_rw on recurring_invoice_templates for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy recinv_occ_rw on recurring_invoice_occurrences for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
