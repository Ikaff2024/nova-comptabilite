-- =============================================================================
-- Nova Comptabilité — 0038 : 3e palier de l'assistant IA ('assist_plus')
-- =============================================================================
-- Ajoute un niveau intermédiaire de pouvoir, gouverné par l'admin :
--   readonly     : lecture seule
--   assist       : + brouillons (factures) à valider par l'humain
--   assist_plus  : + actions RÉVERSIBLES hors grand livre (lettrage auto,
--                  préparation de lettres de relance)
-- Toujours : aucun postEntry/émission/règlement/clôture par l'agent.
-- =============================================================================

alter table dossiers drop constraint if exists dossiers_agent_mode_chk;
alter table dossiers add constraint dossiers_agent_mode_chk check (agent_mode in ('readonly', 'assist', 'assist_plus'));

create or replace function dossier_set_agent_mode(p_dossier uuid, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare v_cabinet uuid; v_caller cabinet_role;
begin
  if p_mode not in ('readonly', 'assist', 'assist_plus') then raise exception 'Mode invalide'; end if;
  select cabinet_id into v_cabinet from dossiers where id = p_dossier;
  if v_cabinet is null then raise exception 'Dossier introuvable'; end if;
  select cm.role into v_caller from cabinet_members cm where cm.cabinet_id = v_cabinet and cm.user_id = app_current_user_id();
  if v_caller is null or v_caller not in ('owner', 'associe') then raise exception 'Réservé aux administrateurs du cabinet'; end if;
  update dossiers set agent_mode = p_mode where id = p_dossier;
end $$;

grant execute on function dossier_set_agent_mode(uuid, text) to nova_app;
