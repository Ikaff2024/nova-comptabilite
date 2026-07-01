\set ON_ERROR_STOP on
\timing off

-- ============================================================================
-- SMOKE TEST — Nova Comptabilité ledger (Postgres vanille)
-- ============================================================================

DO $$
DECLARE
  v_cab uuid; v_user uuid := gen_random_uuid(); v_dos uuid;
  v_fy uuid; v_jrnl uuid; v_entry uuid; v_rev uuid;
  v_bank uuid; v_sales uuid; v_cnt int; v_bal numeric;
BEGIN
  -- 1) Tenancy : cabinet -> membre -> dossier
  insert into cabinets(name, country) values ('Cabinet Test CI', 'CI') returning id into v_cab;
  insert into cabinet_members(cabinet_id, user_id, role) values (v_cab, v_user, 'owner');
  insert into dossiers(cabinet_id, raison_sociale, country) values (v_cab, 'PME Demo SARL', 'CI') returning id into v_dos;
  RAISE NOTICE 'PASS 1 : tenancy créée (cabinet/dossier)';

  -- 2) Instanciation du plan SYSCOHADA dans le dossier
  v_cnt := instantiate_chart(v_dos);
  RAISE NOTICE 'PASS 2 : plan instancié = % comptes', v_cnt;

  -- structures
  insert into fiscal_years(dossier_id, label, start_date, end_date)
    values (v_dos, 'Exercice 2026', '2026-01-01', '2026-12-31') returning id into v_fy;
  insert into journals(dossier_id, code, label, type)
    values (v_dos, 'VE', 'Ventes', 'ventes') returning id into v_jrnl;

  select id into v_bank  from accounts where dossier_id=v_dos and account_code='521';
  if v_bank is null then select id into v_bank from accounts where dossier_id=v_dos and class_no=5 limit 1; end if;
  select id into v_sales from accounts where dossier_id=v_dos and account_code='701';
  if v_sales is null then select id into v_sales from accounts where dossier_id=v_dos and class_no=7 limit 1; end if;

  -- 3) Écriture équilibrée : Banque (D) 100 000 / Ventes (C) 100 000
  insert into entries(dossier_id, fiscal_year_id, journal_id, entry_date, description, source)
    values (v_dos, v_fy, v_jrnl, '2026-06-29', 'Vente comptant', 'manual') returning id into v_entry;
  insert into entry_lines(entry_id, dossier_id, account_id, amount_debit, payment_channel)
    values (v_entry, v_dos, v_bank, 100000, 'wave');
  insert into entry_lines(entry_id, dossier_id, account_id, amount_credit)
    values (v_entry, v_dos, v_sales, 100000);
  update entries set status='posted' where id=v_entry;
  RAISE NOTICE 'PASS 3 : écriture équilibrée validée (posted)';
END $$;

-- 4) NÉGATIF : poster une écriture déséquilibrée -> doit échouer
DO $$
DECLARE v_dos uuid; v_fy uuid; v_jrnl uuid; v_e uuid; v_a1 uuid; v_a2 uuid;
BEGIN
  select id into v_dos from dossiers limit 1;
  select id into v_fy from fiscal_years limit 1;
  select id into v_jrnl from journals limit 1;
  select id into v_a1 from accounts where dossier_id=v_dos and class_no=5 limit 1;
  select id into v_a2 from accounts where dossier_id=v_dos and class_no=7 limit 1;
  insert into entries(dossier_id,fiscal_year_id,journal_id,entry_date,description)
    values (v_dos,v_fy,v_jrnl,'2026-06-29','Déséquilibrée') returning id into v_e;
  insert into entry_lines(entry_id,dossier_id,account_id,amount_debit) values (v_e,v_dos,v_a1,100000);
  insert into entry_lines(entry_id,dossier_id,account_id,amount_credit) values (v_e,v_dos,v_a2,90000);
  update entries set status='posted' where id=v_e;  -- doit lever
  RAISE EXCEPTION 'FAIL 4 : déséquilibre accepté (ne devrait JAMAIS arriver)';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE 'FAIL 4%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 4 : déséquilibre rejeté (%).', left(SQLERRM, 60);
END $$;

-- 5) NÉGATIF : modifier une écriture validée -> doit échouer
DO $$
DECLARE v_e uuid;
BEGIN
  select id into v_e from entries where status='posted' limit 1;
  update entries set description='HACK' where id=v_e;
  RAISE EXCEPTION 'FAIL 5 : modification d''une écriture validée acceptée';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE 'FAIL 5%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 5 : modification du posted rejetée (immuabilité).';
END $$;

-- 6) NÉGATIF : supprimer une écriture validée -> doit échouer
DO $$
DECLARE v_e uuid;
BEGIN
  select id into v_e from entries where status='posted' limit 1;
  delete from entries where id=v_e;
  RAISE EXCEPTION 'FAIL 6 : suppression d''une écriture validée acceptée';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE 'FAIL 6%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 6 : suppression du posted rejetée.';
END $$;

-- 7) Contre-passation : crée l'extourne et marque l'original 'reversed'
DO $$
DECLARE v_e uuid; v_rev uuid; v_status entry_status;
BEGIN
  select id into v_e from entries where status='posted' and reverses_entry_id is null limit 1;
  v_rev := reverse_entry(v_e);
  select status into v_status from entries where id=v_e;
  IF v_status <> 'reversed' THEN RAISE EXCEPTION 'FAIL 7 : original non marqué reversed'; END IF;
  RAISE NOTICE 'PASS 7 : contre-passation OK (original=reversed, extourne créée %).', left(v_rev::text,8);
END $$;

-- 8) Balance : après vente + extourne, le solde net doit être nul
DO $$
DECLARE v_net numeric;
BEGIN
  select coalesce(sum(balance),0) into v_net from v_account_balances;
  IF v_net <> 0 THEN RAISE EXCEPTION 'FAIL 8 : balance générale non nulle (%).', v_net; END IF;
  RAISE NOTICE 'PASS 8 : balance équilibrée (somme des soldes = 0).';
END $$;

-- 9) RLS : un utilisateur ne voit que les dossiers de son périmètre
DO $$
DECLARE v_visible int; v_other_cab uuid;
BEGIN
  -- crée un 2e cabinet + dossier, NON rattaché à notre user de test
  insert into cabinets(name,country) values ('Cabinet Étranger','SN') returning id into v_other_cab;
  insert into dossiers(cabinet_id,raison_sociale,country) values (v_other_cab,'Hors périmètre','SN');
END $$;

-- on simule l'utilisateur via la variable de session + un rôle non-superuser
CREATE ROLE app_role NOLOGIN;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_role;

DO $$ DECLARE v_uid uuid; BEGIN
  select user_id into v_uid from cabinet_members where role='owner' limit 1;
  perform set_config('app.test_uid', v_uid::text, false);
END $$;

SET ROLE app_role;
SELECT set_config('app.current_user_id', current_setting('app.test_uid'), false) AS _ ;
SELECT count(*) AS dossiers_visibles_par_le_user FROM dossiers;
RESET ROLE;

SELECT 'Tous les dossiers (vue admin)' AS info, count(*) AS total FROM dossiers;
