-- =============================================================================
-- Nova Comptabilité — 0032 : Section analytique sur les lignes de facture
-- =============================================================================
-- Permet de ventiler chaque ligne de vente sur une section analytique. À
-- l'émission, le produit (70x) est regroupé par (compte, section) et chaque
-- ligne d'écriture porte son axe (entry_lines.analytic_axis).
-- =============================================================================

alter table invoice_lines add column if not exists analytic_axis text;
