-- =============================================================================
-- Nova Comptabilité — 0023 : Comptabilité analytique (sections de coût)
-- =============================================================================
-- Sections analytiques (centres de coût / axes) d'un dossier. Les écritures sont
-- ventilées via entry_lines.analytic_axis (code de section). Le résultat
-- analytique se calcule par section sur les classes 6 et 7.
-- =============================================================================

create table analytic_sections (
  id         uuid primary key default gen_random_uuid(),
  dossier_id uuid not null references dossiers(id) on delete cascade,
  code       text not null,
  label      text not null,
  created_at timestamptz not null default now(),
  unique (dossier_id, code)
);

create index idx_analytic_sections_dossier on analytic_sections(dossier_id);

alter table analytic_sections enable row level security;
create policy analytic_sections_rw on analytic_sections for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
