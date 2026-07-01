-- =============================================================================
-- Nova Comptabilité — 0011 : Rapprochement bancaire (pointage)
-- =============================================================================
-- Le pointage marque les écritures d'un compte de trésorerie (521…) qui figurent
-- sur le relevé bancaire. Comme les écritures sont IMMUABLES, le pointage est
-- stocké à part. L'état de rapprochement compare le solde pointé au solde relevé.
-- =============================================================================

create table bank_pointings (
  id            uuid primary key default gen_random_uuid(),
  dossier_id    uuid not null references dossiers(id) on delete cascade,
  account_id    uuid not null references accounts(id) on delete restrict,
  entry_line_id uuid not null references entry_lines(id) on delete restrict,
  pointed_at    timestamptz not null default now(),
  unique (entry_line_id)
);

create index idx_bank_pointings_account on bank_pointings(dossier_id, account_id);

alter table bank_pointings enable row level security;

create policy bank_pointings_rw on bank_pointings for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));
