-- =============================================================================
-- Nova Comptabilité — 0001 : Enums de base & tenancy (Cabinet -> Dossiers -> Users)
-- =============================================================================
-- Modèle de tenancy : un CABINET d'expertise gère plusieurs DOSSIERS (entités
-- clientes). Une PME directe = un cabinet à dossier unique. L'isolation se fait
-- par cabinet_id / dossier_id + RLS (voir migration 0005).
-- =============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- --- Enums --------------------------------------------------------------------

create type cabinet_role as enum ('owner', 'associe', 'collaborateur');
create type dossier_role as enum ('gestionnaire', 'collaborateur', 'client', 'lecture');

-- Régime comptable SYSCOHADA
create type accounting_system as enum ('normal', 'smt');  -- smt = Système Minimal de Trésorerie

-- Pays OHADA (codes ISO-3166 alpha-2 des États membres)
create type ohada_country as enum (
  'BJ','BF','CM','CF','KM','CG','CI','GA','GN','GW','GQ','ML','NE','CD','SN','TD','TG'
);

-- Devises de la zone
create type currency_code as enum ('XOF','XAF','GNF','CDF','KMF','EUR','USD');

-- --- Cabinets -----------------------------------------------------------------

create table cabinets (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  country         ohada_country not null,
  base_currency   currency_code not null default 'XOF',
  created_at      timestamptz not null default now()
);

-- Membres du cabinet (rattachés à un compte auth Supabase)
create table cabinet_members (
  id          uuid primary key default gen_random_uuid(),
  cabinet_id  uuid not null references cabinets(id) on delete cascade,
  user_id     uuid not null,            -- references auth.users(id)
  role        cabinet_role not null default 'collaborateur',
  created_at  timestamptz not null default now(),
  unique (cabinet_id, user_id)
);

create index idx_cabinet_members_user on cabinet_members(user_id);

-- --- Dossiers (entités clientes / sociétés tenues) ---------------------------

create table dossiers (
  id                  uuid primary key default gen_random_uuid(),
  cabinet_id          uuid not null references cabinets(id) on delete restrict,
  raison_sociale      text not null,
  country             ohada_country not null,
  base_currency       currency_code not null default 'XOF',
  accounting_system   accounting_system not null default 'normal',
  -- Identifiants fiscaux/légaux (selon pays : IFU, NCC, RCCM, NINEA, NIU...)
  tax_id              text,             -- identifiant fiscal principal
  rccm                text,             -- registre du commerce
  fiscal_extra        jsonb not null default '{}'::jsonb,  -- identifiants additionnels par pays
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);

create index idx_dossiers_cabinet on dossiers(cabinet_id);

-- Accès par dossier (un collaborateur n'a pas forcément accès à tous les dossiers ;
-- le client final accède en lecture/saisie à SON dossier uniquement)
create table dossier_access (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  user_id     uuid not null,            -- references auth.users(id)
  role        dossier_role not null default 'collaborateur',
  created_at  timestamptz not null default now(),
  unique (dossier_id, user_id)
);

create index idx_dossier_access_user on dossier_access(user_id);
