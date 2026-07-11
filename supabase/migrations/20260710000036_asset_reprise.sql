-- =============================================================================
-- Nova Comptabilité — 0036 : Reprise d'immobilisations (migration d'antériorité)
-- =============================================================================
-- Un bien acquis AVANT la bascule sur Nova a déjà été amorti en partie. Son
-- cumul d'amortissements est déjà repris via l'à-nouveau (compte 28x). On
-- enregistre le bien au registre avec ce cumul repris et la date de reprise ;
-- le plan d'amortissement ne génère alors QUE les dotations futures, à partir
-- du cumul repris — aucune dotation passée n'est re-comptabilisée.
-- =============================================================================

alter table fixed_assets
  add column if not exists reprise_cumul numeric(20,4) not null default 0,
  add column if not exists reprise_date  date;
