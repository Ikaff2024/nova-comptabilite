-- =============================================================================
-- Nova Comptabilité — 0040 : Paie (salariés + bulletins)
-- =============================================================================
-- Portée dossier + RLS. Les salariés alimentent le moteur de paie porté
-- (server/payroll/core). Chaque bulletin stocke les variables du mois et le
-- résultat calculé (jsonb) ; sa comptabilisation (OD de paie) est rattachée
-- via entry_id. Enums libres (text) — alignés sur les types du moteur.
-- =============================================================================

create table payroll_employees (
  id                    uuid primary key default gen_random_uuid(),
  dossier_id            uuid not null references dossiers(id) on delete cascade,
  matricule             text not null,
  nom                   text not null,
  prenoms               text not null,
  date_naissance        date,
  date_embauche         date not null,
  poste                 text,
  categorie             text not null default 'Employe',       -- Ouvrier|Employe|Agent de Maitrise|Cadre
  statut_matrimonial    text not null default 'Celibataire',
  nombre_enfants        integer not null default 0,
  nombre_parts_igr      numeric(4,1) not null default 1,
  salaire_base          numeric(20,2) not null default 0,
  sursalaire            numeric(20,2) not null default 0,
  indemnite_transport   numeric(20,2) not null default 0,
  indemnite_logement    numeric(20,2) not null default 0,
  autres_primes         numeric(20,2) not null default 0,
  email                 text,
  telephone             text,
  type_contrat          text,
  date_fin_contrat      date,
  convention_collective text,
  mode_paiement         text,
  rib                   text,
  banque                text,
  mobile_money_numero   text,
  mobile_money_operateur text,
  actif                 boolean not null default true,
  created_at            timestamptz not null default now(),
  unique (dossier_id, matricule)
);

create table payroll_payslips (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  employee_id  uuid not null references payroll_employees(id) on delete cascade,
  period_year  integer not null,
  period_month integer not null,                 -- 0 (janvier) .. 11 (décembre), aligné sur le moteur
  variables    jsonb not null,
  calculation  jsonb not null,
  entry_id     uuid references entries(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (dossier_id, employee_id, period_year, period_month)
);

create index idx_payroll_employees_dossier on payroll_employees(dossier_id);
create index idx_payroll_payslips_period on payroll_payslips(dossier_id, period_year, period_month);

alter table payroll_employees enable row level security;
alter table payroll_payslips enable row level security;

create policy payroll_employees_rw on payroll_employees for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy payroll_payslips_rw on payroll_payslips for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
