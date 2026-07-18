-- =============================================================================
-- Nova Comptabilité — 0056 : Decision Ledger (journal de preuves de Lexa)
-- =============================================================================
-- Chaque décision importante de Lexa est enregistrée comme une « preuve »
-- traçable et vérifiable : question de l'utilisateur, palier, modèle, outils
-- appelés (avec succès/échec), contrôles AQM rencontrés, score de confiance
-- déterministe et réponse finale. Support de l'explicabilité (« Pourquoi ? »)
-- et des audits (expert-comptable, commissaire aux comptes, DAF).
-- Append-only côté applicatif (aucune mise à jour). Résilient : le code sait
-- fonctionner si cette table n'existe pas encore (schema-cache).
-- =============================================================================

create table decision_ledger (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  user_id      uuid,
  created_at   timestamptz not null default now(),
  question     text,
  mode         text,
  model        text,
  answer       text,
  tools        jsonb not null default '[]'::jsonb,  -- [{name, ok, verdict?}]
  validations  jsonb not null default '[]'::jsonb,  -- rapports AQM rencontrés
  confidence   smallint,                            -- score déterministe (0-100) si disponible
  tokens_in    integer,
  tokens_out   integer
);

create index idx_decision_ledger_dossier on decision_ledger(dossier_id, created_at desc);

alter table decision_ledger enable row level security;
create policy decision_ledger_rw on decision_ledger for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
