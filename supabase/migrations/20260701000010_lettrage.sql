-- =============================================================================
-- Nova Comptabilité — 0010 : Lettrage des comptes de tiers
-- =============================================================================
-- Le lettrage rapproche des mouvements qui s'annulent (facture ↔ règlement) sur
-- un compte de tiers (401, 411…). Les écritures étant IMMUABLES, on n'ajoute pas
-- de colonne sur entry_lines : le lettrage vit dans des tables dédiées.
-- Un groupe lettré doit être équilibré (somme débits = somme crédits).
-- =============================================================================

create table lettrages (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete restrict,
  code        text not null,                 -- lettre A, B, … par compte
  created_at  timestamptz not null default now(),
  created_by  uuid
);

create table lettrage_lines (
  lettrage_id   uuid not null references lettrages(id) on delete cascade,
  entry_line_id uuid not null references entry_lines(id) on delete restrict,
  dossier_id    uuid not null references dossiers(id) on delete cascade, -- pour RLS
  primary key (lettrage_id, entry_line_id),
  unique (entry_line_id)                      -- une ligne dans au plus un lettrage
);

create index idx_lettrages_account on lettrages(dossier_id, account_id);
create index idx_lettrage_lines_line on lettrage_lines(entry_line_id);

alter table lettrages enable row level security;
alter table lettrage_lines enable row level security;

create policy lettrages_rw on lettrages for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

create policy lettrage_lines_rw on lettrage_lines for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));
