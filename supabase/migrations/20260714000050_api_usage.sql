-- =============================================================================
-- Nova Comptabilité — 0050 : Métrage des coûts d'API par dossier
-- =============================================================================
-- Enregistre chaque appel facturable (LLM Anthropic, voix ElevenLabs/OpenAI,
-- transcription Whisper, email) pour piloter les coûts par client dans la page
-- propriétaire. Coût estimé en USD au moment de l'appel. Portée dossier + RLS.
-- =============================================================================

create table api_usage (
  id            uuid primary key default gen_random_uuid(),
  dossier_id    uuid not null references dossiers(id) on delete cascade,
  provider      text not null,                 -- anthropic | elevenlabs | openai_tts | whisper | resend
  model         text,                          -- claude-opus-4-8, whisper-1, …
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  units         numeric(14,2) not null default 0,   -- caractères (TVA), secondes (audio), nb (email)
  cost_usd      numeric(14,6) not null default 0,
  created_at    timestamptz not null default now()
);

create index idx_api_usage_dossier on api_usage(dossier_id, created_at);
create index idx_api_usage_created on api_usage(created_at);

alter table api_usage enable row level security;
create policy api_usage_rw on api_usage for all
  using (dossier_id in (select app_dossier_ids())) with check (dossier_id in (select app_dossier_ids()));
