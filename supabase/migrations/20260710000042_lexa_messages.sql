-- =============================================================================
-- Nova Comptabilité — 0042 : Conversations de Lexa (continuité)
-- =============================================================================
-- Historise les échanges par (dossier, utilisateur) pour que Lexa se souvienne
-- d'une session à l'autre (rechargement de page, messages WhatsApp successifs).
-- Portée dossier + RLS. Contenu conservé pour le contexte conversationnel.
-- =============================================================================

create table lexa_messages (
  id         uuid primary key default gen_random_uuid(),
  dossier_id uuid not null references dossiers(id) on delete cascade,
  user_id    uuid not null references app_users(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

create index idx_lexa_messages_thread on lexa_messages(dossier_id, user_id, created_at);

alter table lexa_messages enable row level security;
create policy lexa_messages_rw on lexa_messages for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
