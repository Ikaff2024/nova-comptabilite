-- =============================================================================
-- Nova Comptabilité — 0043 : Canal Telegram (Bot API)
-- =============================================================================
-- Relie un chat Telegram à un utilisateur + dossier via un CODE : l'app génère
-- un code, l'utilisateur l'envoie au bot, le webhook lie le chat_id. Ensuite,
-- les messages du chat sont routés vers Lexa. Résolution/liaison hors session
-- via fonctions SECURITY DEFINER.
-- =============================================================================

create table telegram_links (
  id         uuid primary key default gen_random_uuid(),
  dossier_id uuid not null references dossiers(id) on delete cascade,
  user_id    uuid not null references app_users(id) on delete cascade,
  chat_id    text,                    -- rempli à la liaison (via code)
  link_code  text not null,           -- code à envoyer au bot
  label      text,
  created_at timestamptz not null default now()
);

create unique index uq_telegram_chat on telegram_links(chat_id) where chat_id is not null;
create index idx_telegram_links_dossier on telegram_links(dossier_id);

alter table telegram_links enable row level security;
create policy telegram_links_rw on telegram_links for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));

-- Résolution chat_id -> (utilisateur, dossier) pour le webhook.
create or replace function telegram_resolve(p_chat_id text)
returns table(user_id uuid, dossier_id uuid)
language sql security definer set search_path = public as $$
  select user_id, dossier_id from telegram_links where chat_id = p_chat_id limit 1;
$$;
grant execute on function telegram_resolve(text) to nova_app;

-- Liaison par code : associe un chat_id à un lien en attente (chat_id null).
-- Renvoie le lien existant si le chat est déjà relié.
create or replace function telegram_link_code(p_code text, p_chat_id text)
returns table(user_id uuid, dossier_id uuid)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_uid uuid; v_did uuid;
begin
  select tl.user_id, tl.dossier_id into v_uid, v_did from telegram_links tl where tl.chat_id = p_chat_id limit 1;
  if found then return query select v_uid, v_did; return; end if;
  select tl.id into v_id from telegram_links tl where tl.link_code = upper(trim(p_code)) and tl.chat_id is null limit 1;
  if v_id is null then return; end if;
  update telegram_links set chat_id = p_chat_id where id = v_id returning telegram_links.user_id, telegram_links.dossier_id into v_uid, v_did;
  return query select v_uid, v_did;
end $$;
grant execute on function telegram_link_code(text, text) to nova_app;
