-- =============================================================================
-- Nova Comptabilité — 0018 : Amortissement mensuel (clôtures mensuelles)
-- =============================================================================
-- Une immobilisation peut s'amortir par exercice ('annual') ou par mois
-- ('monthly'). Le suivi des dotations passe d'une clé annuelle à une clé par
-- DATE de période (dernier jour du mois ou de l'exercice), pour supporter les
-- deux cadences sans doublon.
-- =============================================================================

alter table fixed_assets
  add column depreciation_period text not null default 'annual'
    check (depreciation_period in ('annual', 'monthly'));

-- Clé de période unifiée : date de fin de période (mensuelle ou annuelle).
alter table fixed_asset_depreciations add column period_date date;
update fixed_asset_depreciations set period_date = make_date(period_year, 12, 31) where period_date is null;
alter table fixed_asset_depreciations alter column period_date set not null;

-- Remplace l'ancienne unicité (asset, année) par (asset, date de période).
do $$
declare cn text;
begin
  select conname into cn from pg_constraint
    where conrelid = 'fixed_asset_depreciations'::regclass and contype = 'u' limit 1;
  if cn is not null then execute 'alter table fixed_asset_depreciations drop constraint ' || quote_ident(cn); end if;
end $$;

create unique index fa_dep_period_uk on fixed_asset_depreciations(fixed_asset_id, period_date);
