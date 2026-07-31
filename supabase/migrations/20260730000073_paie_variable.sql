-- =============================================================================
-- Nova Comptabilité — 0073 : rémunération variable et vendeur sur la facture
-- =============================================================================
-- Trois manques comblés d'un coup, parce qu'ils tiennent au même besoin : payer
-- autrement qu'au forfait mensuel.
--
--  1. Le pointage n'avait aucune contrainte d'unicité : réimporter un mois
--     doublait les heures, en silence. On dédoublonne puis on verrouille.
--  2. La rémunération à la TÂCHE et la COMMISSION n'existaient pas. Elles se
--     tapaient en « prime exceptionnelle », ce qui perd la base de calcul :
--     ni justification sur le bulletin, ni recalcul possible.
--  3. La facture ne portait pas de VENDEUR. Sans lui, aucune commission sur le
--     chiffre d'affaires ne peut être justifiée facture par facture.
-- =============================================================================

-- --- 1. Pointage : un salarié, un jour, une ligne ---------------------------
-- Dédoublonnage préalable : on garde la ligne la plus récente pour chaque
-- couple (salarié, jour). Sans cela l'index unique refuserait de se créer sur
-- une base déjà alimentée.
delete from payroll_time_entries t
 using payroll_time_entries plus_recent
 where t.dossier_id = plus_recent.dossier_id
   and t.employee_id = plus_recent.employee_id
   and t.jour = plus_recent.jour
   and t.created_at < plus_recent.created_at;

create unique index if not exists payroll_time_entries_unique
  on payroll_time_entries(dossier_id, employee_id, jour);

-- --- 2. Éléments de rémunération variable du mois ---------------------------
-- Une ligne = un élément justifiable. Le MONTANT est stocké, mais il reste une
-- donnée dérivée : c'est la base (quantité × prix unitaire, ou taux × assiette)
-- qui fait foi et qui s'imprime sur le bulletin. Un montant sans sa base n'est
-- pas vérifiable, et c'est précisément ce qu'on reproche à la saisie en prime.
create table payroll_variable_pay (
  id             uuid primary key default gen_random_uuid(),
  dossier_id     uuid not null references dossiers(id) on delete cascade,
  employee_id    uuid not null references payroll_employees(id) on delete cascade,
  period_year    int  not null,
  period_month   int  not null check (period_month between 0 and 11),  -- 0 = janvier
  type           text not null check (type in ('tache', 'commission')),
  libelle        text not null,

  -- Rémunération à la tâche
  quantite       numeric(14,3),
  prix_unitaire  numeric(20,4),

  -- Commission sur chiffre d'affaires
  taux           numeric(7,4),                                   -- en %, ex. 3.5
  assiette       numeric(20,4),                                  -- CA retenu
  base_ca        text check (base_ca in ('facture', 'encaisse')), -- CA facturé ou encaissé
  periode_debut  date,
  periode_fin    date,

  montant        numeric(20,4) not null default 0,
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid,

  -- Chaque type porte sa base : une tâche sans quantité ni prix unitaire, ou
  -- une commission sans taux, redeviendrait le montant opaque qu'on veut éviter.
  check (type <> 'tache' or (quantite is not null and prix_unitaire is not null)),
  check (type <> 'commission' or taux is not null)
);

create index idx_payroll_variable_pay on payroll_variable_pay(dossier_id, period_year, period_month);
create index idx_payroll_variable_pay_emp on payroll_variable_pay(dossier_id, employee_id);

alter table payroll_variable_pay enable row level security;
create policy payroll_variable_pay_rw on payroll_variable_pay for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));

-- --- 3. Vendeur de la facture ------------------------------------------------
-- Le vendeur appartient au DOCUMENT, pas à la ligne d'écriture. Une commission
-- se calcule net des avoirs, et le lien avoir → facture d'origine n'existe qu'au
-- niveau du document. La justification attendue sur un bulletin est d'ailleurs
-- la liste des factures, pas une somme.
alter table invoices add column if not exists vendeur_id uuid references payroll_employees(id) on delete set null;
create index if not exists idx_invoices_vendeur on invoices(dossier_id, vendeur_id);
