-- =============================================================================
-- Nova Comptabilité — 0054 : Clôtures mensuelles (verrouillage de période)
-- =============================================================================
-- Clôturer un mois interdit toute nouvelle écriture dont la date tombe dans ce
-- mois (ou un mois antérieur). Le contrôle applicatif est dans postEntry ; cette
-- table matérialise les périodes clôturées. Réouverture = suppression de la
-- ligne du mois (on ne peut rouvrir que le dernier mois clôturé).
-- =============================================================================

create table period_closures (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  year        smallint not null,
  month       smallint not null check (month between 1 and 12),
  closed_at   timestamptz not null default now(),
  closed_by   uuid,
  unique (dossier_id, year, month)
);

create index idx_period_closures_dossier on period_closures(dossier_id, year, month);

alter table period_closures enable row level security;
create policy period_closures_rw on period_closures for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
