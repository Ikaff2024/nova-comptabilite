-- =============================================================================
-- Nova Comptabilité — 0017 : Conservation des pièces justificatives (GED)
-- =============================================================================
-- Les scans (factures, reçus) sont conservés — obligation de conservation +
-- piste d'audit. Deux stockages possibles, transparents pour l'app :
--   • 'db' : octets en base (document_blobs) — défaut, marche sans infra externe.
--   • 'r2' : objet dans Cloudflare R2 (S3-compatible) — activé par variables d'env.
-- La colonne entries.document_url pointe vers GET /documents/:id.
-- =============================================================================

create table documents (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  entry_id    uuid references entries(id) on delete set null,
  filename    text,
  mime_type   text not null,
  size_bytes  integer not null default 0,
  storage     text not null default 'db',   -- 'db' | 'r2'
  storage_key text,                          -- clé objet R2 (si storage='r2')
  created_at  timestamptz not null default now(),
  created_by  uuid
);

create table document_blobs (
  document_id uuid primary key references documents(id) on delete cascade,
  dossier_id  uuid not null references dossiers(id) on delete cascade,  -- pour RLS
  data        bytea not null
);

create index idx_documents_dossier on documents(dossier_id, created_at desc);
create index idx_documents_entry on documents(entry_id);

alter table documents enable row level security;
alter table document_blobs enable row level security;

create policy documents_rw on documents for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
create policy document_blobs_rw on document_blobs for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
