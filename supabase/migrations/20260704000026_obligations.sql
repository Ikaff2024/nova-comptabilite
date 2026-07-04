-- =============================================================================
-- Nova Comptabilité — 0026 : Échéancier des obligations fiscales & sociales
-- =============================================================================
-- Obligations déclaratives d'un dossier (TVA, DSF, ITS, CNPS, patente…) avec leur
-- périodicité. La prochaine échéance se calcule à la volée.
-- =============================================================================

create type obligation_periodicity as enum ('monthly', 'quarterly', 'annual');

create table obligations (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  label       text not null,
  periodicity obligation_periodicity not null default 'monthly',
  due_day     smallint not null default 15 check (due_day between 1 and 31),
  due_month   smallint check (due_month between 1 and 12),  -- pour l'annuel
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index idx_obligations_dossier on obligations(dossier_id, active);

alter table obligations enable row level security;
create policy obligations_rw on obligations for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
