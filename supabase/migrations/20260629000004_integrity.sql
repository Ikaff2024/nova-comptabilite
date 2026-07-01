-- =============================================================================
-- Nova Comptabilité — 0004 : Garde-fous d'intégrité comptable
-- =============================================================================
-- Ces règles vivent EN BASE (pas dans l'applicatif). C'est ce qui garantit que
-- l'IA, l'API ou un bug ne peuvent jamais produire une compta déséquilibrée ou
-- altérer le passé. Exigence d'auditabilité AUDCIF.
-- =============================================================================

-- --- 1) Une écriture POSTED doit être équilibrée (débit = crédit) -------------
-- Constraint trigger DEFERRABLE : la vérif a lieu en fin de transaction, donc
-- on peut insérer les lignes une par une avant équilibre.

create or replace function check_entry_balanced() returns trigger
language plpgsql as $$
declare
  v_entry entries%rowtype;
  v_debit numeric(20,4);
  v_credit numeric(20,4);
begin
  select * into v_entry from entries
   where id = coalesce(new.entry_id, old.entry_id);

  if v_entry.id is null then
    return null; -- entry supprimée dans la même transaction
  end if;

  -- On n'impose l'équilibre que sur les écritures validées
  if v_entry.status <> 'posted' then
    return null;
  end if;

  select coalesce(sum(amount_debit),0), coalesce(sum(amount_credit),0)
    into v_debit, v_credit
    from entry_lines where entry_id = v_entry.id;

  if v_debit <> v_credit then
    raise exception 'Écriture % déséquilibrée : débit=% crédit=%',
      v_entry.id, v_debit, v_credit;
  end if;

  if v_debit = 0 then
    raise exception 'Écriture % validée sans montant', v_entry.id;
  end if;

  return null;
end $$;

create constraint trigger trg_entry_balanced
  after insert or update or delete on entry_lines
  deferrable initially deferred
  for each row execute function check_entry_balanced();

-- Si on passe une entry à 'posted', revérifier l'équilibre de ses lignes
create or replace function check_entry_balanced_on_post() returns trigger
language plpgsql as $$
declare v_debit numeric(20,4); v_credit numeric(20,4);
begin
  if new.status = 'posted' and (tg_op = 'INSERT' or old.status is distinct from 'posted') then
    select coalesce(sum(amount_debit),0), coalesce(sum(amount_credit),0)
      into v_debit, v_credit from entry_lines where entry_id = new.id;
    if v_debit <> v_credit or v_debit = 0 then
      raise exception 'Écriture % non équilibrée à la validation (D=% C=%)', new.id, v_debit, v_credit;
    end if;
    new.posted_at := coalesce(new.posted_at, now());
  end if;
  return new;
end $$;

create trigger trg_entry_post_check
  before insert or update on entries
  for each row execute function check_entry_balanced_on_post();

-- --- 2) Immuabilité des écritures validées ------------------------------------
-- Une entry 'posted' ne peut plus changer SAUF transition contrôlée vers
-- 'reversed' (+ pose de reversed_by_entry_id). Aucune suppression.

create or replace function protect_posted_entries() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception 'Suppression interdite : écriture % validée (contre-passez-la)', old.id;
    end if;
    return old;
  end if;

  if old.status = 'posted' then
    -- seules transitions autorisées : status -> reversed et pose des liens d'annulation
    if new.status not in ('posted','reversed')
       or new.dossier_id     is distinct from old.dossier_id
       or new.fiscal_year_id is distinct from old.fiscal_year_id
       or new.journal_id     is distinct from old.journal_id
       or new.entry_date     is distinct from old.entry_date
       or new.description    is distinct from old.description
       or new.source         is distinct from old.source then
      raise exception 'Modification interdite : écriture % validée est immuable', old.id;
    end if;
  end if;
  return new;
end $$;

create trigger trg_protect_entries
  before update or delete on entries
  for each row execute function protect_posted_entries();

-- Lignes d'une écriture validée : strictement immuables
create or replace function protect_posted_lines() returns trigger
language plpgsql as $$
declare v_status entry_status;
begin
  select status into v_status from entries
    where id = coalesce(old.entry_id, new.entry_id);
  if v_status = 'posted' then
    raise exception 'Modification interdite : lignes de l''écriture % verrouillées', coalesce(old.entry_id, new.entry_id);
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_protect_lines
  before update or delete on entry_lines
  for each row execute function protect_posted_lines();

-- --- 3) Période ouverte : pas d'écriture dans un exercice clôturé -------------

create or replace function check_period_open() returns trigger
language plpgsql as $$
declare v_status fiscal_year_status;
begin
  if new.status = 'posted' then
    select status into v_status from fiscal_years where id = new.fiscal_year_id;
    if v_status = 'closed' then
      raise exception 'Exercice clôturé : impossible de valider l''écriture %', new.id;
    end if;
  end if;
  return new;
end $$;

create trigger trg_period_open
  before insert or update on entries
  for each row execute function check_period_open();

-- --- 4) Contre-passation atomique (la SEULE façon d'« annuler » du posted) ----

create or replace function reverse_entry(p_entry_id uuid, p_date date default null)
returns uuid
language plpgsql security definer as $$
declare
  v_src entries%rowtype;
  v_new_id uuid;
  v_line entry_lines%rowtype;
begin
  select * into v_src from entries where id = p_entry_id;
  if v_src.id is null then raise exception 'Écriture introuvable'; end if;
  if v_src.status <> 'posted' then raise exception 'Seule une écriture validée se contre-passe'; end if;
  if v_src.reversed_by_entry_id is not null then raise exception 'Écriture déjà contre-passée'; end if;

  insert into entries (dossier_id, fiscal_year_id, journal_id, entry_date, piece_ref,
                       description, status, source, reverses_entry_id, created_by)
  values (v_src.dossier_id, v_src.fiscal_year_id, v_src.journal_id,
          coalesce(p_date, current_date), v_src.piece_ref,
          'EXTOURNE — ' || v_src.description, 'draft', v_src.source, v_src.id, v_src.created_by)
  returning id into v_new_id;

  -- copie miroir : débit <-> crédit
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

-- --- 5) Vue balance (soldes par compte / exercice) ---------------------------

create view v_account_balances as
select
  l.dossier_id,
  e.fiscal_year_id,
  l.account_id,
  a.account_code,
  a.label as account_label,
  sum(l.amount_debit)  as total_debit,
  sum(l.amount_credit) as total_credit,
  sum(l.amount_debit) - sum(l.amount_credit) as balance
from entry_lines l
join entries e on e.id = l.entry_id and e.status = 'posted'
join accounts a on a.id = l.account_id
group by l.dossier_id, e.fiscal_year_id, l.account_id, a.account_code, a.label;
