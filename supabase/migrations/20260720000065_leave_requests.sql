-- =============================================================================
-- Nova Comptabilité — 0065 : demandes de congés (workflow RH)
-- =============================================================================
-- Le module RH enregistrait les absences DÉJÀ constatées, sans circuit de
-- demande. On ajoute le workflow attendu : le salarié (ou le gestionnaire pour
-- lui) dépose une demande, un administrateur l'approuve ou la refuse.
--
-- À l'APPROBATION seulement, une ligne payroll_absences est créée : c'est elle
-- qui alimente la paie (déduction), l'absentéisme et la provision congés. Une
-- demande en attente ne doit rien impacter.
-- =============================================================================

create table payroll_leave_requests (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  employee_id uuid not null references payroll_employees(id) on delete cascade,
  type        text not null default 'conges_payes',  -- conges_payes | maladie | sans_solde | autre
  date_debut  date not null,
  date_fin    date not null,
  jours       numeric(6,2) not null default 0,
  motif       text,
  statut      text not null default 'en_attente',    -- en_attente | approuve | refuse | annule
  absence_id  uuid references payroll_absences(id) on delete set null,
  note        text,                                   -- commentaire du décideur
  created_by  uuid,
  created_at  timestamptz not null default now(),
  decided_by  uuid,
  decided_at  timestamptz,
  check (date_fin >= date_debut),
  check (type in ('conges_payes', 'maladie', 'sans_solde', 'autre')),
  check (statut in ('en_attente', 'approuve', 'refuse', 'annule'))
);

create index idx_leave_req_dossier on payroll_leave_requests(dossier_id, statut, date_debut desc);
create index idx_leave_req_employee on payroll_leave_requests(employee_id, statut);

alter table payroll_leave_requests enable row level security;
create policy payroll_leave_requests_rw on payroll_leave_requests for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));
