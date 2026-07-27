-- =============================================================================
-- Nova Comptabilité — 0072 : rattachement analytique des immobilisations
-- =============================================================================
-- Une immobilisation sert une activité : un logiciel sert un produit, un
-- véhicule sert une agence, un four sert un atelier. Sans ce rattachement, la
-- rentabilité par activité ne voit que les charges et les produits — jamais ce
-- que l'activité a coûté en investissement, ni ce qu'il en reste au bilan.
--
-- Le chantier de production interne porte déjà sa section (assets_in_progress) ;
-- l'immobilisation qu'il engendre à la mise en service la perdait. Elle en
-- hérite désormais, et une immobilisation acquise peut être rattachée à la main.
-- =============================================================================

alter table fixed_assets add column if not exists analytic_section text;

create index if not exists fixed_assets_analytic_idx on fixed_assets(dossier_id, analytic_section);
