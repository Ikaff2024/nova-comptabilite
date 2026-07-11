-- =============================================================================
-- Nova Comptabilité — 0039 : Canal WhatsApp (Meta Cloud API)
-- =============================================================================
-- Relie un numéro WhatsApp (E.164, tel que Meta l'envoie dans "from") à un
-- utilisateur Nova et à un dossier. Les messages entrants sont routés vers
-- l'agent (texte) ou la capture (média) dans le périmètre de cet utilisateur.
-- Le webhook n'a pas de session authentifiée : la résolution passe par une
-- fonction SECURITY DEFINER.
-- =============================================================================

create table whatsapp_links (
  id         uuid primary key default gen_random_uuid(),
  dossier_id uuid not null references dossiers(id) on delete cascade,
  user_id    uuid not null references app_users(id) on delete cascade,  -- l'utilisateur "incarné" par ce numéro
  phone      text not null,                                             -- E.164 sans '+', ex. 2250700000000
  label      text,
  created_at timestamptz not null default now(),
  unique (phone)
);

create index idx_whatsapp_links_dossier on whatsapp_links(dossier_id);

alter table whatsapp_links enable row level security;
create policy whatsapp_links_rw on whatsapp_links for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));

-- Résolution numéro -> (utilisateur, dossier) pour le webhook (hors session RLS).
create or replace function whatsapp_resolve(p_phone text)
returns table(user_id uuid, dossier_id uuid)
language sql security definer set search_path = public as $$
  select user_id, dossier_id from whatsapp_links where phone = p_phone limit 1;
$$;

grant execute on function whatsapp_resolve(text) to nova_app;
