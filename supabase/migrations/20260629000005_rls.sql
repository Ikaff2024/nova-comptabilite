-- =============================================================================
-- Nova Comptabilité — 0005 : Row-Level Security (isolation multi-tenant)
-- =============================================================================
-- PORTABLE / INFRA-AGNOSTIQUE : l'identité de l'utilisateur courant ne dépend
-- PAS d'un fournisseur (pas de auth.uid() Supabase). Elle est lue dans une
-- variable de session Postgres `app.current_user_id`, que le backend positionne
-- au début de chaque requête/transaction :
--
--     SET LOCAL app.current_user_id = '<uuid de l'utilisateur authentifié>';
--
-- Fonctionne identiquement sur Railway, Neon, RDS, Postgres local ET Supabase.
-- Sur Supabase, un hook de session peut faire : SET app.current_user_id = auth.uid().
--
-- Connexions d'administration / service (migrations, jobs) : utiliser un rôle
-- avec BYPASSRLS, OU le propriétaire des tables. Sans GUC positionné, les
-- policies ne renvoient AUCUNE ligne (fail-closed) — c'est volontaire.
-- =============================================================================

-- --- Identité courante (depuis la variable de session) ------------------------

create or replace function app_current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- Helper de confort pour le backend (équivaut à SET LOCAL ...).
create or replace function set_current_user(p_user_id uuid) returns void
language sql as $$
  select set_config('app.current_user_id', p_user_id::text, true)
$$;

-- --- Périmètres accessibles à l'utilisateur courant ---------------------------

create or replace function app_cabinet_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select cabinet_id from cabinet_members where user_id = app_current_user_id()
$$;

create or replace function app_dossier_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  -- dossiers accessibles : via appartenance au cabinet OU accès direct
  select d.id from dossiers d
   where d.cabinet_id in (select cabinet_id from cabinet_members where user_id = app_current_user_id())
  union
  select dossier_id from dossier_access where user_id = app_current_user_id()
$$;

-- --- Activation RLS -----------------------------------------------------------

alter table cabinets        enable row level security;
alter table cabinet_members enable row level security;
alter table dossiers        enable row level security;
alter table dossier_access  enable row level security;
alter table accounts        enable row level security;
alter table fiscal_years    enable row level security;
alter table journals        enable row level security;
alter table counterparties  enable row level security;
alter table tax_codes       enable row level security;
alter table entries         enable row level security;
alter table entry_lines     enable row level security;

-- --- Cabinets -----------------------------------------------------------------

create policy cabinets_select on cabinets for select
  using (id in (select app_cabinet_ids()));

create policy cabinet_members_rw on cabinet_members for all
  using (cabinet_id in (select app_cabinet_ids()))
  with check (cabinet_id in (select app_cabinet_ids()));

-- --- Dossiers -----------------------------------------------------------------

create policy dossiers_select on dossiers for select
  using (id in (select app_dossier_ids()));

create policy dossiers_write on dossiers for all
  using (cabinet_id in (select app_cabinet_ids()))
  with check (cabinet_id in (select app_cabinet_ids()));

create policy dossier_access_rw on dossier_access for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

-- --- Données rattachées à un dossier : pattern unique -------------------------

create policy accounts_rw on accounts for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

create policy fiscal_years_rw on fiscal_years for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

create policy journals_rw on journals for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

create policy counterparties_rw on counterparties for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

create policy tax_codes_rw on tax_codes for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

create policy entries_rw on entries for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

create policy entry_lines_rw on entry_lines for all
  using (dossier_id in (select app_dossier_ids()))
  with check (dossier_id in (select app_dossier_ids()));

-- NB : l'immuabilité des écritures validées (migration 0004) s'applique EN PLUS
-- de la RLS. Les tables de référence (chart_templates...) restent en lecture
-- publique (gabarit système).
