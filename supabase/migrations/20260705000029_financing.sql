-- =============================================================================
-- Nova Comptabilité — 0029 : Finance embarquée — demandes d'avance de trésorerie
-- =============================================================================
-- Workflow : demande -> décision (accord/refus) -> décaissement (écriture 521/561)
-- -> remboursement (561 + intérêts / 521). Snapshot du score à la demande.
-- =============================================================================

create type financing_status as enum ('requested', 'approved', 'rejected', 'disbursed', 'repaid');

create table financing_requests (
  id                    uuid primary key default gen_random_uuid(),
  dossier_id            uuid not null references dossiers(id) on delete cascade,
  amount                numeric(20,4) not null,
  score                 smallint,
  rating                text,
  status                financing_status not null default 'requested',
  note                  text,
  disbursement_entry_id uuid references entries(id) on delete set null,
  disbursed_amount      numeric(20,4) not null default 0,
  repaid_amount         numeric(20,4) not null default 0,
  requested_by          uuid,
  requested_at          timestamptz not null default now(),
  decided_at            timestamptz,
  disbursed_at          timestamptz
);

create index idx_financing_dossier on financing_requests(dossier_id, status);

alter table financing_requests enable row level security;
create policy financing_rw on financing_requests for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
