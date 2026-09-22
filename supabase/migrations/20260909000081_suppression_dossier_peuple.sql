-- =============================================================================
-- Nova Comptabilité — 0081 : la suppression d'un dossier réel ne fonctionnait pas
-- =============================================================================
-- DÉFAUT CORRIGÉ ICI (NOUVEAU-P1-A, découvert pendant la vague P0).
--
-- dossier_delete() échouait sur TOUT dossier contenant une écriture validée —
-- c'est-à-dire sur tout dossier réel. Le démontage fait `delete from
-- entry_lines` puis `delete from entries`, et les verrous d'immuabilité
-- (trg_protect_lines / trg_protect_entries) refusent ces suppressions :
--
--     ERROR: Suppression interdite : les lignes de l'écriture … sont verrouillées
--     CONTEXT: SQL statement "delete from entry_lines where dossier_id = p_dossier"
--              PL/pgSQL function dossier_delete(uuid) line 23
--
-- Le défaut est ANTÉRIEUR à la vague P0 (vérifié sur une base sans la migration
-- 0078 : même échec, message différent). Il n'avait pas été vu parce que le
-- test de sécurité existant supprime un dossier VIDE.
--
-- ── La politique appliquée est celle déjà décidée, pas une nouvelle ─────────
--
-- La suppression physique est le comportement documenté du produit :
--   · migration 0068 : « suppression d'un dossier … ATTENTION : opération
--     IRRÉVERSIBLE » ;
--   · commit 9f3ed09 : « Zone de danger » dans la Fiche entreprise, avec
--     confirmation par saisie exacte du nom ;
--   · README : « Une pièce n'est supprimée qu'en cascade, avec son dossier ».
--
-- La colonne dossiers.is_active existe mais n'est jamais mise à false : ce
-- n'est pas un mécanisme d'archivage, seulement un filtre de lecture. On ne
-- change donc pas de modèle ici — on fait fonctionner celui qui est décidé.
--
-- ── Comment ouvrir la porte sans la laisser ouverte ────────────────────────
--
-- Exigence : le correctif ne doit JAMAIS rendre possible un DELETE d'écriture
-- validée depuis une route normale.
--
-- L'exemption exige DEUX conditions simultanées, et l'API ne peut satisfaire
-- que la première :
--
--   1. le drapeau de transaction app.dossier_teardown porte l'identifiant EXACT
--      du dossier de la ligne ;
--   2. current_user est PROPRIÉTAIRE de la table.
--
-- La condition 2 est le vrai verrou. Le rôle applicatif (nova_app) n'est pas
-- propriétaire — c'est même vérifié au démarrage par server/dbguard.ts, qui
-- refuse de lancer l'API si le rôle runtime possède une table sous RLS.
-- current_user ne vaut le propriétaire QUE dans une fonction SECURITY DEFINER,
-- c'est-à-dire ici dans dossier_delete et nulle part ailleurs. Un client qui
-- poserait lui-même le GUC resterait donc bloqué.
--
-- L'exemption ne couvre que DELETE : ni INSERT ni UPDATE, dans aucun cas.
-- Et elle est bornée à un seul dossier à la fois, nommé explicitement.
--
-- Alternative écartée : `alter table … disable trigger` dans la fonction. Elle
-- aurait aussi été réservée au propriétaire, mais prend un verrou ACCESS
-- EXCLUSIVE sur entries et entry_lines — donc bloque la comptabilité de TOUS
-- les cabinets pendant la suppression.
--
-- Régression couverte par server/integration-test-dossier-lifecycle.ts.
-- =============================================================================

-- --- 1) Reconnaissance du démontage autorisé ---------------------------------

create or replace function dossier_teardown_autorise(p_dossier uuid, p_table text)
returns boolean
language sql stable security invoker set search_path = public as $$
  select
    -- (1) démontage explicitement en cours pour CE dossier
    coalesce(nullif(current_setting('app.dossier_teardown', true), ''), '') = p_dossier::text
    -- (2) et exécuté sous l'identité propriétaire de la table (SECURITY DEFINER)
    and exists (
      select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = p_table
        and c.relowner = current_user::regrole
    )
$$;

-- --- 2) Les deux verrous acceptent le démontage, et rien d'autre --------------

create or replace function protect_posted_lines() returns trigger
language plpgsql as $$
declare
  v_entry_id uuid := coalesce(new.entry_id, old.entry_id);
  v_status   entry_status;
begin
  select status into v_status from entries where id = v_entry_id;

  -- Écriture parente absente : suppression en cascade dans la même transaction.
  if v_status is null then
    return coalesce(new, old);
  end if;

  if v_status in ('posted', 'reversed') then
    -- Seule sortie : le démontage complet d'un dossier, sous identité
    -- propriétaire. Jamais un INSERT, jamais un UPDATE.
    if tg_op = 'DELETE' and dossier_teardown_autorise(old.dossier_id, 'entry_lines') then
      return old;
    end if;

    if tg_op = 'INSERT' then
      raise exception
        'Ajout interdit : l''écriture % est comptabilisée, on ne lui ajoute pas de ligne (contre-passez-la)',
        v_entry_id;
    elsif tg_op = 'DELETE' then
      raise exception
        'Suppression interdite : les lignes de l''écriture % sont verrouillées (contre-passez-la)',
        v_entry_id;
    else
      raise exception
        'Modification interdite : les lignes de l''écriture % sont verrouillées (contre-passez-la)',
        v_entry_id;
    end if;
  end if;

  return coalesce(new, old);
end $$;

create or replace function protect_posted_entries() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted', 'reversed') then
      if dossier_teardown_autorise(old.dossier_id, 'entries') then
        return old;
      end if;
      raise exception
        'Suppression interdite : écriture % comptabilisée (contre-passez-la)', old.id;
    end if;
    return old;
  end if;

  if old.status in ('posted', 'reversed') then
    if new.status not in ('posted', 'reversed') then
      raise exception
        'Retour arrière interdit : l''écriture % est comptabilisée, elle ne redevient pas un brouillon', old.id;
    end if;

    -- Liste blanche : tout champ hors reversed_by_entry_id / reverses_entry_id
    -- doit être identique. La comparaison via to_jsonb fige par défaut toute
    -- colonne ajoutée plus tard au schéma.
    if (to_jsonb(new) - 'status' - 'reversed_by_entry_id' - 'reverses_entry_id')
       is distinct from
       (to_jsonb(old) - 'status' - 'reversed_by_entry_id' - 'reverses_entry_id') then
      raise exception
        'Modification interdite : l''écriture % est comptabilisée, elle est immuable (contre-passez-la)', old.id;
    end if;
  end if;

  return new;
end $$;

-- --- 3) dossier_delete : pose le drapeau, trace, et démonte -------------------

create or replace function dossier_delete(p_dossier uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cabinet uuid;
  v_caller  cabinet_role;
  v_nom     text;
  v_ecr     bigint;
  v_lig     bigint;
begin
  select cabinet_id, raison_sociale into v_cabinet, v_nom from dossiers where id = p_dossier;
  if v_cabinet is null then raise exception 'Dossier introuvable'; end if;

  select cm.role into v_caller from cabinet_members cm
   where cm.cabinet_id = v_cabinet and cm.user_id = app_current_user_id();

  -- Motif sûr : on teste explicitement le NULL (non-membre) AVANT le rôle.
  -- Sans cela, `NULL in ('owner','associe')` vaut NULL, `not NULL` vaut NULL,
  -- et l'exception n'est jamais levée — c'était la faille corrigée en 0077.
  if not app_is_platform_admin()
     and (v_caller is null or v_caller not in ('owner', 'associe')) then
    raise exception 'Suppression réservée au propriétaire ou à un associé du cabinet';
  end if;

  -- Volumétrie AVANT suppression : après, il n'y a plus rien à compter, et la
  -- piste d'audit doit dire ce qui a disparu.
  select count(*) into v_ecr from entries     where dossier_id = p_dossier;
  select count(*) into v_lig from entry_lines where dossier_id = p_dossier;

  -- Trace d'abord : audit_log porte dossier_id en ON DELETE SET NULL, donc la
  -- ligne SURVIT à la suppression du dossier. On recopie l'identifiant dans le
  -- détail pour qu'il reste lisible une fois la référence dénouée.
  insert into audit_log(user_id, user_name, user_email, dossier_id, action, entity, entity_id, detail)
  values (app_current_user_id(),
          (select name  from app_users where id = app_current_user_id()),
          (select email from app_users where id = app_current_user_id()),
          p_dossier, 'dossier.deleted', 'dossier', p_dossier::text,
          jsonb_build_object('dossier_id', p_dossier, 'raison_sociale', v_nom,
                             'cabinet_id', v_cabinet, 'ecritures', v_ecr, 'lignes', v_lig));

  -- Drapeau de démontage : transaction-local (troisième argument true). Il
  -- retombe donc de lui-même au commit comme au rollback — aucun état rémanent
  -- ne peut être laissé derrière, même si la suite échoue.
  perform set_config('app.dossier_teardown', p_dossier::text, true);

  -- Démontage ordonné. Les 49 autres tables portant dossier_id descendent en
  -- cascade ; seules celles-ci ont des clés « on delete restrict » qui bloquent.
  delete from bank_pointings      where dossier_id = p_dossier;
  delete from lettrage_lines      where dossier_id = p_dossier;
  delete from lettrages           where dossier_id = p_dossier;
  delete from invoices            where dossier_id = p_dossier;
  delete from purchase_invoices   where dossier_id = p_dossier;
  delete from recurring_templates where dossier_id = p_dossier;
  delete from entry_lines         where dossier_id = p_dossier;
  update entries set reverses_entry_id = null, reversed_by_entry_id = null where dossier_id = p_dossier;
  delete from entries             where dossier_id = p_dossier;

  delete from dossiers where id = p_dossier;

  -- Refermer explicitement, sans attendre la fin de transaction : la connexion
  -- est rendue au pool et pourrait servir une autre requête dans la même
  -- transaction applicative.
  perform set_config('app.dossier_teardown', '', true);
end $$;

grant execute on function dossier_delete(uuid) to nova_app;
grant execute on function dossier_teardown_autorise(uuid, text) to nova_app;
