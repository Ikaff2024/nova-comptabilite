-- =============================================================================
-- Nova Comptabilité — 0068 : suppression d'un dossier
-- =============================================================================
-- La table dossiers a une policy « for all » bornée au cabinet, mais supprimer
-- un dossier par un simple DELETE échoue : entries / entry_lines (et quelques
-- tables sœurs : invoices, purchase_invoices, lettrages, bank_pointings,
-- recurring_templates) portent des clés « on delete restrict » qui bloquent la
-- cascade. On centralise donc le démontage dans une fonction SECURITY DEFINER,
-- avec contrôle d'autorisation interne (comme cabinet_rename) : réservé au
-- propriétaire / associé du cabinet, ou à un admin plateforme.
--
-- ATTENTION : opération IRRÉVERSIBLE. Toute nouvelle table portant une clé
-- « on delete restrict » vers accounts / entries / entry_lines / journals /
-- counterparties / fiscal_years devra être vidée ici, avant le DELETE final.
-- =============================================================================

create or replace function dossier_delete(p_dossier uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_cabinet uuid; v_caller cabinet_role;
begin
  select cabinet_id into v_cabinet from dossiers where id = p_dossier;
  if v_cabinet is null then raise exception 'Dossier introuvable'; end if;

  select cm.role into v_caller from cabinet_members cm
   where cm.cabinet_id = v_cabinet and cm.user_id = app_current_user_id();
  if not (app_is_platform_admin() or v_caller in ('owner', 'associe')) then
    raise exception 'Suppression réservée au propriétaire ou à un associé du cabinet';
  end if;

  -- Démontage ordonné (les clés « on delete restrict » entre tables sœurs
  -- imposent de vider ces tables avant que la suppression du dossier ne
  -- déclenche la cascade sur accounts / journals / counterparties / fiscal_years).
  delete from bank_pointings     where dossier_id = p_dossier;
  delete from lettrage_lines      where dossier_id = p_dossier;
  delete from lettrages           where dossier_id = p_dossier;
  delete from invoices            where dossier_id = p_dossier;   -- invoice_lines : cascade
  delete from purchase_invoices   where dossier_id = p_dossier;   -- lignes d'achat : cascade
  delete from recurring_templates where dossier_id = p_dossier;
  delete from entry_lines         where dossier_id = p_dossier;
  update entries set reverses_entry_id = null, reversed_by_entry_id = null where dossier_id = p_dossier;
  delete from entries             where dossier_id = p_dossier;

  delete from dossiers where id = p_dossier;  -- cascade : tout le reste des tables du dossier
end $$;

grant execute on function dossier_delete(uuid) to nova_app;
