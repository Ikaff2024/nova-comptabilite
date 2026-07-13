-- =============================================================================
-- Nova Comptabilité — 0047 : Paie RH — pointage (heures)
-- =============================================================================
-- Registre journalier des heures travaillées. Alimente la ventilation
-- automatique des heures supplémentaires du moteur (overtime.ts : jour ouvrable
-- 15/50 %, nuit 75 %, dimanche/férié 100 %). Portée dossier + RLS.
-- =============================================================================

create table payroll_time_entries (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  employee_id uuid not null references payroll_employees(id) on delete cascade,
  jour        date not null,                          -- YYYY-MM-DD
  heures_jour numeric(5,2) not null default 0,
  heures_nuit numeric(5,2) not null default 0,
  ferie       boolean not null default false,
  created_at  timestamptz not null default now()
);

create index idx_payroll_time_emp on payroll_time_entries(dossier_id, employee_id, jour);

alter table payroll_time_entries enable row level security;
create policy payroll_time_entries_rw on payroll_time_entries for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));

-- Démo : quelques jours de pointage avec heures sup et un dimanche travaillé.
do $$
declare v_dossier uuid; v_e uuid;
begin
  select id into v_dossier from dossiers where raison_sociale ilike '%démo%' or raison_sociale ilike '%demo%' order by created_at limit 1;
  if v_dossier is null then return; end if;
  select id into v_e from payroll_employees where dossier_id = v_dossier and matricule = 'EMP-002';
  if v_e is null then return; end if;
  if exists (select 1 from payroll_time_entries where dossier_id = v_dossier and employee_id = v_e) then return; end if;
  insert into payroll_time_entries(dossier_id, employee_id, jour, heures_jour, heures_nuit, ferie) values
    (v_dossier, v_e, '2026-07-13', 10, 0, false),  -- 2 h sup (jour)
    (v_dossier, v_e, '2026-07-14', 10, 0, false),
    (v_dossier, v_e, '2026-07-15', 8, 2, false),    -- 2 h de nuit → 75 %
    (v_dossier, v_e, '2026-07-19', 6, 0, false);    -- dimanche → 100 %
end $$;
