-- =============================================================================
-- Nova Comptabilité — 0064 : veille nocturne de Lexa (agent_insights)
-- =============================================================================
-- Lexa était réactive : elle répondait quand on l'interrogeait. La veille la
-- rend PROACTIVE : chaque nuit, un moteur DÉTERMINISTE recompose les signaux du
-- dossier (trésorerie, créances, TVA, échéances, cohérence inter-modules,
-- dotations dues, alertes RH) et enregistre un digest, éventuellement poussé
-- par email.
--
-- Aucune écriture comptable n'est produite : la veille ALERTE, elle n'agit pas.
-- =============================================================================

alter table dossiers add column if not exists nightly_digest boolean not null default false;

create table agent_insights (
  id           uuid primary key default gen_random_uuid(),
  dossier_id   uuid not null references dossiers(id) on delete cascade,
  generated_at timestamptz not null default now(),
  resume       jsonb not null default '{}'::jsonb,   -- {haute, moyenne, info, total}
  items        jsonb not null default '[]'::jsonb,   -- signaux détaillés
  notified_to  text                                   -- email destinataire, si poussé
);

create index idx_agent_insights_dossier on agent_insights(dossier_id, generated_at desc);

alter table agent_insights enable row level security;
create policy agent_insights_rw on agent_insights for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

-- --- Cibles de la veille -----------------------------------------------------
-- Le planificateur tourne SANS utilisateur : sous RLS, app_dossier_ids() serait
-- vide et il ne verrait rien (fail-closed). On expose donc explicitement, via
-- une fonction SECURITY DEFINER, les dossiers ayant activé la veille et le
-- propriétaire au nom duquel exécuter le calcul (le traitement repasse ensuite
-- par la RLS normale, avec cet utilisateur).
create or replace function nightly_targets()
returns table(dossier_id uuid, user_id uuid, email text)
language sql security definer set search_path = public stable as $$
  select distinct on (d.id) d.id, cm.user_id, u.email
    from dossiers d
    join cabinet_members cm on cm.cabinet_id = d.cabinet_id
    join app_users u on u.id = cm.user_id
   where d.is_active and coalesce(d.nightly_digest, false)
   order by d.id, (cm.role = 'owner') desc, cm.created_at
$$;

grant execute on function nightly_targets() to nova_app;
