-- =============================================================================
-- Nova Comptabilité — 0007 : Rôle applicatif + onboarding + garde reverse_entry
-- =============================================================================
-- L'API se connecte avec un rôle NON-superuser (`nova_app`) pour que la RLS
-- s'applique réellement à l'exécution. Les opérations privilégiées (créer un
-- cabinet et son premier membre) passent par une fonction SECURITY DEFINER
-- explicite et auditable, jamais par un trou dans la RLS.
-- =============================================================================

-- --- Rôle applicatif ----------------------------------------------------------
-- NB : mot de passe DEV uniquement. En prod, créer le rôle LOGIN hors migration
-- avec un secret géré (et donner le DATABASE_URL au backend).

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'nova_app') then
    create role nova_app login password 'nova_app';
  end if;
end $$;

grant usage on schema public to nova_app;
grant select, insert, update, delete on all tables in schema public to nova_app;
grant usage, select on all sequences in schema public to nova_app;
grant execute on all functions in schema public to nova_app;

-- objets futurs créés par le propriétaire -> accessibles à nova_app
alter default privileges in schema public
  grant select, insert, update, delete on tables to nova_app;
alter default privileges in schema public
  grant execute on functions to nova_app;

-- --- Onboarding atomique : crée le cabinet + rattache le créateur en owner ----

create or replace function onboard_cabinet(
  p_user_id  uuid,
  p_name     text,
  p_country  ohada_country,
  p_currency currency_code default 'XOF'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_cab uuid;
begin
  if p_user_id is null then raise exception 'user_id requis'; end if;
  insert into cabinets(name, country, base_currency)
    values (p_name, p_country, p_currency) returning id into v_cab;
  insert into cabinet_members(cabinet_id, user_id, role)
    values (v_cab, p_user_id, 'owner');
  return v_cab;
end $$;

grant execute on function onboard_cabinet(uuid, text, ohada_country, currency_code) to nova_app;

-- --- Renforcement : reverse_entry vérifie l'appartenance quand un user est posé
-- (SECURITY DEFINER bypasse la RLS : on contrôle explicitement le périmètre)

create or replace function reverse_entry(p_entry_id uuid, p_date date default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_src entries%rowtype;
  v_new_id uuid;
  v_line entry_lines%rowtype;
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

  for v_line in select * from entry_lines where entry_id = p_entry_id loop
    insert into entry_lines (entry_id, dossier_id, account_id, line_no,
        amount_debit, amount_credit, orig_currency, orig_amount, fx_rate, label,
        counterparty_id, tax_code_id, payment_channel, certification, normalized_cat, analytic_axis)
    values (v_new_id, v_line.dossier_id, v_line.account_id, v_line.line_no,
        v_line.amount_credit, v_line.amount_debit, v_line.orig_currency, v_line.orig_amount,
        v_line.fx_rate, 'Extourne : ' || coalesce(v_line.label,''),
        v_line.counterparty_id, v_line.tax_code_id, v_line.payment_channel,
        v_line.certification, v_line.normalized_cat, v_line.analytic_axis);
  end loop;

  update entries set status = 'posted' where id = v_new_id;
  update entries set status = 'reversed', reversed_by_entry_id = v_new_id where id = p_entry_id;
  return v_new_id;
end $$;

grant execute on function reverse_entry(uuid, date) to nova_app;
grant execute on function instantiate_chart(uuid, text, text) to nova_app;
grant execute on function set_current_user(uuid) to nova_app;
