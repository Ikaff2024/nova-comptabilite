-- =============================================================================
-- Nova Comptabilité — 0045 : Choix de la voix de Lexa (par dossier)
-- =============================================================================
-- Le propriétaire/admin choisit le fournisseur de synthèse vocale (ElevenLabs
-- ou OpenAI) et la voix. Stocké par dossier, comme agent_mode.
-- =============================================================================

alter table dossiers add column if not exists voice_provider text not null default 'elevenlabs';
alter table dossiers add column if not exists voice_id       text;  -- null = voix par défaut du fournisseur

alter table dossiers drop constraint if exists dossiers_voice_provider_chk;
alter table dossiers add constraint dossiers_voice_provider_chk
  check (voice_provider in ('elevenlabs', 'openai'));

-- Réglage réservé au propriétaire/associé (comme le mode agent).
create or replace function dossier_set_voice(p_dossier uuid, p_provider text, p_voice text)
returns void language plpgsql security definer set search_path = public as $$
declare v_cabinet uuid; v_caller cabinet_role;
begin
  if p_provider is not null and p_provider not in ('elevenlabs', 'openai') then raise exception 'Fournisseur invalide'; end if;
  select cabinet_id into v_cabinet from dossiers where id = p_dossier;
  if v_cabinet is null then raise exception 'Dossier introuvable'; end if;
  select cm.role into v_caller from cabinet_members cm where cm.cabinet_id = v_cabinet and cm.user_id = app_current_user_id();
  if v_caller is null or v_caller not in ('owner', 'associe') then raise exception 'Réservé aux administrateurs du cabinet'; end if;
  update dossiers set voice_provider = coalesce(p_provider, voice_provider), voice_id = p_voice where id = p_dossier;
end $$;
grant execute on function dossier_set_voice(uuid, text, text) to nova_app;
