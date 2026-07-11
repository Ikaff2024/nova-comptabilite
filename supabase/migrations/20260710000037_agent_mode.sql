-- =============================================================================
-- Nova Comptabilité — 0037 : Niveau de pouvoir de l'assistant IA (gouvernance)
-- =============================================================================
-- L'assistant peut être en 'readonly' (lecture seule, défaut) ou 'assist'
-- (peut préparer des BROUILLONS — factures/achats — que l'humain valide ;
-- jamais de postEntry). Le basculement est réservé aux owner/associé du
-- cabinet, dossier par dossier, via une fonction SECURITY DEFINER.
-- =============================================================================

alter table dossiers add column if not exists agent_mode text not null default 'readonly';
alter table dossiers drop constraint if exists dossiers_agent_mode_chk;
alter table dossiers add constraint dossiers_agent_mode_chk check (agent_mode in ('readonly', 'assist'));

-- Bascule du mode : réservée owner/associé du cabinet du dossier.
create or replace function dossier_set_agent_mode(p_dossier uuid, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare v_cabinet uuid; v_caller cabinet_role;
begin
  if p_mode not in ('readonly', 'assist') then raise exception 'Mode invalide'; end if;
  select cabinet_id into v_cabinet from dossiers where id = p_dossier;
  if v_cabinet is null then raise exception 'Dossier introuvable'; end if;
  select cm.role into v_caller from cabinet_members cm where cm.cabinet_id = v_cabinet and cm.user_id = app_current_user_id();
  if v_caller is null or v_caller not in ('owner', 'associe') then raise exception 'Réservé aux administrateurs du cabinet'; end if;
  update dossiers set agent_mode = p_mode where id = p_dossier;
end $$;

grant execute on function dossier_set_agent_mode(uuid, text) to nova_app;

-- Le caller est-il admin (owner/associé) du cabinet du dossier ? (pour l'UI)
create or replace function dossier_is_admin(p_dossier uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_cabinet uuid; v_caller cabinet_role;
begin
  select cabinet_id into v_cabinet from dossiers where id = p_dossier;
  if v_cabinet is null then return false; end if;
  select cm.role into v_caller from cabinet_members cm where cm.cabinet_id = v_cabinet and cm.user_id = app_current_user_id();
  return v_caller in ('owner', 'associe');
end $$;

grant execute on function dossier_is_admin(uuid) to nova_app;
