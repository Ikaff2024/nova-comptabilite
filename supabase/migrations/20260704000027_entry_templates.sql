-- =============================================================================
-- Nova Comptabilité — 0027 : Modèles de saisie
-- =============================================================================
-- Gabarits d'écriture réutilisables (comptes + libellés, montants optionnels)
-- pour accélérer la saisie manuelle. Sans planification (≠ écritures récurrentes).
-- =============================================================================

create table entry_templates (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  name         text not null,
  journal_code text,
  lines        jsonb not null,   -- [{accountCode, label, debit, credit}]
  created_at   timestamptz not null default now()
);

create index idx_entry_templates_dossier on entry_templates(dossier_id);

alter table entry_templates enable row level security;
create policy entry_templates_rw on entry_templates for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
