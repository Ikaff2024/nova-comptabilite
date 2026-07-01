-- =============================================================================
-- Nova Comptabilité — 0003 : Ledger double-entrée (immuable, attributs scoring)
-- =============================================================================
-- Principe : une écriture POSTED est immuable. On ne modifie jamais -> on
-- contre-passe (reversal). Les attributs de scoring/finance sont portés DÈS
-- L'ORIGINE par chaque ligne (impossible à reconstruire après coup).
-- =============================================================================

create type entry_status as enum ('draft','posted','reversed');

-- Origine de l'écriture (mesure le % d'automatisation = KPI-reine)
create type entry_source as enum (
  'manual','ocr','bank_import','mobile_money','recurring','api','opening_balance'
);

-- Canal de paiement (clé pour réconciliation Mobile Money + scoring)
create type payment_channel as enum (
  'cash','bank','cheque',
  'om','momo','wave','moov','other_mobile_money',
  'card','none'
);

-- Niveau de certification fiscale de la pièce (e-invoicing)
create type certification_status as enum ('none','normalized','fne_certified');

-- --- En-tête d'écriture (pièce comptable) ------------------------------------

create table entries (
  id              uuid primary key default gen_random_uuid(),
  dossier_id      uuid not null references dossiers(id) on delete restrict,
  fiscal_year_id  uuid not null references fiscal_years(id) on delete restrict,
  journal_id      uuid not null references journals(id) on delete restrict,

  entry_date      date not null,                 -- date comptable
  piece_ref       text,                          -- n° de pièce / référence interne
  description     text not null,

  status          entry_status not null default 'draft',
  source          entry_source not null default 'manual',

  -- Traçabilité de la contre-passation
  reverses_entry_id    uuid references entries(id) on delete restrict, -- cette écriture annule...
  reversed_by_entry_id uuid references entries(id) on delete restrict, -- ...a été annulée par

  -- Lien vers la pièce justificative (Storage) + confiance IA
  document_url    text,
  ai_confidence   numeric(5,4),                  -- 0..1, null si saisie humaine

  created_by      uuid,                          -- auth.users(id)
  posted_at       timestamptz,
  created_at      timestamptz not null default now()
);

create index idx_entries_dossier_year on entries(dossier_id, fiscal_year_id);
create index idx_entries_journal on entries(journal_id);
create index idx_entries_status on entries(dossier_id, status);

-- --- Lignes d'écriture --------------------------------------------------------
-- Convention : amount_debit XOR amount_credit > 0 (l'autre = 0). Montants en
-- devise de tenue (base_currency du dossier). Le multi-devises est porté par
-- les colonnes orig_* + fx_rate.

create table entry_lines (
  id              uuid primary key default gen_random_uuid(),
  entry_id        uuid not null references entries(id) on delete cascade,
  dossier_id      uuid not null references dossiers(id) on delete restrict, -- dénormalisé pour RLS/perf
  account_id      uuid not null references accounts(id) on delete restrict,
  line_no         smallint not null default 1,

  amount_debit    numeric(20,4) not null default 0 check (amount_debit  >= 0),
  amount_credit   numeric(20,4) not null default 0 check (amount_credit >= 0),

  -- Multi-devises (si la pièce est en devise étrangère)
  orig_currency   currency_code,
  orig_amount     numeric(20,4),
  fx_rate         numeric(20,8),

  label           text,

  -- ---- Attributs de réconciliation & scoring (Phase finance) ----------------
  counterparty_id uuid references counterparties(id) on delete set null,
  tax_code_id     uuid references tax_codes(id) on delete set null,
  payment_channel payment_channel not null default 'none',
  certification   certification_status not null default 'none',
  fne_reference   text,                          -- réf. facture normalisée certifiée
  normalized_cat  text,                          -- catégorie normalisée (taxonomie scoring)

  -- ---- Axe analytique (classe 9 / comptabilité de gestion) ------------------
  analytic_axis   text,

  external_ref    text,                          -- id de la transaction source (relevé, MoMo...)
  created_at      timestamptz not null default now(),

  -- une ligne est soit au débit, soit au crédit, jamais les deux ni aucun
  check ( (amount_debit > 0)::int + (amount_credit > 0)::int = 1 )
);

create index idx_entry_lines_entry on entry_lines(entry_id);
create index idx_entry_lines_account on entry_lines(account_id);
create index idx_entry_lines_counterparty on entry_lines(counterparty_id);
create index idx_entry_lines_channel on entry_lines(dossier_id, payment_channel);
-- déduplication des imports (un même mouvement bancaire/MoMo ne s'importe qu'une fois)
create unique index uq_entry_lines_external
  on entry_lines(dossier_id, external_ref) where external_ref is not null;
