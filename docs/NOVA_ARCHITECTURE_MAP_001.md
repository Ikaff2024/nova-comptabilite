# Nova Comptabilité — Carte d'architecture nº 001

> Annexe de [`NOVA_CTO_ARCHITECTURE_REVIEW_001.md`](./NOVA_CTO_ARCHITECTURE_REVIEW_001.md).
> HEAD `9c5045b10634f81362bb3ff541365a241dc24bd9` · 9 septembre 2026 · lecture seule.
> Les tables et fonctions listées ont été relevées sur une base réelle reconstruite depuis
> les 77 migrations, pas déduites du code.

---

## 1. Vue d'ensemble

```
┌──────────────────────────────────────────────────────────────────────────┐
│  NAVIGATEUR — React 19 / Vite / Tailwind 4                               │
│  src/App.tsx (routeur maison) → 62 composants                            │
│  src/lib/api.ts (1 156 l.) — point d'entrée réseau UNIQUE                │
│  src/lib/session.ts — jeton JWT en localStorage                          │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │  fetch  Authorization: Bearer <JWT>
┌────────────────────────────▼─────────────────────────────────────────────┐
│  server/index.ts — amorçage                                              │
│    1. env.ts (dotenv)                                                     │
│    2. assertAuthConfig()  ← refuse de démarrer si JWT_SECRET faible/prod  │
│    3. createApi() puis app.listen()                                       │
│    4. applyPendingMigrations()  ← APRÈS listen, best-effort  [P1-08]      │
│    5. startNightlyScheduler() + setInterval digest quotidien             │
├──────────────────────────────────────────────────────────────────────────┤
│  server/api.ts — 311 routes, 2 334 lignes, 78 imports de domaine         │
│    · express.json({limit:'15mb'}) + conservation du corps brut           │
│    · en-têtes sécurité (nosniff, DENY, Referrer, CORP, HSTS) — pas de CSP│
│    · limiteAuth — 10 essais / 15 min, en mémoire      [P2-04]            │
│    · middleware JWT → req.userId                                          │
│    · middleware /api/dossiers/:id → garde portail client                 │
│    · h() — enveloppe d'erreur : status ?? 400          [P2-05]           │
│    « Aucune SQL ici » — vérifié                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  server/db.ts — withUser(userId, fn)                                     │
│    begin → set_config('app.current_user_id', …, LOCAL) → fn → commit     │
│    SEUL endroit qui ouvre une transaction et pose le tenant              │
│    pg.types.setTypeParser(1700, Number)  ← NUMERIC → float  [P2-01]      │
├──────────────────────────────────────────────────────────────────────────┤
│  server/domain/*.ts — 73 modules · tout le SQL vit ici                   │
├──────────────────────────────────────────────────────────────────────────┤
│  PostgreSQL 16 — 59 tables · 1 vue · 49 SECURITY DEFINER · RLS 57/59     │
│    triggers d'intégrité : équilibre (différé), immuabilité, période      │
└──────────────────────────────────────────────────────────────────────────┘
        │                    │                     │
   Claude/Gemini      WhatsApp / Telegram    Cloudflare R2 · Resend
   ElevenLabs/OpenAI/xAI (TTS)               FNE (CI) · AuthNTIC
```

---

## 2. Domaines (bounded contexts)

### 2.1 identity / auth

| | |
|---|---|
| **Fichiers** | `server/auth.ts` · `server/domain/users.ts` |
| **Tables** | `app_users` (email, password_hash, totp_secret, totp_enabled, is_platform_admin) |
| **Migrations** | 0008 (auth_users) · 0022 (members_and_2fa) · 0031 (user_set_name) · 0051 (platform_admin) |
| **Routes** | `POST /api/auth/register` · `POST /api/auth/login` · `GET|PATCH /api/auth/me` · `POST /api/auth/2fa/{setup,enable,disable}` |
| **Dépend de** | — (racine) |
| **Externe** | aucune (scrypt + HMAC natifs Node, « own your core ») |
| **Tests** | ❌ **aucun** — [P3-05] |

`register_user`, `get_user_for_login`, `get_user`, `totp_*` sont des fonctions
`SECURITY DEFINER` : l'authentification s'exécute hors contexte RLS (`withUser(null, …)`),
ce qui est nécessaire puisqu'il n'y a pas encore d'identité.

### 2.2 tenancy

| | |
|---|---|
| **Fichiers** | `domain/invitations.ts` · `domain/portal.ts` · `domain/platform.ts` · `domain/cabinettriage.ts` |
| **Tables** | `cabinets` · `cabinet_members` · `dossiers` · `dossier_access` · `cabinet_invitations` · `member_dossier_access` |
| **Migrations** | 0001 · 0007 · 0022 · 0030 · 0034 (client_portal) · 0051 · 0057/0058 (account_type) · 0060 (invitations) · 0063 (member_dossier_access) · 0068 + **0077** (dossier_delete) |
| **Routes** | `/api/cabinets/:cid/**` (10) · `/api/invitations/:token` (2) · `/api/onboarding/cabinet` · `/api/platform/overview` · `/api/cabinet/triage` (2) |
| **Fonctions clés** | `app_cabinet_ids()` · `app_dossier_ids()` · `dossier_role_for()` · `onboard_cabinet()` · `cabinet_member_*()` · `dossier_delete()` · `app_is_platform_admin()` |
| **Tests** | `test:securite` (4) — non joué en CI [P1-06] |

C'est le socle de sécurité de toute la plateforme : les deux fonctions `app_*_ids()`
alimentent les 57 policies RLS.

### 2.3 accounting / ledger — **cœur du système**

| | |
|---|---|
| **Fichiers** | `domain/accounting.ts` (1 347 l.) · `domain/ledger.ts` · `domain/carryforward.ts` · `domain/cutoff.ts` · `domain/lettrage.ts` · `domain/entrytemplates.ts` · `domain/recurring.ts` · `domain/importbalance.ts` · `domain/importledger.ts` · `domain/fec.ts` |
| **Tables** | `entries` · `entry_lines` · `accounts` · `journals` · `fiscal_years` · `counterparties` · `tax_codes` · `lettrages` · `period_closures` · `recurring_entries` · `entry_templates` · `account_mappings` |
| **Migrations** | 0002 (structures) · **0003 (ledger)** · **0004 (intégrité)** · 0005 (RLS) · 0006 (seed SYSCOHADA, 113 Ko) · 0010 (lettrage) · 0035 (operation_date) · 0054 (period_closures) · 0070 (chart_labels) · 0075/0076 (extourne) |
| **Routes** | ~40 sous `/api/dossiers/:id/` (entries, accounts, journals, balance, ledger, fiscal-years, closures, lettrage, import…) + `POST /api/entries/:id/reverse` |
| **Triggers** | `trg_entry_balanced` (différé) · `trg_entry_post_check` · `trg_protect_entries` · `trg_protect_lines` · `trg_period_open` |
| **Dépend de** | tenancy (RLS) |
| **Tests** | `test:domain` (10) · `test:exercices` (49) · `test:bornes` (14) · `test:coherence` (9) |

**Point d'entrée unique en écriture** : `postEntry()` — le seul endroit du serveur qui
exécute `insert into entry_lines`. C'est cette unicité qui masque aujourd'hui les
invariants manquants (P0-03, P1-01, P1-02, P1-03).

### 2.4 reporting / états SYSCOHADA

| | |
|---|---|
| **Fichiers** | `domain/etats-officiels.ts` · `domain/etats-postes.ts` · `domain/reporting.ts` · `domain/ratios.ts` · `domain/pnl-mensuel.ts` · `domain/rentabilite.ts` · `documents/accounting-docs.ts` (471 l.) · `documents/pdf.ts` · `documents/csv.ts` |
| **Tables** | aucune propre — agrégats sur `entry_lines` + `accounts` |
| **Routes** | `/api/dossiers/:id/{statements,etats-officiels,ratios,pnl-mensuel,rentabilite,exports/**}` |
| **Tests** | `test:etats` · `test:postes` · `test:pnl` (23) |

Deux implémentations volontairement distinctes qui se recoupent (cf. revue § 9).
`comptesNonAffectes` expose les comptes hors poste plutôt que de les absorber.

### 2.5 notes annexes

`domain/notes-annexes.ts` · dérivé du grand livre (pas d'un écart de soldes) ·
`test:notes` (24) · route `/api/dossiers/:id/notes-annexes`.

### 2.6 revision / contrôles

| | |
|---|---|
| **Fichiers** | `domain/revision.ts` · `domain/controls.ts` · `domain/coherence.ts` · `domain/accountingquality.ts` · `domain/clotureworks.ts` · `domain/reclassement.ts` (702 l.) |
| **Tables** | `account_reviews` |
| **Migrations** | 0028 (account_reviews) |
| **Tests** | `test:controles` (11) · `test:coherence` (9) · `test:reclassement` (67) |

`controls.ts:44-55` détecte les écritures sur compte de tête — **détection sans
prévention** [P1-01]. `reclassement.ts` porte `redresser()`, qui appelle `reverseEntry` :
c'est le second chemin légitime écrivant autour d'écritures validées.

### 2.7 analytics

`domain/analytic.ts` · `domain/analytique-assistant.ts` · tables `analytic_axes`,
`analytic_sections`, `entry_line_analytics` · migrations 0023, 0032, 0072, **0074
(analytic_axes, 8,8 Ko)** · `test:axes` (34) · `test:assistant-analytique` (34).

Multi-axes : une ligne peut porter un axe principal (`entry_lines.analytic_axis`) **et**
des axes secondaires via `entry_line_analytics`. `redresser()` reporte explicitement les
axes secondaires — sinon l'analytique de l'exercice d'arrivée se viderait sans que le
total bouge.

### 2.8 assets (immobilisations)

`domain/assets.ts` (466 l.) · `domain/assetswip.ts` · tables `fixed_assets`,
`asset_depreciations` · migrations 0014, 0018, 0021, 0024, 0036, **0071 (en-cours)**, 0072 ·
`test:production-immo` (23).

`postDepreciationDue()` poste au grand livre (681 → 28x) — exposé à Lexa via
`comptabiliser_dotations_dues`, correctement gaté `assist_plus` + owner/associé.

### 2.9 banking · 2.10 mobile-money

`domain/bank.ts` + `bank/statement.ts` + `ai/statement.ts` (scan de relevé) ·
`domain/mobilemoney.ts` + `mobilemoney/parser.ts` · table `bank_pointings` ·
migration 0011 · **aucun test** ⚠️

Déduplication assurée par `uq_entry_lines_external` (index unique partiel sur
`dossier_id, external_ref`).

### 2.11 billing · 2.12 purchases

`domain/invoicing.ts` · `domain/recurringinvoices.ts` · `domain/catalog.ts` ·
`domain/relances.ts` · `domain/tiers.ts` (310 l.) · `domain/purchases.ts` (310 l.) ·
`fne/provider.ts` (facture normalisée CI) · tables `invoices`, `invoice_lines`,
`purchases`, `catalog_items`, `relances` · migrations 0013, 0019, 0020, 0033, 0049, 0053,
0066, 0067 · **aucun test** ⚠️

### 2.13 payroll / RH

| | |
|---|---|
| **Fichiers** | `payroll/core/` (engine, rules, overtime, absences, loans, stc, types, testkit) · `payroll/bridge.ts` · `payroll/official-exports.ts` · `payroll/payslip-pdf.ts` · `domain/payroll.ts` (813 l.) · `domain/payrollrh.ts` · `domain/payrollvariable.ts` · `domain/leave.ts` |
| **Tables** | `payroll_employees` · `payroll_runs` · `payroll_payslips` · `payroll_pointage` · `leave_requests` |
| **Migrations** | 0040 · 0046 (payroll_rh) · 0047 (pointage) · 0069 (déclaratif) · **0073 (paie variable)** |
| **Tests** | `test:payroll` **78/78** · `test:paie-variable` (25) |

Portage du moteur IvoirePaie (barème ITS officiel DGI, CI-2024.2). Le domaine le mieux
testé du projet.

### 2.14 tax / compliance

`domain/tax.ts` · `domain/fiscaladvisor.ts` · `domain/fiscalcalendar.ts` ·
`domain/obligations.ts` · `domain/aqm.ts` (290 l.) · `domain/audit.ts` ·
tables `tax_codes`, `obligations`, `audit_log`, `decision_ledger` ·
migrations 0026, 0044 (profil fiscal), **0056 (decision_ledger)** · **aucun test** ⚠️

`postVatLiquidation()` → `postEntry()` : second chemin d'écriture au grand livre exposé à
Lexa (`comptabiliser_tva`, gaté `assist_plus` + admin).
`audit_log` est append-only par révocation de privilège.

### 2.15 documents / storage

`domain/documents.ts` · `storage/provider.ts` (R2 SigV4 maison) ·
tables `documents`, `document_blobs` · migration 0017 ·
routes `POST|GET /api/dossiers/:id/documents[/:docId]` · **aucun test** ⚠️

Deux modes : `db` (octets en base) par défaut, `r2` si les 4 variables R2 sont posées.
Validation d'entrée : taille et non-vacuité **uniquement** [P1-04].

### 2.16 AI / Lexa

| | |
|---|---|
| **Fichiers** | `ai/agent.ts` (1 086 l.) · `ai/provider.ts` (361 l.) · `ai/guide.ts` · `ai/statement.ts` · `ai/transcribe.ts` · `ai/watchdog.ts` · `domain/nightly.ts` (330 l.) · `domain/behavior.ts` · `domain/budgetcopilot.ts` · `domain/simulate.ts` · `nightly-runner.ts` |
| **Tables** | `lexa_memory` · `lexa_messages` · `agent_insights` · `api_usage` · `decision_ledger` |
| **Migrations** | 0037/0038 (agent_mode) · 0041 (memory) · 0042 (messages) · 0045/0055 (voix) · 0050 (api_usage) · 0056 (decision_ledger) · 0064 (agent_insights) |
| **Externe** | Anthropic · Gemini · ElevenLabs · OpenAI · xAI |
| **Tests** | `test:capture` (15) · `test:veille` (19) |

71 outils : 56 lecture, 4 brouillon, 2 réversible, 9 action. Détail et gating dans la
revue § 12 et dans la carte de sécurité.

### 2.17 messaging

`whatsapp/provider.ts` + `whatsapp/handler.ts` · `telegram/provider.ts` +
`telegram/handler.ts` · `domain/whatsapp.ts` · `domain/telegram.ts` ·
`email/provider.ts` (Resend) · `tts/{provider,elevenlabs,openai,xai}.ts` ·
tables `whatsapp_links`, `telegram_links` · migrations 0039, 0043 · **aucun test** ⚠️

Les deux webhooks résolvent `{userId, dossierId}` depuis la table de liaison puis
appellent `withUser` — le périmètre RLS s'applique normalement.

### 2.18 financing / scoring

`domain/financing.ts` · `domain/financingdossier.ts` · `domain/scoring.ts` ·
`domain/forecast.ts` · `domain/budget.ts` · `domain/dossierdashboard.ts` ·
`domain/dossierprofile.ts` · `domain/activityreport.ts` · `domain/alerts.ts` ·
`integrations/authntic.ts` · tables `financing_requests`, `budgets` ·
migrations 0025, 0029, 0062 · **aucun test** ⚠️

---

## 3. Graphe de dépendances

```
                     ┌──────────────┐
                     │  server/db   │  withUser · pool · setTypeParser
                     └──────▲───────┘
                            │
   ┌────────────────────────┼────────────────────────┐
   │                        │                        │
┌──┴───────┐        ┌───────┴────────┐      ┌────────┴────────┐
│ tenancy  │◄───────│  accounting    │      │   auth/users    │
│ (RLS)    │        │  (postEntry,   │      └─────────────────┘
└──▲───────┘        │   reverseEntry)│
   │                └───────▲────────┘
   │                        │
   │      ┌─────────────────┼──────────────────┬──────────────┐
   │      │                 │                  │              │
┌──┴──────┴─┐  ┌────────────┴──┐  ┌────────────┴──┐  ┌────────┴────┐
│ reporting │  │ reclassement  │  │ tax · assets  │  │  billing    │
│ notes     │  │ (→reverseEntry│  │ (→postEntry)  │  │  purchases  │
│ revision  │  │  +postEntry)  │  └───────────────┘  │  payroll    │
└───────────┘  └───────────────┘                     └─────────────┘
        ▲              ▲                  ▲                 ▲
        └──────────────┴─────────┬────────┴─────────────────┘
                                 │  (lecture seule + 3 chemins d'écriture gatés)
                          ┌──────┴───────┐
                          │  ai/agent    │ 71 outils
                          └──────▲───────┘
                                 │
                    ┌────────────┴────────────┐
                    │  whatsapp · telegram    │
                    │  api.ts (/assistant)    │
                    └─────────────────────────┘
```

**Aucune dépendance circulaire.** Le graphe est acyclique : `api → domain → db`.

### Les trois chemins d'écriture au grand livre

| Chemin | Appelant | Gating |
|---|---|---|
| `postEntry()` | saisie, capture, import, factures, paie, TVA, dotations | contrôles applicatifs + triggers |
| `reverse_entry()` (SQL) | `POST /api/entries/:id/reverse`, `redresser()` | garde de périmètre dans la fonction (0007) |
| `postEntry()` via Lexa | `comptabiliser_tva`, `comptabiliser_dotations_dues` | `assist_plus` **+** owner/associé |
| `reverse_entry()` via Lexa | `reaffecter_exercice` | ⚠️ **`assist` seul** — [P1-05] |

---

## 4. Tables (59) et couverture RLS

**57 tables avec RLS · 0 avec FORCE** [P0-02] · 2 sans RLS, légitimement.

| Groupe | Tables | RLS |
|---|---|:--:|
| Référentiel système | `chart_templates`, `chart_template_accounts` | ❌ *(partagé, sans donnée client)* |
| Identité | `app_users` | ✅ |
| Tenancy | `cabinets`, `cabinet_members`, `dossiers`, `dossier_access`, `cabinet_invitations`, `member_dossier_access` | ✅ |
| Ledger | `entries`, `entry_lines`, `accounts`, `journals`, `fiscal_years`, `counterparties`, `tax_codes` | ✅ |
| Rapprochement | `lettrages`, `bank_pointings`, `account_mappings` | ✅ |
| Clôtures | `period_closures` | ✅ |
| Récurrences | `recurring_entries`, `entry_templates`, `recurring_invoices` | ✅ |
| Facturation | `invoices`, `invoice_lines`, `catalog_items`, `relances` | ✅ |
| Achats | `purchases`, `purchase_lines` | ✅ |
| Immobilisations | `fixed_assets`, `asset_depreciations`, `assets_in_progress` | ✅ |
| Analytique | `analytic_axes`, `analytic_sections`, `entry_line_analytics` | ✅ |
| Paie / RH | `payroll_employees`, `payroll_runs`, `payroll_payslips`, `payroll_pointage`, `leave_requests`, `payroll_variables` | ✅ |
| Fiscal | `obligations`, `budgets` | ✅ |
| Documents | `documents`, `document_blobs` | ✅ |
| IA / Lexa | `lexa_memory`, `lexa_messages`, `agent_insights`, `api_usage`, `decision_ledger` | ✅ |
| Messagerie | `whatsapp_links`, `telegram_links` | ✅ |
| Financement | `financing_requests` | ✅ |
| Révision | `account_reviews` | ✅ |
| Audit | `audit_log` *(append-only : UPDATE/DELETE révoqués)* | ✅ |
| Migrations | `_migrations` | ✅ |

**Vues : 1** — `v_account_balances`, propriétaire `postgres`, **sans `security_invoker`**
→ contourne la RLS [**P0-01**]. Utilisée nulle part dans l'application, seulement dans
`smoke_test.sql:108`.

---

## 5. Routes — répartition

**311 routes** dans `server/api.ts`.

| Préfixe | Nombre |
|---|---:|
| `/api/dossiers/:id/**` | 273 |
| `/api/cabinets/:cid/**` | 10 |
| `/api/auth/**` | 6 |
| `/api/invitations/:token*` | 2 |
| `/api/whatsapp/webhook` | 2 |
| `/api/cabinet/triage` | 2 |
| `/api/dossiers` | 2 |
| `/api/entries/:id/reverse` · `/api/telegram/webhook` · `/api/cron/watchdog` · `/api/health` · `/api/onboarding/cabinet` · `/api/cabinets` · `/api/dashboard` · `/api/usage` · `/api/platform/overview` · `/api/demo/seed` · `/api/email/{status,test}` · `GET *` | 1 chacune |

| Méthode | Nombre |
|---|---:|
| GET | 145 |
| POST | 116 |
| DELETE | 32 |
| PATCH | 13 |
| PUT | 5 |

Inventaire route par route avec frontières d'autorisation :
[`NOVA_SECURITY_BOUNDARY_MAP_001.md`](./NOVA_SECURITY_BOUNDARY_MAP_001.md).

---

## 6. Intégrations externes

| Service | Module | Activation | Repli |
|---|---|---|---|
| Anthropic Claude | `ai/provider.ts` | `ANTHROPIC_API_KEY` | Gemini, puis mode démo |
| Google Gemini | `ai/provider.ts` | `GEMINI_API_KEY` | mode démo |
| ElevenLabs (TTS) | `tts/elevenlabs.ts` | `ELEVENLABS_API_KEY` | autre fournisseur TTS |
| OpenAI (TTS + Whisper) | `tts/openai.ts`, `ai/transcribe.ts` | `OPENAI_API_KEY` | — |
| xAI Grok (TTS) | `tts/xai.ts` | `XAI_API_KEY` | — |
| WhatsApp Cloud API | `whatsapp/provider.ts` | jeton Meta + secret | no-op |
| Telegram Bot API | `telegram/provider.ts` | jeton bot | no-op |
| Cloudflare R2 | `storage/provider.ts` | 4 variables R2 | stockage en base |
| Resend (email) | `email/provider.ts` | `RESEND_API_KEY` | désactivé |
| FNE (Côte d'Ivoire) | `fne/provider.ts` | configuration FNE | non certifié |
| AuthNTIC (liasse DSF) | `integrations/authntic.ts` | URL + clé | non branché |

Toutes les intégrations sont **dégradables** : absence de clé = fonctionnalité désactivée,
jamais un crash. Aucun SDK tiers — signature SigV4, HMAC et JWT sont écrits à la main
(choix « own your core » assumé et documenté).

---

## 7. Ce que la carte révèle

1. **Le point de convergence est `postEntry()`.** Un seul chemin d'écriture au grand livre
   côté domaine. C'est une force (un seul endroit à auditer) et la fragilité identifiée
   en P0-03 : les invariants absents du schéma ne sont pas visibles tant que ce chemin
   reste unique.

2. **`api.ts` est le seul nœud fortement couplé** (78 imports). Le reste du graphe est
   proprement hiérarchique.

3. **La surface IA est large mais correctement canalisée.** 71 outils, mais tous passent
   par `executeTool()`, qui revérifie mode et rôle avant le dispatch.

4. **Sept domaines n'ont aucun test** : banking, mobile-money, billing, purchases, tax,
   documents, messaging, financing. Ce sont aussi ceux qui touchent le plus aux flux
   externes.

5. **Trois modules dépassent 700 lignes** : `api.ts` (2 334), `accounting.ts` (1 347),
   `agent.ts` (1 086). Ce sont les trois fichiers à découper en priorité (WAVE 5).
