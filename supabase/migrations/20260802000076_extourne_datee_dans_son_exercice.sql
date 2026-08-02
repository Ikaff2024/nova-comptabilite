-- =============================================================================
-- Nova Comptabilité — 0076 : une contre-passation est datée DANS son exercice
-- =============================================================================
-- DÉFAUT CORRIGÉ ICI. reverse_entry datait l'extourne du JOUR (current_date)
-- tout en la rattachant à l'exercice de l'écriture d'origine — les deux ne
-- concordent pas dès que l'origine appartient à un exercice antérieur.
--
--   Écriture de l'exercice 2025, contre-passée le 2 août 2026 :
--     extourne → exercice « 2025 », datée du 2026-08-02.
--
-- Conséquences :
--   · l'extourne est elle-même « mal rattachée » et ressort en révision,
--     indéfiniment — on corrige une anomalie en en créant une autre ;
--   · le grand livre par DATE la range dans une période à laquelle elle
--     n'appartient pas, alors que la balance de l'exercice, elle, la compte ;
--   · le redressement en masse ne pouvait jamais se terminer : chaque passe
--     laissait derrière elle autant d'anomalies qu'elle en traitait.
--
-- Règle retenue : la date de l'extourne est celle du jour, RAMENÉE dans les
-- bornes de l'exercice qu'elle neutralise. Une écriture de 2025 contre-passée
-- en 2026 est donc datée du 31/12/2025 — on ne peut pas comptabiliser en 2026
-- quelque chose qui appartient à l'exercice 2025. Le bornage prime sur le
-- calendrier ; c'est le même principe que le refus d'écrire dans une période
-- clôturée.
-- =============================================================================

create or replace function reverse_entry(p_entry_id uuid, p_date date default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_src entries%rowtype;
  v_new_id uuid;
  v_line entry_lines%rowtype;
  v_new_line uuid;
  v_date date;
  v_d1 date;
  v_d2 date;
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

  -- Date de l'extourne : le jour, ramené dans l'exercice qu'elle neutralise.
  select start_date, end_date into v_d1, v_d2 from fiscal_years where id = v_src.fiscal_year_id;
  v_date := coalesce(p_date, current_date);
  if v_d1 is not null and v_date < v_d1 then v_date := v_d1; end if;
  if v_d2 is not null and v_date > v_d2 then v_date := v_d2; end if;

  insert into entries (dossier_id, fiscal_year_id, journal_id, entry_date, piece_ref,
                       description, status, source, reverses_entry_id, created_by)
  values (v_src.dossier_id, v_src.fiscal_year_id, v_src.journal_id,
          v_date, v_src.piece_ref,
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

    insert into entry_line_analytics (entry_line_id, dossier_id, axis_id, section_id)
      select v_new_line, ela.dossier_id, ela.axis_id, ela.section_id
        from entry_line_analytics ela where ela.entry_line_id = v_line.id;
  end loop;

  update entries set status = 'posted' where id = v_new_id;
  update entries set reversed_by_entry_id = v_new_id where id = p_entry_id;
  return v_new_id;
end $$;

grant execute on function reverse_entry(uuid, date) to nova_app;

-- --- Réparation des extournes déjà datées hors de leur exercice ---------------
-- Elles polluent la révision sans rien dire de vrai. On les ramène dans les
-- bornes de l'exercice auquel elles sont DÉJÀ rattachées : ni le rattachement
-- ni les montants ne changent, seule la date rejoint la période qu'elle sert.
-- Le déclencheur d'immuabilité protège les écritures validées ; on le lève le
-- temps de cette correction, qui ne touche qu'aux extournes hors bornes.
alter table entries disable trigger trg_protect_entries;

update entries e
   set entry_date = least(greatest(e.entry_date, f.start_date), f.end_date)
  from fiscal_years f
 where f.id = e.fiscal_year_id
   and e.reverses_entry_id is not null
   and (e.entry_date < f.start_date or e.entry_date > f.end_date);

alter table entries enable trigger trg_protect_entries;
