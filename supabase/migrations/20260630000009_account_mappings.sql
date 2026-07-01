-- =============================================================================
-- Nova Comptabilité — 0009 : Mémoire de codification (calibrage IA par l'usage)
-- =============================================================================
-- Chaque écriture validée enrichit une mémoire « libellé / tiers -> compte »
-- propre au dossier. À la capture suivante, ces correspondances sont injectées
-- dans le prompt : l'IA code comme CE cabinet. Plus on l'utilise, plus c'est
-- précis. (Brique aussi réutilisable plus tard pour le scoring.)
-- =============================================================================

create table account_mappings (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  keyword      text not null,                 -- libellé ou tiers normalisé
  account_code text not null,
  hits         integer not null default 1,    -- nb de fois confirmé
  source       text not null default 'learned', -- 'learned' | 'manual'
  updated_at   timestamptz not null default now(),
  unique (dossier_id, keyword, account_code)
);

create index idx_account_mappings_dossier on account_mappings(dossier_id, hits desc);

alter table account_mappings enable row level security;

create policy account_mappings_rw on account_mappings for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));
