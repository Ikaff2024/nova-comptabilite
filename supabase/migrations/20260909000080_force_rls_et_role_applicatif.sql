-- =============================================================================
-- Nova Comptabilité — 0080 : durcissement de la frontière locataire côté base
-- =============================================================================
-- Volet BASE de la faille NOVA-P0-02 (revue CTO 001). Le volet APPLICATIF — la
-- garde de démarrage qui refuse une identité PostgreSQL dangereuse — vit dans
-- server/dbguard.ts. Les deux sont nécessaires ; ni l'un ni l'autre ne suffit.
--
-- ── Le défaut ───────────────────────────────────────────────────────────────
--
-- Les 57 tables portaient bien ENABLE ROW LEVEL SECURITY, mais aucune n'avait
-- FORCE. Or la RLS ne s'applique JAMAIS au propriétaire d'une table tant
-- qu'elle n'est pas forcée. Toute l'étanchéité de Nova reposait donc sur une
-- hypothèse non vérifiée à l'exécution : que DATABASE_URL désigne un rôle qui
-- n'est ni propriétaire, ni superutilisateur, ni BYPASSRLS.
--
-- Reproduction : même code applicatif, même contexte utilisateur, connexion en
-- rôle propriétaire — un utilisateur du cabinet B lisait « SECRET-A-
-- CONFIDENTIEL », l'écriture du cabinet A. Sans erreur, sans log, sans
-- symptôme : l'application montre simplement tout à tout le monde.
--
-- Les Postgres managés (Railway, Neon, Supabase, RDS) fournissent par défaut
-- une chaîne de connexion en propriétaire ou en superutilisateur. Le risque
-- n'est donc pas théorique : c'est le chemin par défaut.
--
-- ── Ce que FORCE couvre, et ce qu'il ne couvre pas ──────────────────────────
--
-- Il faut être précis, parce que la nuance décide de l'architecture :
--
--   rôle PROPRIÉTAIRE non-superutilisateur  -> FORCE le soumet à la RLS.   ✅
--   rôle SUPERUSER                          -> ignore la RLS, FORCE ou pas. ❌
--   rôle BYPASSRLS                          -> ignore la RLS, FORCE ou pas. ❌
--
-- Vérifié pendant la remédiation : avec FORCE posé sur les 57 tables, une
-- connexion superutilisateur lisait TOUJOURS les écritures de l'autre cabinet.
-- FORCE ne ferme donc qu'un cas sur trois.
--
-- C'est pour cela que la garde de démarrage (server/dbguard.ts) est la mesure
-- principale : elle refuse le démarrage sur les trois cas. FORCE reste utile —
-- il ferme le cas propriétaire, celui qu'aucune vérification de rôle ne
-- distinguerait d'un rôle applicatif légitime si les droits venaient à dériver.
--
-- ── Compatibilité : vérifiée, pas supposée ──────────────────────────────────
--
-- FORCE s'applique aussi au propriétaire, donc aux 37 fonctions SECURITY
-- DEFINER (toutes possédées par le propriétaire des tables) et aux migrations.
-- Le risque théorique était double : récursion des policies (les 57 policies
-- appellent app_dossier_ids(), qui lit lui-même dossiers et cabinet_members),
-- et blocage des chemins privilégiés (connexion, inscription, onboarding).
--
-- Les 15 suites de tests adossées à la base ont été rejouées avec FORCE posé
-- partout : 438 contrôles, aucun échec. Contrôles ciblés également vérifiés :
-- get_user_for_login (connexion sans identité en session), register_user,
-- onboard_cabinet, lecture des dossiers et des cabinets. Aucune récursion.
--
-- POINT DE VIGILANCE À CONNAÎTRE : si MIGRATION_DATABASE_URL désigne un rôle
-- propriétaire NON superutilisateur, une future migration qui fait un backfill
-- sur une table locataire se verra appliquer la RLS et ne verra aucune ligne —
-- silencieusement. Deux parades : soit ce rôle est superutilisateur ou
-- BYPASSRLS (cas courant chez les hébergeurs managés), soit la migration pose
-- explicitement app.current_user_id, soit elle désactive localement la policy.
-- À vérifier au moment d'écrire une migration de reprise de données.
-- =============================================================================

-- --- 1) FORCE ROW LEVEL SECURITY sur toutes les tables déjà sous RLS ---------
-- Boucle plutôt que liste figée : le jour où une table est ajoutée avec RLS,
-- rejouer cette logique la couvrirait. Et pour que l'oubli se voie tout de
-- suite, supabase/tests/p0_invariants.sql (§ P0-02.1) échoue si UNE table à
-- RLS n'est pas en FORCE. Le contrôle porte sur la règle, pas sur une liste.

do $$
declare r record; n int := 0;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n2 on n2.oid = c.relnamespace
     where n2.nspname = 'public'
       and c.relkind = 'r'
       and c.relrowsecurity
       and not c.relforcerowsecurity
  loop
    execute format('alter table public.%I force row level security', r.relname);
    n := n + 1;
  end loop;
  raise notice '[0080] FORCE ROW LEVEL SECURITY posé sur % table(s).', n;
end $$;

-- --- 2) Le rôle applicatif ne doit pas pouvoir contourner la RLS -------------
-- Ce sont les valeurs par défaut de CREATE ROLE, mais une base peut avoir
-- dérivé (droits élargis à la main pour débloquer un incident, puis oubliés).
-- On réaffirme l'état attendu ; l'opération est sans effet si tout va bien.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'nova_app') then
    execute 'alter role nova_app nosuperuser nobypassrls nocreatedb nocreaterole';
    raise notice '[0080] nova_app : NOSUPERUSER, NOBYPASSRLS confirmés.';
  else
    raise notice '[0080] rôle nova_app absent de cette base — rien à durcir.';
  end if;
end $$;

-- --- 3) Note d'architecture : propriété des tables ---------------------------
-- La cible est un rôle de migration (propriétaire, DDL) distinct du rôle
-- applicatif (runtime, sans DDL, non propriétaire) :
--
--     rôle de migration  ->  DDL, propriétaire des tables   (MIGRATION_DATABASE_URL)
--     nova_app           ->  runtime API, NOBYPASSRLS, non propriétaire (DATABASE_URL)
--
-- Cette migration ne CHANGE aucune propriété d'objet : le faire depuis une
-- migration supposerait de connaître le rôle propriétaire cible, qui dépend de
-- l'hébergeur, et un REASSIGN raté rendrait la base inadministrable. La
-- séparation est donc une exigence de déploiement, et c'est la garde de
-- démarrage qui la vérifie à l'exécution : elle refuse de démarrer si le rôle
-- de DATABASE_URL possède une table locataire.
