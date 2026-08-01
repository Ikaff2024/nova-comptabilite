-- =============================================================================
-- Nova Comptabilité — 0075 : une contre-passation ANNULE, elle n'inverse pas
-- =============================================================================
-- DÉFAUT CORRIGÉ ICI. reverse_entry faisait deux choses : il créait l'écriture
-- de sens inverse (juste), et il basculait l'écriture d'origine en statut
-- 'reversed' (fatal). Or TOUTES les lectures du grand livre filtrent
-- `status = 'posted'` : balance, grand livre, journaux, états financiers,
-- analytique, cohérence. L'écriture d'origine sortait donc des comptes, tandis
-- que son extourne y restait.
--
-- Résultat sur un achat de 300 000 contre-passé :
--     avant :  601 = +300 000
--     après :  601 = −300 000        (attendu : 0)
--
-- La contre-passation ne neutralisait pas l'écriture, elle l'inversait. Trois
-- conséquences, toutes visibles par le client :
--   · le compte finissait au montant OPPOSÉ au lieu de zéro ;
--   · l'écriture d'origine disparaissait du journal et du grand livre — dans un
--     livre réputé immuable, où l'on contre-passe précisément pour ne rien
--     effacer ;
--   · la réaffectation d'exercice (Révision) s'appuie sur l'extourne : elle
--     laissait donc l'exercice d'origine à −X au lieu de 0.
--
-- Correction : l'écriture d'origine RESTE 'posted'. Elle est marquée comme
-- contre-passée par reversed_by_entry_id, qui existait déjà et suffit. Les deux
-- écritures cohabitent au grand livre et s'annulent — c'est la définition même
-- de l'extourne.
--
-- Le statut 'reversed' de l'énumération n'est plus posé. On le laisse en place :
-- le retirer d'un type PostgreSQL est bloquant, et il ne gêne rien.
-- =============================================================================

create or replace function reverse_entry(p_entry_id uuid, p_date date default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_src entries%rowtype;
  v_new_id uuid;
  v_line entry_lines%rowtype;
  v_new_line uuid;
begin
  select * into v_src from entries where id = p_entry_id;
  if v_src.id is null then raise exception 'Écriture introuvable'; end if;

  -- garde de périmètre : si un utilisateur est dans le contexte, il doit avoir accès au dossier
  if app_current_user_id() is not null
     and not exists (select 1 from (select app_dossier_ids() as id) s where s.id = v_src.dossier_id) then
    raise exception 'Accès refusé au dossier de l''écriture %', p_entry_id;
  end if;

  if v_src.status <> 'posted' then raise exception 'Seule une écriture validée se contre-passe'; end if;
  if v_src.reversed_by_entry_id is not null then raise exception 'Écriture déjà contre-passée'; end if;

  insert into entries (dossier_id, fiscal_year_id, journal_id, entry_date, piece_ref,
                       description, status, source, reverses_entry_id, created_by)
  values (v_src.dossier_id, v_src.fiscal_year_id, v_src.journal_id,
          coalesce(p_date, current_date), v_src.piece_ref,
          'EXTOURNE — ' || v_src.description, 'draft', v_src.source, v_src.id, v_src.created_by)
  returning id into v_new_id;

  for v_line in select * from entry_lines where entry_id = p_entry_id order by line_no loop
    insert into entry_lines (entry_id, dossier_id, account_id, line_no,
        amount_debit, amount_credit, orig_currency, orig_amount, fx_rate, label,
        counterparty_id, tax_code_id, payment_channel, certification, normalized_cat, analytic_axis)
    values (v_new_id, v_line.dossier_id, v_line.account_id, v_line.line_no,
        v_line.amount_credit, v_line.amount_debit, v_line.orig_currency, v_line.orig_amount,
        v_line.fx_rate, 'Extourne : ' || coalesce(v_line.label,''),
        v_line.counterparty_id, v_line.tax_code_id, v_line.payment_channel,
        v_line.certification, v_line.normalized_cat, v_line.analytic_axis)
    returning id into v_new_line;

    -- La ventilation analytique suit : une extourne qui la perdrait laisserait
    -- la charge dans sa section et son annulation dans le « non ventilé ».
    insert into entry_line_analytics (entry_line_id, dossier_id, axis_id, section_id)
      select v_new_line, ela.dossier_id, ela.axis_id, ela.section_id
        from entry_line_analytics ela where ela.entry_line_id = v_line.id;
  end loop;

  update entries set status = 'posted' where id = v_new_id;
  -- L'origine reste 'posted' : elle est marquée, pas retirée des comptes.
  update entries set reversed_by_entry_id = v_new_id where id = p_entry_id;
  return v_new_id;
end $$;

grant execute on function reverse_entry(uuid, date) to nova_app;

-- --- Réparation des dossiers déjà touchés -------------------------------------
-- Toute écriture laissée en 'reversed' est absente des comptes alors que son
-- extourne y figure : le solde est actuellement l'inverse du montant d'origine.
-- On la remet au grand livre, ce qui ramène chaque compte concerné à zéro sur
-- ces deux écritures. Aucune écriture n'est créée ni supprimée.
update entries set status = 'posted' where status = 'reversed';
