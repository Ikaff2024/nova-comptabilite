-- =============================================================================
-- Nova Comptabilité — 0085 : un montant qui ne se relit pas n'entre pas
-- =============================================================================
-- Revue CTO 001, constat NOVA-P2-01 — « politique monétaire ».
--
-- Les montants vivent ici en numeric(20,4) : un type EXACT. Le serveur, lui, les
-- manipule en nombre JavaScript, c'est-à-dire en flottant. Cette conversion est
-- le seul endroit du produit où un montant peut changer de valeur sans que
-- personne ne l'ait demandé.
--
-- ── Ce qui a été mesuré, plutôt que supposé ────────────────────────────────
--
-- Un flottant porte exactement les entiers jusqu'à 2^53. Avec quatre décimales,
-- la borne exacte est donc 2^53 / 10^4 ≈ 900 719 925 474,0991.
--
-- Vérifié sur une base jetable :
--     123 456 789 012,3456   revient intact
--   1 234 567 890 123,4567   revient en ...456 8   ← le centime a disparu
--
-- En revanche, N'ONT PRODUIT AUCUN ÉCART : le calcul d'une TVA à 18 % côté
-- serveur puis stockage, et la somme de 100 000 montants côté serveur (dérive de
-- 3·10⁻⁵, très en-dessous de la quatrième décimale, donc absorbée au stockage).
-- Le risque n'est donc ni diffus ni permanent : il est BORNÉ, et silencieux.
--
-- ── Pourquoi une contrainte, et pas une réécriture ─────────────────────────
--
-- Passer le produit à l'arithmétique entière représenterait 634 conversions à
-- reprendre, pour un risque qui ne se matérialise qu'au-delà de 900 milliards.
-- La colonne numeric(20,4) autorise pourtant jusqu'à 10^16 : c'est cet écart
-- entre ce que la base accepte et ce que le serveur sait relire qui est le vrai
-- défaut. On ferme l'écart plutôt que de réécrire le produit.
--
-- À titre de repère, le budget annuel de l'État de Côte d'Ivoire est de l'ordre
-- de 13 000 milliards FCFA. Aucune écriture d'une PME ou d'un cabinet n'approche
-- la borne ; un montant qui la dépasse est, en pratique, une erreur de virgule
-- ou d'unité — et la refuser rend service.
--
-- ── Portée ─────────────────────────────────────────────────────────────────
--
-- `not valid` : la contrainte s'applique aux écritures FUTURES et ne rejoue pas
-- l'existant. Aucun blocage au déploiement, aucune donnée modifiée. La requête
-- de diagnostic en fin de fichier liste ce qui existerait déjà hors bornes ; son
-- redressement est un acte comptable, qui se fait par contre-passation.
-- =============================================================================

-- 900 719 925 474,0991 arrondi à l'unité inférieure, par prudence.
-- Écrit en clair plutôt que calculé : une contrainte doit se lire.
do $$
declare
  v_borne constant numeric := 900719925474;
  r record;
begin
  for r in
    select * from (values
      ('entry_lines', 'amount_debit'),
      ('entry_lines', 'amount_credit'),
      ('entry_lines', 'orig_amount'),
      ('invoice_lines', 'amount_ht'),
      ('invoice_lines', 'amount_tva'),
      ('invoice_lines', 'unit_price'),
      ('invoices', 'total_ht'),
      ('invoices', 'total_tva'),
      ('invoices', 'total_ttc')
    ) as t(tbl, col)
  loop
    -- Idempotent : la migration doit pouvoir être rejouée sans effet.
    execute format('alter table %I drop constraint if exists %I',
                   r.tbl, 'chk_' || r.tbl || '_' || r.col || '_borne');
    execute format(
      'alter table %I add constraint %I check (%I is null or abs(%I) <= %s) not valid',
      r.tbl, 'chk_' || r.tbl || '_' || r.col || '_borne', r.col, r.col, v_borne);
  end loop;
end $$;

-- --- Diagnostic de l'existant -------------------------------------------------
-- Liste les lignes déjà hors bornes, sans rien corriger. Vide sur une base saine.
create or replace view v_montants_hors_bornes
with (security_invoker = true) as
  select l.dossier_id, l.entry_id, l.id as ligne_id,
         greatest(abs(coalesce(l.amount_debit, 0)), abs(coalesce(l.amount_credit, 0))) as montant,
         'ligne d''écriture'::text as origine
    from entry_lines l
   where abs(coalesce(l.amount_debit, 0)) > 900719925474
      or abs(coalesce(l.amount_credit, 0)) > 900719925474
  union all
  select i.dossier_id, null, i.id, abs(coalesce(i.total_ttc, 0)), 'facture'
    from invoices i
   where abs(coalesce(i.total_ttc, 0)) > 900719925474;

grant select on v_montants_hors_bornes to nova_app;
