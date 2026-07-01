-- =============================================================================
-- Nova Comptabilité — 0002 : Plan comptable SYSCOHADA, exercices, journaux, tiers
-- =============================================================================

-- --- Plan comptable de référence (SYSCOHADA révisé, partagé, versionné) -------
-- Table système : le plan officiel sert de gabarit. À l'ouverture d'un dossier,
-- on instancie ces comptes dans `accounts` (personnalisables ensuite).

create type account_type as enum ('asset','liability','equity','income','expense','offbalance','analytic');
create type account_nature as enum ('debit','credit');  -- sens normal du solde

create table chart_templates (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,                 -- ex: 'SYSCOHADA-2017'
  label       text not null,
  version     text not null,
  is_default  boolean not null default false,
  unique (code, version)
);

create table chart_template_accounts (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references chart_templates(id) on delete cascade,
  account_code  text not null,               -- ex: '601', '4011', '521'
  label         text not null,
  class_no      smallint not null check (class_no between 1 and 9),
  account_type  account_type not null,
  normal_side   account_nature not null,
  parent_code   text,                          -- hiérarchie par préfixe
  is_collective boolean not null default false, -- compte de tiers collectif (401, 411...)
  unique (template_id, account_code)
);

create index idx_template_accounts_tmpl on chart_template_accounts(template_id);

-- --- Plan comptable du dossier (instancié + personnalisable) -------------------

create table accounts (
  id            uuid primary key default gen_random_uuid(),
  dossier_id    uuid not null references dossiers(id) on delete cascade,
  account_code  text not null,
  label         text not null,
  class_no      smallint not null check (class_no between 1 and 9),
  account_type  account_type not null,
  normal_side   account_nature not null,
  parent_id     uuid references accounts(id) on delete set null,
  is_collective boolean not null default false,
  is_postable   boolean not null default true,   -- false = compte de regroupement
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (dossier_id, account_code)
);

create index idx_accounts_dossier on accounts(dossier_id);

-- --- Exercices comptables -----------------------------------------------------

create type fiscal_year_status as enum ('open','closing','closed');

create table fiscal_years (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  label       text not null,                 -- ex: 'Exercice 2026'
  start_date  date not null,
  end_date    date not null,
  status      fiscal_year_status not null default 'open',
  created_at  timestamptz not null default now(),
  unique (dossier_id, label),
  check (end_date > start_date)
);

-- --- Journaux (AC, VE, BQ, CA, OD...) -----------------------------------------

create type journal_type as enum ('achats','ventes','banque','caisse','operations_diverses','a_nouveaux');

create table journals (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  code        text not null,                 -- ex: 'AC','VE','BQ1','CA','OD'
  label       text not null,
  type        journal_type not null,
  -- compte de contrepartie par défaut (banque/caisse pour les journaux de trésorerie)
  default_account_id uuid references accounts(id) on delete set null,
  is_active   boolean not null default true,
  unique (dossier_id, code)
);

create index idx_journals_dossier on journals(dossier_id);

-- --- Tiers (clients / fournisseurs) -------------------------------------------
-- Brique clé pour le scoring : ancienneté, régularité, encours par contrepartie.

create type counterparty_type as enum ('client','fournisseur','salarie','etat','autre');

create table counterparties (
  id            uuid primary key default gen_random_uuid(),
  dossier_id    uuid not null references dossiers(id) on delete cascade,
  type          counterparty_type not null,
  name          text not null,
  tax_id        text,                          -- IFU/NCC/NINEA du tiers
  country       ohada_country,
  account_id    uuid references accounts(id) on delete set null, -- compte collectif rattaché
  created_at    timestamptz not null default now()
);

create index idx_counterparties_dossier on counterparties(dossier_id);

-- --- Codes de taxe (TVA, retenues...) — pilotés par données, par pays ---------

create type tax_kind as enum ('tva','retenue_source','autre');

create table tax_codes (
  id          uuid primary key default gen_random_uuid(),
  dossier_id  uuid not null references dossiers(id) on delete cascade,
  code        text not null,                 -- ex: 'TVA18'
  label       text not null,
  kind        tax_kind not null,
  rate        numeric(7,4) not null default 0, -- ex: 0.1800 pour 18%
  account_id  uuid references accounts(id) on delete set null, -- compte de TVA (443/445...)
  is_active   boolean not null default true,
  unique (dossier_id, code)
);
