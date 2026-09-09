-- =============================================================================
-- Nova Comptabilité — Invariants P0 : tests de régression bloquants
-- =============================================================================
-- Ce fichier rejoue les TROIS attaques que la revue CTO 001 avait réussies, et
-- refuse de passer si l'une d'elles fonctionne encore. Chaque bloc lève une
-- exception à la première violation : le script s'arrête, la CI passe au rouge.
--
--   NOVA-P0-01  fuite inter-locataire par une vue (v_account_balances)
--   NOVA-P0-02  contournement de la RLS par le rôle de connexion
--   NOVA-P0-03  ajout de lignes à une écriture validée (777 777 -> 1 277 777)
--
-- Prérequis : migrations appliquées, puis fixture_two_tenants.sql.
-- Exécution : psql -v ON_ERROR_STOP=1 -f supabase/tests/p0_invariants.sql
--             (rôle propriétaire — le script bascule lui-même vers nova_app)
--
-- Convention : « ATTENDU » décrit ce que le système DOIT faire. Un test qui
-- passe ne prouve pas que le code est bon ; il prouve que cette attaque-là
-- échoue. C'est pour cela qu'on rejoue les scénarios exacts de la revue.
-- =============================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '================ NOVA-P0-03 — IMMUABILITÉ DES ÉCRITURES VALIDÉES ================'

-- Les manipulations se font sous nova_app : c'est le rôle de l'API, donc le
-- seul qui compte. Tester en propriétaire prouverait autre chose.
set role nova_app;
select set_config('app.current_user_id', '11111111-1111-1111-1111-111111111111', false);

-- --- P0-03.1 : INSERT d'UNE seule ligne dans une écriture validée -----------
do $$
declare v_acc uuid; v_ok boolean := false;
begin
  select id into v_acc from accounts
   where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and account_code = '6011';
  begin
    insert into entry_lines(entry_id, dossier_id, account_id, amount_debit, amount_credit, label)
      values ('eeeeeeee-0000-0000-0000-00000000000a',
              'aaaaaaaa-0000-0000-0000-00000000000a', v_acc, 1, 0, 'ATTAQUE-1-LIGNE');
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL P0-03.1 : une ligne a pu être AJOUTÉE à une écriture validée';
  end if;
  raise notice 'PASS P0-03.1 : ajout d''une ligne à une écriture validée refusé';
end $$;

-- --- P0-03.2 : LE SCÉNARIO HISTORIQUE — deux lignes ÉQUILIBRÉES -------------
-- C'est l'attaque exacte de la revue : la paire équilibrée laisse la somme
-- inchangée, donc le trigger d'équilibre ne la voit pas. 777 777 -> 1 277 777.
do $$
declare
  v_d uuid; v_c uuid; v_ok boolean := false;
  v_avant numeric; v_apres numeric;
begin
  select id into v_d from accounts
   where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and account_code = '6011';
  select id into v_c from accounts
   where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and account_code = '4011';

  select coalesce(sum(amount_debit), 0) into v_avant from entry_lines
   where entry_id = 'eeeeeeee-0000-0000-0000-00000000000a';
  if v_avant <> 777777 then
    raise exception 'FIXTURE INVALIDE : écriture témoin à % au lieu de 777777', v_avant;
  end if;

  begin
    insert into entry_lines(entry_id, dossier_id, account_id, amount_debit, amount_credit, label)
      values ('eeeeeeee-0000-0000-0000-00000000000a',
              'aaaaaaaa-0000-0000-0000-00000000000a', v_d, 500000, 0, 'INJECTE-FRAUDE'),
             ('eeeeeeee-0000-0000-0000-00000000000a',
              'aaaaaaaa-0000-0000-0000-00000000000a', v_c, 0, 500000, 'INJECTE-FRAUDE');
  exception when others then v_ok := true;
  end;

  select coalesce(sum(amount_debit), 0) into v_apres from entry_lines
   where entry_id = 'eeeeeeee-0000-0000-0000-00000000000a';

  if not v_ok or v_apres <> 777777 then
    raise exception
      'FAIL P0-03.2 : écriture validée gonflée de % à % (scénario historique de la revue)',
      v_avant, v_apres;
  end if;
  raise notice 'PASS P0-03.2 : paire équilibrée refusée — l''écriture reste à 777 777';
end $$;

-- --- P0-03.3 : UPDATE d'une ligne validée -----------------------------------
do $$
declare v_ok boolean := false;
begin
  begin
    update entry_lines set amount_debit = 1
     where entry_id = 'eeeeeeee-0000-0000-0000-00000000000a' and amount_debit > 0;
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL P0-03.3 : ligne validée modifiable'; end if;
  raise notice 'PASS P0-03.3 : modification d''une ligne validée refusée';
end $$;

-- --- P0-03.4 : DELETE d'une ligne validée -----------------------------------
do $$
declare v_ok boolean := false;
begin
  begin
    delete from entry_lines where entry_id = 'eeeeeeee-0000-0000-0000-00000000000a';
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL P0-03.4 : ligne validée supprimable'; end if;
  raise notice 'PASS P0-03.4 : suppression d''une ligne validée refusée';
end $$;

-- --- P0-03.5 : modification des données économiques de l'en-tête ------------
-- Le montant n'est pas la seule donnée économique : la date, le journal et
-- l'exercice décident de la période d'imputation, la référence de pièce est la
-- clé de la piste d'audit.
do $$
declare v_ok boolean;
begin
  foreach v_ok in array array[false, false, false] loop end loop;  -- lisibilité
  -- date
  v_ok := false;
  begin update entries set entry_date = '2026-06-01'
         where id = 'eeeeeeee-0000-0000-0000-00000000000a';
  exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL P0-03.5a : date d''une écriture validée modifiable'; end if;

  -- référence de pièce
  v_ok := false;
  begin update entries set piece_ref = 'FALSIFIE'
         where id = 'eeeeeeee-0000-0000-0000-00000000000a';
  exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL P0-03.5b : référence de pièce modifiable après validation'; end if;

  -- horodatage de validation
  v_ok := false;
  begin update entries set posted_at = now() - interval '1 year'
         where id = 'eeeeeeee-0000-0000-0000-00000000000a';
  exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL P0-03.5c : horodatage de validation antidatable'; end if;

  raise notice 'PASS P0-03.5 : date, référence de pièce et horodatage verrouillés';
end $$;

-- --- P0-03.6 : suppression de l'écriture validée ----------------------------
do $$
declare v_ok boolean := false;
begin
  begin delete from entries where id = 'eeeeeeee-0000-0000-0000-00000000000a';
  exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL P0-03.6 : écriture validée supprimable'; end if;
  raise notice 'PASS P0-03.6 : suppression d''une écriture validée refusée';
end $$;

-- --- P0-03.7 à .9 : ce qui doit RESTER POSSIBLE -----------------------------
-- Un verrou qui bloque aussi le travail légitime n'est pas un verrou, c'est une
-- panne. On vérifie que le cycle normal fonctionne toujours.
do $$
declare
  v_fy uuid; v_j uuid; v_d uuid; v_c uuid; v_e uuid; v_n int;
begin
  select id into v_fy from fiscal_years where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  select id into v_j  from journals     where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  select id into v_d  from accounts     where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and account_code = '6011';
  select id into v_c  from accounts     where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and account_code = '4011';

  -- .7 création d'un brouillon
  insert into entries(dossier_id, fiscal_year_id, journal_id, entry_date, description, status)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', v_fy, v_j, '2026-04-01', 'CYCLE-NORMAL', 'draft')
    returning id into v_e;
  raise notice 'PASS P0-03.7 : création d''un brouillon';

  -- .8 ajout de lignes à un brouillon
  insert into entry_lines(entry_id, dossier_id, account_id, line_no, amount_debit, amount_credit)
    values (v_e, 'aaaaaaaa-0000-0000-0000-00000000000a', v_d, 1, 1000, 0),
           (v_e, 'aaaaaaaa-0000-0000-0000-00000000000a', v_c, 2, 0, 1000);
  raise notice 'PASS P0-03.8 : ajout de lignes à un brouillon';

  -- .9 validation d'un brouillon équilibré
  update entries set status = 'posted' where id = v_e;
  select count(*) into v_n from entries where id = v_e and status = 'posted';
  if v_n <> 1 then raise exception 'FAIL P0-03.9 : un brouillon équilibré ne se valide plus'; end if;
  raise notice 'PASS P0-03.9 : validation d''un brouillon équilibré';
end $$;

-- --- P0-03.10 : la contre-passation, seule sortie d'une écriture validée ----
-- Sémantique posée par la migration 0075 : l'écriture d'origine RESTE 'posted'
-- et reste au grand livre — on ne l'efface pas, on lui oppose une écriture de
-- sens inverse. Elle est marquée par reversed_by_entry_id. Attendre ici le
-- statut 'reversed' testerait l'ancien comportement, celui que 0075 a corrigé
-- parce qu'il sortait l'écriture des comptes et laissait le solde à l'opposé.
do $$
declare v_rev uuid; v_src record; v_net numeric;
begin
  v_rev := reverse_entry('eeeeeeee-0000-0000-0000-00000000000a', '2026-05-01');

  select status, reversed_by_entry_id into v_src
    from entries where id = 'eeeeeeee-0000-0000-0000-00000000000a';
  if v_src.status <> 'posted' then
    raise exception 'FAIL P0-03.10a : l''origine devrait rester ''posted'' (0075), elle est ''%''', v_src.status;
  end if;
  if v_src.reversed_by_entry_id is distinct from v_rev then
    raise exception 'FAIL P0-03.10b : l''origine n''est pas marquée comme contre-passée';
  end if;
  if (select status from entries where id = v_rev) <> 'posted' then
    raise exception 'FAIL P0-03.10c : l''extourne n''est pas validée';
  end if;
  if (select sum(amount_debit) - sum(amount_credit) from entry_lines where entry_id = v_rev) <> 0 then
    raise exception 'FAIL P0-03.10d : extourne déséquilibrée';
  end if;

  -- Le contrôle qui compte vraiment : les deux écritures s'annulent au compte.
  select coalesce(sum(l.amount_debit - l.amount_credit), 0) into v_net
    from entry_lines l join entries e on e.id = l.entry_id
   where e.id in ('eeeeeeee-0000-0000-0000-00000000000a', v_rev) and e.status = 'posted';
  if v_net <> 0 then
    raise exception 'FAIL P0-03.10e : origine + extourne ne s''annulent pas (net = %)', v_net;
  end if;

  raise notice 'PASS P0-03.10 : contre-passation contrôlée (origine marquée et conservée, net = 0)';
end $$;

-- --- P0-03.11 : l'extourne elle-même est figée dès sa validation ------------
-- Une extourne est une écriture validée comme une autre. Si on pouvait la
-- gonfler après coup, la contre-passation deviendrait une porte d'entrée vers
-- le grand livre — exactement ce que 0078 vient de fermer.
do $$
declare v_rev uuid; v_acc uuid; v_ok boolean := false;
begin
  select reversed_by_entry_id into v_rev
    from entries where id = 'eeeeeeee-0000-0000-0000-00000000000a';
  select id into v_acc from accounts
   where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and account_code = '6011';

  begin
    insert into entry_lines(entry_id, dossier_id, account_id, amount_debit, amount_credit, label)
      values (v_rev, 'aaaaaaaa-0000-0000-0000-00000000000a', v_acc, 1, 0, 'ATTAQUE-EXTOURNE');
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL P0-03.11 : l''extourne accepte encore des lignes après validation';
  end if;

  -- Et une écriture déjà contre-passée ne se contre-passe pas deux fois.
  v_ok := false;
  begin perform reverse_entry('eeeeeeee-0000-0000-0000-00000000000a');
  exception when others then v_ok := true; end;
  if not v_ok then
    raise exception 'FAIL P0-03.11 : double contre-passation acceptée';
  end if;

  raise notice 'PASS P0-03.11 : extourne figée, et pas de double contre-passation';
end $$;

reset role;
select set_config('app.current_user_id', '', false);

\echo ''
\echo '================ NOVA-P0-01 — ISOLATION DES VUES ================'

-- --- P0-01.1 : Bob (cabinet B) ne voit rien de A, ni en table ni en vue -----
set role nova_app;
select set_config('app.current_user_id', '22222222-2222-2222-2222-222222222222', false);

do $$
declare v_tables int; v_vue int; v_montant numeric;
begin
  select count(*) into v_tables from entry_lines
   where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if v_tables <> 0 then
    raise exception 'FAIL P0-01.1a : Bob lit % ligne(s) du cabinet A en table', v_tables;
  end if;

  select count(*), coalesce(sum(total_debit), 0) into v_vue, v_montant
    from v_account_balances
   where dossier_id in ('aaaaaaaa-0000-0000-0000-00000000000a',
                        'cccccccc-0000-0000-0000-00000000000c');
  if v_vue <> 0 then
    raise exception
      'FAIL P0-01.1b : Bob lit % ligne(s) / % XOF du cabinet A via v_account_balances',
      v_vue, v_montant;
  end if;
  raise notice 'PASS P0-01.1 : Bob ne voit le cabinet A ni en table ni par la vue';
end $$;

-- --- P0-01.2 : la vue reste fail-closed SANS contexte utilisateur -----------
select set_config('app.current_user_id', '', false);
do $$
declare v_tables int; v_vue int;
begin
  select count(*) into v_tables from entry_lines;
  select count(*) into v_vue    from v_account_balances;
  if v_tables <> 0 then
    raise exception 'FAIL P0-01.2a : % ligne(s) lisibles sans identité', v_tables;
  end if;
  if v_vue <> 0 then
    raise exception 'FAIL P0-01.2b : la vue renvoie % ligne(s) sans identité (fail-open)', v_vue;
  end if;
  raise notice 'PASS P0-01.2 : sans identité, tables ET vue renvoient zéro ligne';
end $$;

-- --- P0-01.3 : Alice voit son propre périmètre (le verrou n'a pas tout cassé)
select set_config('app.current_user_id', '11111111-1111-1111-1111-111111111111', false);
do $$
declare v_vue int;
begin
  select count(*) into v_vue from v_account_balances
   where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if v_vue = 0 then
    raise exception 'FAIL P0-01.3 : Alice ne voit plus ses propres soldes — la vue est cassée';
  end if;
  raise notice 'PASS P0-01.3 : Alice voit ses soldes (% ligne(s))', v_vue;
end $$;

-- --- P0-01.4 : aucune AUTRE vue ne contourne la RLS -------------------------
-- Le défaut n'était pas « cette vue-là » mais « les vues en général ». On
-- interdit la classe entière plutôt que l'instance.
do $$
declare r record; v_manquantes text := '';
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
       and not coalesce((select option_value::boolean
                           from pg_options_to_table(c.reloptions)
                          where option_name = 'security_invoker'), false)
  loop
    v_manquantes := v_manquantes || ' ' || r.relname;
  end loop;
  if v_manquantes <> '' then
    raise exception 'FAIL P0-01.4 : vue(s) sans security_invoker :%', v_manquantes;
  end if;
  raise notice 'PASS P0-01.4 : toutes les vues du schéma sont en security_invoker';
end $$;

reset role;
select set_config('app.current_user_id', '', false);

\echo ''
\echo '================ NOVA-P0-02 — FRONTIÈRE LOCATAIRE CÔTÉ BASE ================'

-- --- P0-02.1 : FORCE ROW LEVEL SECURITY sur les tables porteuses de données -
-- Sans FORCE, la RLS ne s'applique pas au propriétaire des tables : il suffit
-- que DATABASE_URL pointe sur lui pour que toute l'étanchéité disparaisse.
do $$
declare r record; v_sans text := ''; v_n int := 0;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relrowsecurity and not c.relforcerowsecurity
  loop
    v_sans := v_sans || ' ' || r.relname; v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    raise exception 'FAIL P0-02.1 : % table(s) à RLS sans FORCE :%', v_n, v_sans;
  end if;
  raise notice 'PASS P0-02.1 : toutes les tables à RLS sont en FORCE ROW LEVEL SECURITY';
end $$;

-- --- P0-02.2 : le rôle applicatif ne peut pas contourner la RLS -------------
do $$
declare r record;
begin
  select rolsuper, rolbypassrls into r from pg_roles where rolname = 'nova_app';
  if r is null then raise exception 'FAIL P0-02.2 : rôle nova_app absent'; end if;
  if r.rolsuper then raise exception 'FAIL P0-02.2 : nova_app est SUPERUSER'; end if;
  if r.rolbypassrls then raise exception 'FAIL P0-02.2 : nova_app a BYPASSRLS'; end if;
  raise notice 'PASS P0-02.2 : nova_app est NOSUPERUSER + NOBYPASSRLS';
end $$;

-- --- P0-02.3 : nova_app n'est propriétaire d'aucune table locataire ---------
-- Même avec FORCE, un propriétaire garde le droit de faire ALTER TABLE ... NO
-- FORCE. La non-propriété est donc la garantie de fond.
do $$
declare v_n int; v_liste text;
begin
  select count(*), string_agg(c.relname, ' ') into v_n, v_liste
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relrowsecurity
     and pg_get_userbyid(c.relowner) = 'nova_app';
  if v_n > 0 then
    raise exception 'FAIL P0-02.3 : nova_app possède % table(s) locataire :%', v_n, v_liste;
  end if;
  raise notice 'PASS P0-02.3 : nova_app ne possède aucune table locataire';
end $$;

-- --- P0-02.4 : les six attaques inter-cabinets de la revue ------------------
set role nova_app;
select set_config('app.current_user_id', '22222222-2222-2222-2222-222222222222', false);

do $$
declare v_n int; v_ok boolean; v_cabA uuid;
begin
  -- T1 — lire les écritures de A
  select count(*) into v_n from entries where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if v_n <> 0 then raise exception 'FAIL attaque T1 : Bob lit % écriture(s) de A', v_n; end if;

  -- Le cabinet A n'est même pas visible : on récupère son id hors RLS pour les
  -- attaques suivantes, qui doivent échouer sur l'autorisation, pas sur la
  -- méconnaissance de l'identifiant.
  reset role;
  select id into v_cabA from cabinets where name = 'Cabinet A';
  set role nova_app;
  perform set_config('app.current_user_id', '22222222-2222-2222-2222-222222222222', false);

  -- R1 — lister les membres du cabinet A
  v_ok := false;
  begin perform cabinet_members_list(v_cabA); exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL attaque R1 : Bob liste les membres du cabinet A'; end if;

  -- R2 — s'ajouter au cabinet A
  v_ok := false;
  begin perform cabinet_member_add(v_cabA, 'bob@cabinet-b.test', 'owner');
  exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL attaque R2 : Bob s''ajoute au cabinet A'; end if;

  -- R3 — renommer le cabinet A
  v_ok := false;
  begin perform cabinet_rename(v_cabA, 'PIRATE'); exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL attaque R3 : Bob renomme le cabinet A'; end if;

  -- R4 — contre-passer une écriture de A
  v_ok := false;
  begin perform reverse_entry('eeeeeeee-0000-0000-0000-00000000000a');
  exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL attaque R4 : Bob contre-passe une écriture de A'; end if;

  -- R5 — s'attribuer un accès au dossier A
  v_ok := false;
  begin
    insert into dossier_access(dossier_id, user_id, role)
      values ('aaaaaaaa-0000-0000-0000-00000000000a',
              '22222222-2222-2222-2222-222222222222', 'client');
  exception when others then v_ok := true; end;
  if not v_ok then raise exception 'FAIL attaque R5 : Bob s''octroie un accès au dossier A'; end if;

  -- T2 — lire les soldes de A par la vue (déjà couvert en P0-01.1, rejoué ici
  -- dans la série d'attaques pour que l'échec pointe le bon scénario)
  select count(*) into v_n from v_account_balances
   where dossier_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if v_n <> 0 then raise exception 'FAIL attaque T2 : Bob lit % solde(s) de A par la vue', v_n; end if;

  raise notice 'PASS P0-02.4 : les six attaques inter-cabinets restent bloquées';
end $$;

reset role;
select set_config('app.current_user_id', '', false);

\echo ''
\echo '================ TOUS LES INVARIANTS P0 SONT TENUS ================'
\echo ''
