-- =============================================================================
-- Nova Comptabilité — 0024 : Amortissement dégressif
-- =============================================================================
-- Ajoute le mode 'degressive' aux immobilisations (taux = taux linéaire ×
-- coefficient selon la durée ; bascule en linéaire quand c'est plus avantageux).
-- =============================================================================

alter type depreciation_method add value if not exists 'degressive';
