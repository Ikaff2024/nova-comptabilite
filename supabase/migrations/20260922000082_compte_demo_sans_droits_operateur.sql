-- =============================================================================
-- Nova Comptabilité — 0082 : le compte de démonstration n'est pas un opérateur
-- =============================================================================
-- DÉFAUT CORRIGÉ ICI (audit externe du 21 septembre 2026, constat N01 — P1).
--
-- Le compte proposé pour les démonstrations à des prospects ouvre la « Console
-- Nova » et y lit la volumétrie de TOUS les cabinets clients : 6 cabinets,
-- 7 dossiers, 237 écritures, nombre de membres, dernière activité et coûts
-- d'API par cabinet. Faire une démonstration avec ce compte, c'est montrer au
-- prospect les données d'exploitation de vos autres clients.
--
-- ── Ce n'est pas un contournement d'autorisation ────────────────────────────
--
-- La garde serveur fonctionne : platform_cabinets() lève NOT_PLATFORM_ADMIN si
-- l'appelant n'est pas opérateur, et l'API traduit en 403. Masquer le bouton
-- n'aurait rien réglé, mais il n'y avait rien à régler de ce côté.
--
-- Le défaut est que le compte démo POSSÈDE légitimement ce droit — et qu'il le
-- possède parce que la migration 0051 le lui donne en dur :
--
--     update app_users set is_platform_admin = true
--       where lower(email) in ('ikaffanan@gmail.com', 'demo@nova-comptabilite.ci');
--
-- Ce n'est donc pas une case cochée par erreur sur un environnement : c'est
-- rejoué à l'identique sur toute base neuve, en développement comme en
-- production. Corriger la donnée à la main en production aurait tenu pour cette
-- base-là, et le trou serait revenu au prochain environnement créé.
--
-- ── Correction ──────────────────────────────────────────────────────────────
--
-- On retire le droit opérateur au compte de démonstration, et à lui seul. Le
-- compte de l'éditeur le conserve : c'est sa raison d'être.
--
-- L'ordre des migrations garantit le résultat dans les deux cas : sur une base
-- existante, 0051 a déjà tourné et 0082 corrige ; sur une base neuve, 0051
-- accorde puis 0082 retire. L'état final est le même.
--
-- ── Risque résiduel, volontairement laissé en l'état ────────────────────────
--
-- Désigner les opérateurs par une adresse email écrite en dur dans une
-- migration reste fragile : le jour où l'éditeur change d'adresse, ou bien un
-- client ouvre un compte avec cette adresse, le droit suit l'adresse et non la
-- personne. La cible est une désignation explicite hors migration (variable
-- d'environnement ou geste administratif tracé). Ce n'est pas fait ici :
-- ce serait un changement de modèle, et l'urgence est de refermer la démo.
-- Suivi dans le rapport de vague.
-- =============================================================================

do $$
declare v_touche int;
begin
  update app_users
     set is_platform_admin = false
   where lower(email) = 'demo@nova-comptabilite.ci'
     and is_platform_admin;
  get diagnostics v_touche = row_count;

  if v_touche > 0 then
    raise notice '[0082] compte de démonstration : droits opérateur retirés.';
  else
    raise notice '[0082] compte de démonstration : aucun droit opérateur à retirer.';
  end if;
end $$;
