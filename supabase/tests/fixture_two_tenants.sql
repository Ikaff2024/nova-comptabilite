-- =============================================================================
-- Fixture partagée des tests de sécurité — deux locataires complets
-- =============================================================================
-- Monte deux cabinets étanches, chacun avec son dossier, son plan comptable,
-- son exercice et son journal. Le cabinet A porte UNE écriture validée de
-- 777 777 XOF, identifiable par son libellé : c'est le montant du scénario
-- historique de la revue CTO (NOVA-P0-03), qu'on retrouve dans les tests.
--
-- Identifiants fixes, pour que les tests puissent les citer littéralement :
--   Alice (cabinet A) : 11111111-1111-1111-1111-111111111111
--   Bob   (cabinet B) : 22222222-2222-2222-2222-222222222222
--   Dossier A         : aaaaaaaa-0000-0000-0000-00000000000a
--   Dossier A2        : cccccccc-0000-0000-0000-00000000000c  (2e client de A)
--   Dossier B         : bbbbbbbb-0000-0000-0000-00000000000b
--   Écriture A        : eeeeeeee-0000-0000-0000-00000000000a  (777 777, posted)
--
-- Le dossier A2 existe parce que l'étanchéité entre deux clients d'un MÊME
-- cabinet ne repose pas sur la RLS (les deux sont dans app_dossier_ids) : c'est
-- le cas qui distingue une vraie contrainte d'un effet de bord des policies.
--
-- À exécuter avec un rôle propriétaire (postgres), après les migrations.
-- =============================================================================

-- --- 1) Purge ---------------------------------------------------------------
-- Les écritures validées sont verrouillées en base — c'est tout l'objet de la
-- migration 0078. Une fixture doit pourtant pouvoir se rejouer : on désactive
-- les deux verrous LE TEMPS DU NETTOYAGE. Réservé au montage de test, exécuté
-- par le propriétaire des tables, jamais par le rôle applicatif.
alter table entry_lines disable trigger trg_protect_lines;
alter table entries     disable trigger trg_protect_entries;

do $$
declare
  uA uuid := '11111111-1111-1111-1111-111111111111';
  uB uuid := '22222222-2222-2222-2222-222222222222';
  dA uuid := 'aaaaaaaa-0000-0000-0000-00000000000a';
  dA2 uuid := 'cccccccc-0000-0000-0000-00000000000c';
  dB uuid := 'bbbbbbbb-0000-0000-0000-00000000000b';
begin
  delete from entry_lines  where dossier_id in (dA, dA2, dB);
  delete from entries      where dossier_id in (dA, dA2, dB);
  delete from journals     where dossier_id in (dA, dA2, dB);
  delete from fiscal_years where dossier_id in (dA, dA2, dB);
  delete from accounts     where dossier_id in (dA, dA2, dB);
  delete from dossiers     where id in (dA, dA2, dB);
  delete from cabinet_members where user_id in (uA, uB);
  delete from cabinets     where name in ('Cabinet A', 'Cabinet B');
  delete from app_users    where id in (uA, uB);
end $$;

-- Verrous remis AVANT le montage : l'écriture témoin doit être validée par le
-- chemin normal, sous la protection réelle. Une fixture qui construirait son
-- état hors protection ferait tester une situation que le système n'accepte
-- pas. (Instruction séparée : on ne peut pas réactiver un trigger tant que la
-- transaction porte des événements différés en attente.)
alter table entry_lines enable trigger trg_protect_lines;
alter table entries     enable trigger trg_protect_entries;

-- --- 2) Montage -------------------------------------------------------------

do $$
declare
  uA uuid := '11111111-1111-1111-1111-111111111111';
  uB uuid := '22222222-2222-2222-2222-222222222222';
  dA uuid := 'aaaaaaaa-0000-0000-0000-00000000000a';
  dA2 uuid := 'cccccccc-0000-0000-0000-00000000000c';
  dB uuid := 'bbbbbbbb-0000-0000-0000-00000000000b';
  eA uuid := 'eeeeeeee-0000-0000-0000-00000000000a';
  cabA uuid; cabB uuid; fyA uuid; jA uuid;
  accD uuid; accC uuid;
begin
  insert into app_users(id, email, password_hash, name) values
    (uA, 'alice@cabinet-a.test', 'scrypt$00$00', 'Alice'),
    (uB, 'bob@cabinet-b.test',   'scrypt$00$00', 'Bob');

  cabA := onboard_cabinet(uA, 'Cabinet A', 'CI', 'XOF');
  cabB := onboard_cabinet(uB, 'Cabinet B', 'CI', 'XOF');

  insert into dossiers(id, cabinet_id, raison_sociale, country, base_currency) values
    (dA,  cabA, 'Dossier A',  'CI', 'XOF'),
    (dA2, cabA, 'Dossier A2', 'CI', 'XOF'),
    (dB,  cabB, 'Dossier B',  'CI', 'XOF');

  perform instantiate_chart(dA,  'SYSCOHADA', '2018');
  perform instantiate_chart(dA2, 'SYSCOHADA', '2018');
  perform instantiate_chart(dB,  'SYSCOHADA', '2018');

  insert into fiscal_years(dossier_id, label, start_date, end_date, status)
    values (dA, '2026', '2026-01-01', '2026-12-31', 'open') returning id into fyA;
  insert into fiscal_years(dossier_id, label, start_date, end_date, status)
    values (dA2, '2026', '2026-01-01', '2026-12-31', 'open');
  insert into fiscal_years(dossier_id, label, start_date, end_date, status)
    values (dB, '2026', '2026-01-01', '2026-12-31', 'open');

  insert into journals(dossier_id, code, label, type)
    values (dA, 'OD', 'Opérations diverses', 'operations_diverses') returning id into jA;
  insert into journals(dossier_id, code, label, type)
    values (dA2, 'OD', 'Opérations diverses', 'operations_diverses');
  insert into journals(dossier_id, code, label, type)
    values (dB, 'OD', 'Opérations diverses', 'operations_diverses');

  select id into accD from accounts where dossier_id = dA and account_code = '6011';
  select id into accC from accounts where dossier_id = dA and account_code = '4011';

  -- L'écriture témoin du cabinet A : 777 777 XOF. Créée en brouillon puis
  -- validée — le cycle normal, sous les verrous réels.
  insert into entries(id, dossier_id, fiscal_year_id, journal_id, entry_date, description, status)
    values (eA, dA, fyA, jA, '2026-03-01', 'SECRET-A-CONFIDENTIEL', 'draft');
  insert into entry_lines(entry_id, dossier_id, account_id, line_no, amount_debit, amount_credit)
    values (eA, dA, accD, 1, 777777, 0),
           (eA, dA, accC, 2, 0, 777777);
  update entries set status = 'posted' where id = eA;

  raise notice 'Fixture deux locataires : OK (écriture témoin 777 777 XOF validée).';
end $$;
