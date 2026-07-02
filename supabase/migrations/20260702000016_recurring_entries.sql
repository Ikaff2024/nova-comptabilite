-- =============================================================================
-- Nova Comptabilité — 0016 : Écritures récurrentes / abonnements
-- =============================================================================
-- Modèles d'écritures périodiques (loyer, salaires, abonnements SaaS…) générées
-- automatiquement. Le modèle est auxiliaire ; chaque échéance produit une VRAIE
-- écriture (source 'recurring'), tracée dans recurring_occurrences pour éviter
-- tout doublon (une occurrence au plus par modèle et par période).
-- =============================================================================

create type recurrence_freq as enum ('monthly', 'quarterly', 'yearly');

create table recurring_templates (
  id                uuid primary key default gen_random_uuid(),
  dossier_id        uuid not null references dossiers(id) on delete cascade,
  label             text not null,
  journal_id        uuid not null references journals(id) on delete restrict,
  frequency         recurrence_freq not null default 'monthly',
  day_of_month      smallint not null default 1 check (day_of_month between 1 and 31),
  start_date        date not null,
  end_date          date,
  counterparty_name text,
  lines             jsonb not null,   -- [{accountCode, debit, credit, label}]
  active            boolean not null default true,
  notes             text,
  created_at        timestamptz not null default now(),
  created_by        uuid
);

create table recurring_occurrences (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  template_id  uuid not null references recurring_templates(id) on delete cascade,
  period_date  date not null,
  entry_id     uuid references entries(id) on delete set null,
  posted_at    timestamptz not null default now(),
  unique (template_id, period_date)
);

create index idx_recurring_templates_dossier on recurring_templates(dossier_id, active);
create index idx_recurring_occurrences_dossier on recurring_occurrences(dossier_id);
create index idx_recurring_occurrences_template on recurring_occurrences(template_id);

alter table recurring_templates enable row level security;
alter table recurring_occurrences enable row level security;

create policy recurring_templates_rw on recurring_templates for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy recurring_occurrences_rw on recurring_occurrences for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
