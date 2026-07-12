-- =============================================================================
-- Nova Comptabilité — 0046 : Paie RH (absences + avances/prêts)
-- =============================================================================
-- Registres qui alimentent le moteur de paie porté d'Ivoire_Paie :
--  - absences NON payées → dérivent `joursAbsence` du mois (unpaidAbsenceDaysInMonth)
--  - avances/prêts → dérivent `remboursementAvance` du mois (advanceDeductionForMonth)
-- Échéancier déterministe : aucun « restant dû » mutable à maintenir.
-- Portée dossier + RLS, aligné sur payroll_employees.
-- =============================================================================

create table payroll_absences (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  employee_id uuid not null references payroll_employees(id) on delete cascade,
  date_debut  date not null,
  date_fin    date not null,
  jours       numeric(6,2) not null default 0,       -- jours ouvrables (indicatif)
  justifiee   boolean not null default false,
  paye        boolean not null default false,         -- true → maintenue au salaire
  motif       text,
  created_at  timestamptz not null default now()
);

create table payroll_advances (
  id            uuid primary key default gen_random_uuid(),
  dossier_id    uuid not null references dossiers(id) on delete cascade,
  employee_id   uuid not null references payroll_employees(id) on delete cascade,
  type          text not null default 'avance' check (type in ('avance', 'pret')),
  montant_total numeric(20,2) not null,
  mensualite    numeric(20,2) not null,
  start_year    integer not null,
  start_month   integer not null,                      -- 0 (janvier) .. 11 (décembre)
  motif         text,
  created_at    timestamptz not null default now()
);

create index idx_payroll_absences_emp on payroll_absences(dossier_id, employee_id);
create index idx_payroll_advances_emp on payroll_advances(dossier_id, employee_id);

alter table payroll_absences enable row level security;
alter table payroll_advances enable row level security;

create policy payroll_absences_rw on payroll_absences for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy payroll_advances_rw on payroll_advances for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));

-- Démo convaincante : 2 salariés + 1 absence non payée + 1 prêt (idempotent).
do $$
declare v_dossier uuid; v_e1 uuid; v_e2 uuid;
begin
  select id into v_dossier from dossiers where raison_sociale ilike '%démo%' or raison_sociale ilike '%demo%' order by created_at limit 1;
  if v_dossier is null then return; end if;

  insert into payroll_employees(dossier_id, matricule, nom, prenoms, poste, categorie, statut_matrimonial, nombre_enfants, nombre_parts_igr, date_embauche, salaire_base, sursalaire, indemnite_transport)
  values (v_dossier, 'EMP-001', 'Koné', 'Awa', 'Comptable', 'Agent de Maitrise', 'Marie(e)', 2, 2.5, '2022-03-01', 180000, 20000, 30000)
  on conflict (dossier_id, matricule) do nothing;
  insert into payroll_employees(dossier_id, matricule, nom, prenoms, poste, categorie, statut_matrimonial, nombre_enfants, nombre_parts_igr, date_embauche, salaire_base, indemnite_transport)
  values (v_dossier, 'EMP-002', 'Traoré', 'Ibrahim', 'Magasinier', 'Ouvrier', 'Celibataire', 0, 1, '2023-06-15', 90000, 25000)
  on conflict (dossier_id, matricule) do nothing;

  select id into v_e1 from payroll_employees where dossier_id = v_dossier and matricule = 'EMP-001';
  select id into v_e2 from payroll_employees where dossier_id = v_dossier and matricule = 'EMP-002';

  insert into payroll_absences(dossier_id, employee_id, date_debut, date_fin, jours, justifiee, paye, motif)
  select v_dossier, v_e2, '2026-07-07', '2026-07-08', 2, false, false, 'Absence non justifiée'
  where v_e2 is not null and not exists (select 1 from payroll_absences where dossier_id = v_dossier and employee_id = v_e2);

  insert into payroll_advances(dossier_id, employee_id, type, montant_total, mensualite, start_year, start_month, motif)
  select v_dossier, v_e1, 'pret', 300000, 50000, 2026, 6, 'Prêt scolarité'
  where v_e1 is not null and not exists (select 1 from payroll_advances where dossier_id = v_dossier and employee_id = v_e1);
end $$;
