-- =============================================================================
-- Nova Comptabilité — 0041 : Mémoire de Lexa (auto-apprentissage par dossier)
-- =============================================================================
-- Faits durables que Lexa retient sur l'entreprise : préférences, spécificités,
-- corrections. Injectés (en contexte) dans son prompt pour qu'elle s'adapte et
-- s'améliore au fil du temps. Portée dossier + RLS.
-- =============================================================================

create table lexa_memory (
  id         uuid primary key default gen_random_uuid(),
  dossier_id uuid not null references dossiers(id) on delete cascade,
  content    text not null,
  source     text not null default 'lexa',   -- 'lexa' (apprise) | 'user' (dictée)
  created_at timestamptz not null default now()
);

create index idx_lexa_memory_dossier on lexa_memory(dossier_id, created_at desc);

alter table lexa_memory enable row level security;
create policy lexa_memory_rw on lexa_memory for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
