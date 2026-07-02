-- =============================================================================
-- Nova Comptabilité — 0015 : Journal d'audit (piste d'audit inaltérable)
-- =============================================================================
-- Trace horodatée des actions sensibles (écritures, contre-passations, clôtures,
-- factures, FNE…). APPEND-ONLY : nova_app ne peut qu'insérer et lire — jamais
-- modifier ni supprimer (exigence de traçabilité comptable OHADA).
-- L'utilisateur est rattaché automatiquement via app_current_user_id() (GUC session).
-- =============================================================================

create table audit_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid,
  user_name   text,                   -- acteur dénormalisé (app_users est restreint par RLS)
  user_email  text,
  dossier_id  uuid references dossiers(id) on delete set null,
  action      text not null,          -- ex. 'entry.posted', 'exercise.closed'
  entity      text,                   -- ex. 'entry', 'invoice', 'fiscal_year'
  entity_id   text,                   -- identifiant de l'objet concerné
  detail      jsonb not null default '{}'::jsonb
);

create index idx_audit_dossier on audit_log(dossier_id, created_at desc);
create index idx_audit_user on audit_log(user_id, created_at desc);

alter table audit_log enable row level security;

-- Lecture : membres du dossier (ou traces sans dossier, ex. actions cabinet).
create policy audit_read on audit_log for select
  using (dossier_id is null or dossier_id in (select app_dossier_ids()));

-- Insertion : uniquement sur un dossier accessible (ou sans dossier).
create policy audit_insert on audit_log for insert
  with check (dossier_id is null or dossier_id in (select app_dossier_ids()));

-- Inaltérabilité : on retire explicitement UPDATE/DELETE au rôle applicatif.
revoke update, delete on audit_log from nova_app;
