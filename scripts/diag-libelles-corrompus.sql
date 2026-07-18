-- =============================================================================
-- Diagnostic : comptes dont le LIBELLÉ contient le caractère de remplacement
-- « � » (U+FFFD) — séquelle d'un ancien import de balance lu en UTF-8 forcé
-- alors que le fichier était en Windows-1252. À exécuter dans Neon → SQL Editor.
--
-- Le fix côté app est livré (import auto-détecte l'encodage + auto-réparation
-- au ré-import). Ce script sert juste à REPÉRER ce qui reste à ré-importer.
-- =============================================================================

-- 1) Par dossier : combien de comptes ont un libellé corrompu ?
select d.id as dossier_id, d.raison_sociale, count(*) as comptes_corrompus
  from accounts a
  join dossiers d on d.id = a.dossier_id
 where a.label like '%' || chr(65533) || '%'   -- chr(65533) = U+FFFD = « � »
 group by d.id, d.raison_sociale
 order by comptes_corrompus desc;

-- 2) Détail : les comptes concernés (utile pour vérifier après ré-import).
--    Filtre optionnel sur un dossier : décommente la clause AND.
select d.raison_sociale, a.account_code, a.label
  from accounts a
  join dossiers d on d.id = a.dossier_id
 where a.label like '%' || chr(65533) || '%'
   -- and d.raison_sociale ilike '%démonstration%'
 order by d.raison_sociale, a.account_code;

-- 3) (Optionnel) Même contrôle sur les libellés du MODÈLE de plan partagé,
--    au cas où la corruption viendrait d'un template importé.
select account_code, label
  from chart_template_accounts
 where label like '%' || chr(65533) || '%'
 order by account_code;
