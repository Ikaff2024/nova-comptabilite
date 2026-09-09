# Nova Comptabilité — Revue d'architecture CTO nº 001

> Revue **en lecture seule**. Aucun fichier applicatif modifié, aucune migration créée,
> aucun commit, aucune configuration touchée. Les preuves ont été produites sur une base
> Postgres 16 jetable et isolée (conteneur `nova-cto-audit`, port 55999), reconstruite
> depuis les 77 migrations du dépôt.

| | |
|---|---|
| **Dépôt** | `Ikaff2024/nova-comptabilite` |
| **Branche** | `main` |
| **HEAD au démarrage** | `a786be7641ef8b891c9daf61c8a79f782a92ea93` (arbre **sale** : 4 fichiers modifiés, 2 non suivis) |
| **HEAD à la clôture** | `9c5045b10634f81362bb3ff541365a241dc24bd9` — le correctif de sécurité a été commité **pendant** la revue |
| **Portée de l'analyse** | Le contenu analysé est celui de `9c5045b` : la revue a lu les fichiers de l'arbre de travail, qui sont exactement ceux que ce commit a figés. Les trois P0 ont été **re-vérifiés après le commit** et se reproduisent à l'identique. |
| **Date de revue** | 8–9 septembre 2026 |
| **Runtime** | Node 24.14.0 local · Node 20 en CI · Node 22-slim en image Docker (**trois versions différentes**) |
| **Gestionnaire** | npm 11.9.0, `package-lock.json` présent |
| **Volumétrie** | 136 fichiers TS serveur (~23 900 lignes) · 69 fichiers front (~15 400 lignes) · 77 migrations SQL · 59 tables · 311 routes HTTP |

---

## 1. Executive Summary

Nova Comptabilité est un produit **nettement plus solide que la moyenne des plateformes
comptables à ce stade de maturité**. Le cœur du ledger est correct, l'isolation
multi-tenant est réelle et vérifiée, l'architecture IA est celle d'une équipe qui a
compris le problème, et 439 contrôles automatisés passent au vert. Ce n'est pas un
prototype déguisé.

Mais la revue a trouvé un écart structurel entre **ce que le système promet** et **ce
qu'il garantit réellement**, et cet écart se situe précisément là où il coûte le plus
cher : dans la couche censée être inviolable.

L'en-tête de la migration `20260629000004_integrity.sql` énonce le contrat fondateur :

> « Ces règles vivent EN BASE (pas dans l'applicatif). C'est ce qui garantit que l'IA,
> l'API ou un bug ne peuvent jamais produire une compta déséquilibrée ou altérer le passé. »

**Ce contrat est tenu pour l'équilibre débit/crédit. Il ne l'est pas pour l'immuabilité,
ni pour les bornes d'exercice, ni pour les comptes non imputables, ni pour la cohérence
compte/dossier.** Quatre invariants sur cinq vivent en réalité dans du TypeScript. Le
code applicatif actuel les respecte — c'est pourquoi les 439 tests passent — mais la
garantie annoncée n'existe pas au niveau où elle est annoncée.

Trois défauts P0 confirmés, avec reproduction :

1. **Fuite inter-tenant réelle** via la vue `v_account_balances` : un utilisateur du
   cabinet B lit les soldes du cabinet A. Prouvé, montant à l'appui.
2. **Effondrement silencieux de toute l'isolation** si `DATABASE_URL` pointe sur un rôle
   propriétaire — configuration par défaut chez la plupart des Postgres managés. Aucune
   table n'utilise `FORCE ROW LEVEL SECURITY`, aucune garde au démarrage ne le détecte.
3. **Les écritures validées ne sont pas immuables** : on peut leur ajouter des lignes
   après validation. Une écriture passée de 777 777 à 1 277 777 sans erreur, sans
   changement de statut, sans trace.

S'y ajoute un constat sur la chaîne de qualité : **la CI exécute 1 suite de tests sur 18**.
Un merge vert garantit aujourd'hui le typecheck, l'application des migrations et
10 contrôles de domaine. Les 429 autres contrôles — dont l'intégralité de la paie,
des états financiers, des notes annexes et **de la suite de sécurité** — ne tournent
jamais automatiquement.

**Verdict : Nova n'est pas `NOVA_PILOT_READY` aujourd'hui.** Il en est proche. Les trois
P0 sont tous réparables en quelques jours, sans refonte, sans toucher au modèle de
données, et pour deux d'entre eux en une seule migration. Le chemin est court et le
socle est bon.

---

## 2. Verdict CTO

### Ce qui mérite d'être dit d'abord

Beaucoup de plateformes comptables à ce stade n'ont pas de ledger double-entrée réel,
pas de RLS, pas de tests, et une IA qui écrit directement en base. Nova a les quatre à
l'endroit. Les points suivants ont été **vérifiés par exécution**, pas lus dans un README :

- L'équilibre débit/crédit résiste à la création, à la mise à jour, à la validation,
  et à **25 transactions concurrentes** (25/25 réussies, zéro écriture déséquilibrée en base).
- Cinq tentatives d'attaque inter-tenant menées avec le rôle applicatif réel — lecture
  d'écritures, ajout de membre, renommage de cabinet, contre-passation, auto-attribution
  d'accès — ont **toutes** été bloquées, chacune par une garde distincte.
- Lexa **ne peut pas** appeler `postEntry`. La séparation « l'IA propose, le ledger
  valide » est réelle dans le code, pas seulement dans le prompt.
- 439 contrôles automatisés passent, dont 78 sur le moteur de paie ivoirien et 67 sur
  les reclassements.
- Le correctif de la faille `dossier_delete` (logique ternaire SQL, migration 0077)
  est une analyse de qualité professionnelle, accompagnée d'un test de non-régression.

### Ce qui bloque le pilote

Le problème n'est pas la qualité du code. C'est que **la ligne de défense annoncée n'est
pas celle qui tient**. Aujourd'hui, l'intégrité comptable de Nova repose sur la discipline
de `server/domain/accounting.ts`. Tant qu'un seul chemin écrit dans `entry_lines`, tout va
bien. Le jour où un import, un outil Lexa, un job de reprise ou un correctif chaud en
ajoute un second, quatre invariants tombent sans que rien ne le signale — et aucun test
actuel ne le détecterait, puisqu'ils passent tous par le même chemin sûr.

C'est exactement le scénario qu'un pilote en cabinet fait advenir : de la donnée réelle,
des imports en masse, des corrections dans l'urgence.

### Décision

| | |
|---|---|
| **`NOVA_PILOT_READY`** | **NON** |
| **Distance au statut** | 3 P0 + 4 P1 bloquants — estimation 8 à 12 jours-homme |
| **Refonte nécessaire ?** | **Non.** Aucun P0 n'exige de changer le modèle de données ni l'architecture. |
| **Recommandation** | Traiter WAVE 1 et WAVE 2, re-jouer cette revue, puis ouvrir le pilote sur 2 à 3 cabinets pilotes avec sauvegarde quotidienne vérifiée. |

Un pilote lancé aujourd'hui ne provoquerait pas nécessairement d'incident — les chemins
applicatifs actuels sont corrects. Mais il serait lancé **sans filet**, et sur un produit
comptable c'est le filet qu'on achète.

---

## 3. Architecture Map

Détail complet : [`NOVA_ARCHITECTURE_MAP_001.md`](./NOVA_ARCHITECTURE_MAP_001.md).

### Forme générale

Nova est un **monolithe modulaire**, et c'est le bon choix pour ce produit. La séparation
en couches est nette et respectée :

```
src/ (React 19)                  69 fichiers — aucune logique comptable
      │  fetch /api
      ▼
server/api.ts                    311 routes, 2 334 lignes — « Aucune SQL ici »
      │  withUser(userId, fn)  ← ouvre la transaction + pose app.current_user_id
      ▼
server/domain/*.ts               73 modules métier — tout le SQL vit ici
      ▼
PostgreSQL                       59 tables · RLS · triggers d'intégrité · 49 SECURITY DEFINER
```

La règle « l'API ne contient pas de SQL » est **tenue** : vérifiée par recherche, aucune
requête SQL dans `api.ts`. La règle « toute opération passe par `withUser` » est tenue
également : `server/db.ts:22` est le seul endroit qui ouvre une transaction et pose
l'identité.

### Bounded contexts identifiés (18)

| Domaine | Modules principaux | Tables clés | Tests |
|---|---|---|---|
| identity/auth | `auth.ts`, `domain/users.ts` | `app_users` | ⚠️ aucun |
| tenancy | `domain/invitations.ts`, `domain/portal.ts` | `cabinets`, `cabinet_members`, `dossier_access` | `test:securite` (4) |
| accounting/ledger | `domain/accounting.ts` (1 347 l.) | `entries`, `entry_lines`, `accounts` | `test:domain`, `test:exercices` (59) |
| reporting | `etats-officiels.ts`, `etats-postes.ts` | vues + agrégats | `test:etats`, `test:postes` |
| notes annexes | `notes-annexes.ts` | dérivé du grand livre | `test:notes` (24) |
| revision | `revision.ts`, `controls.ts`, `coherence.ts` | `account_reviews` | `test:controles`, `test:coherence` (20) |
| analytics | `analytic.ts`, `analytique-assistant.ts` | `analytic_axes`, `analytic_sections` | `test:axes` (34) |
| assets | `assets.ts`, `assetswip.ts` | `fixed_assets` | `test:production-immo` (23) |
| banking | `bank.ts`, `bank/statement.ts` | `bank_pointings` | ⚠️ aucun |
| mobile-money | `mobilemoney.ts`, `mobilemoney/parser.ts` | via `entry_lines.payment_channel` | ⚠️ aucun |
| billing | `invoicing.ts`, `recurringinvoices.ts` | `invoices` | ⚠️ aucun |
| purchases | `purchases.ts` | `purchases` | ⚠️ aucun |
| payroll | `payroll/core/*` (portage IvoirePaie) | `payroll_*` | `test:payroll` (78) |
| tax | `tax.ts`, `fiscaladvisor.ts` | `tax_codes` | ⚠️ aucun |
| compliance/AQM | `aqm.ts`, `ledger.ts` | `decision_ledger` | ⚠️ aucun |
| documents | `documents.ts`, `storage/provider.ts` | `documents`, `document_blobs` | ⚠️ aucun |
| AI/Lexa | `ai/agent.ts` (1 086 l.), `ai/provider.ts` | `lexa_memory`, `lexa_messages` | `test:capture` (15) |
| messaging | `whatsapp/*`, `telegram/*` | `whatsapp_links`, `telegram_links` | ⚠️ aucun |

### Couplage

- **`server/api.ts` importe 78 modules de domaine.** C'est le point de couplage maximal
  et le fichier le plus gros du projet. Il reste lisible parce que chaque route fait
  3 à 6 lignes, mais 311 routes dans un fichier est au-delà du seuil de confort.
- **Pas de dépendance circulaire** entre domaines détectée. Le graphe est un arbre :
  `api → domain → db`. `reclassement.ts` appelle `accounting.ts` (postEntry, reverseEntry),
  `agent.ts` appelle 30 modules de domaine en lecture — mais rien ne remonte vers `api.ts`.
- **Duplication de calcul** : les états financiers ont deux implémentations
  (`accounting.financialStatements` regroupement par nature, `etats-officiels.etatsOfficiels`
  format officiel SYSCOHADA avec SIG). C'est **volontaire et sain** : elles se recoupent
  mutuellement (`test:etats` vérifie l'équilibre du bilan ET le recoupement du résultat
  avec la balance). C'est le contraire d'un contrôle auto-référentiel.

### Verdict architecture

**Monolithe modulaire maîtrisé.** Pas de microservices à recommander — ils ajouteraient
de la latence et des transactions distribuées à un problème qui n'en a pas besoin. La
seule action utile est de **découper `api.ts` en routeurs par domaine** (WAVE 5), sans
changement fonctionnel.

---

## 4. Strengths

Ces points sont établis par exécution, pas par lecture.

1. **Équilibre du ledger : incontournable.** Trigger `deferrable initially deferred` en
   fin de transaction. Testé sur création, ajout de ligne après coup, validation, et
   25 transactions concurrentes. `A1_deseq_persistee = 0`.

2. **Suppression et modification d'une écriture validée : bloquées.**
   `protect_posted_entries` et `protect_posted_lines` rejettent DELETE et UPDATE.
   (Voir NOVA-P0-03 pour ce qu'elles ne couvrent pas.)

3. **Isolation multi-tenant réelle sur les tables.** 57 tables sur 59 ont la RLS active ;
   les 2 exceptions (`chart_templates`, `chart_template_accounts`) sont du référentiel
   système partagé, sans donnée client. Le motif `dossier_id in (select app_dossier_ids())`
   est appliqué uniformément.

4. **Fail-closed sans contexte utilisateur.** Sans `app.current_user_id`, les tables
   renvoient zéro ligne. Vérifié : `nocontext_entries = 0`.

5. **RBAC applicatif solide.** Les fonctions `SECURITY DEFINER` portent le contrôle de
   rôle (`v_caller is null or v_caller not in ('owner','associe')`), avec `set search_path`
   explicite sur 47 fonctions sur 49. Cinq attaques inter-tenant bloquées.

6. **`reverse_entry` durcie.** La migration 0007 ajoute à la fonction un contrôle de
   périmètre explicite, parce que `SECURITY DEFINER` contourne la RLS. Le commentaire
   l'écrit noir sur blanc. C'est le réflexe d'une équipe qui comprend Postgres.

7. **Lexa ne peut pas écrire au grand livre depuis le socle lecture/assist.**
   `postEntry` n'est appelé nulle part dans `agent.ts`. Le gating est **doublé** : les
   outils ne sont pas exposés au modèle (`agent.ts:1017`) **et** le dispatcher revérifie
   (`agent.ts:553-563`) — défense en profondeur explicitement commentée pour couvrir
   WhatsApp et Telegram.

8. **Les actions irréversibles exigent le rôle humain, pas seulement le mode.**
   `agent.ts:565` : même en `assist_plus`, un collaborateur ne déclenche pas un envoi
   d'email ni une paie. Le mode est une propriété du dossier, le rôle une propriété de
   la personne — les deux sont exigés.

9. **Périmètre IA non contrôlé par le modèle.** `dossierId` vient toujours de la route ou
   de la table de liaison (`resolvePhone`, `resolveChat`), jamais d'un paramètre d'outil.
   Le LLM ne peut pas se déplacer d'un dossier à l'autre.

10. **AQM déterministe.** `valider_ecriture`, `valider_facture`, `valider_declaration`
    sont des validateurs en TypeScript, pas des jugements du modèle. Le `decision_ledger`
    journalise question, outils, validations et confiance.

11. **Actions Lexa auditées.** `agent.ts:1067` enregistre chaque outil mutant dans
    `audit_log` avec l'instruction, les entrées et le résultat.

12. **`audit_log` réellement append-only.** `revoke update, delete on audit_log from nova_app`
    — pas une convention, une permission retirée.

13. **Veille nocturne qui ne contourne pas la RLS.** `nightly_targets()` en SECURITY DEFINER
    pour lister les cibles, puis `withUser(t.user_id, …)` pour chaque dossier. Le commentaire
    explique le raisonnement.

14. **Le moteur de paie est couvert.** 78/78 tests, dont des tests « golden » sur le barème
    ITS officiel DGI.

15. **Qualité des correctifs.** La migration 0077 documente la logique ternaire SQL
    (`NULL in (...) → NULL → not NULL → pas d'exception`) qui rendait `dossier_delete`
    exploitable par un étranger, et vérifie que les fonctions sœurs utilisent déjà le
    motif sûr. Analyse de cause racine, pas rustine.

16. **Aucun secret commité.** `.env.local` non suivi, `.env.example` sans valeur réelle,
    aucun `.pem`/`.key` dans l'historique.

---

## 5. P0 findings — CRITICAL

### NOVA-P0-01 — Fuite inter-tenant par la vue `v_account_balances`

| | |
|---|---|
| **Severity** | P0 |
| **Status** | **CONFIRMED** — reproduit, montant à l'appui |
| **Domain** | Multi-tenancy / reporting |

**Evidence**

`supabase/migrations/20260629000004_integrity.sql:183` crée la vue sans l'option
`security_invoker = true`. En PostgreSQL, une vue s'exécute **avec les droits de son
propriétaire**, pas de l'appelant. Propriétaire constaté : `postgres`. Comme aucune table
n'a `FORCE ROW LEVEL SECURITY`, la RLS ne s'applique pas au propriétaire : la vue lit tout.

`nova_app` dispose de `SELECT` sur cette vue (héritée du `grant select … on all tables`
de la migration 0007).

**Reproduction** (rôle `nova_app`, contexte = Bob, cabinet B) :

```
-- Tables de base : correctement isolées
entries_visibles     | 0
lignes_visibles      | 0

-- La même donnée, via la vue :
vue_lignes_visibles  | 2
vue_montant_fuite    | 777777.0000
vue_dossiers_fuite   | aaaaaaaa-0000-0000-0000-00000000000a   ← dossier du cabinet A
```

Pire, **sans aucun contexte utilisateur** (GUC absente), la garantie fail-closed tombe :

```
nocontext_entries    | 0     ← correct
nocontext_vue        | 2     ← la vue répond quand même
```

**Re-vérification après le commit `9c5045b`**, sur la même base après exécution des 18
suites de tests (donc avec un volume réaliste multi-tenant) — la fuite grandit avec les
données :

```
tables_base    | 0                  ← Bob ne voit rien, correctement
via_la_VUE     | 102                ← 102 lignes de soldes, tous cabinets confondus
montant_fuite  | 148958793.0000     ← ~149 millions XOF appartenant à d'autres tenants
```

**Impact**

Rupture d'étanchéité inter-cabinet sur les soldes comptables. Aucune route HTTP
n'interroge cette vue aujourd'hui (recherche exhaustive : seul `supabase/tests/smoke_test.sql:108`
l'utilise) — l'exploitation nécessite donc une injection SQL, un accès base direct, ou
l'ajout d'une seule route. C'est un piège armé : la vue est disponible, documentée par son
nom, et le premier développeur qui l'utilisera pour un tableau de bord de performance
livrera une fuite générale sans s'en apercevoir.

**Recommendation**

Recréer la vue avec `WITH (security_invoker = true)` (PostgreSQL 15+, la CI et l'image
utilisent Postgres 16). Vérifier la version minimale supportée ; sinon, supprimer la vue
et calculer les soldes dans `domain/accounting.ts`, qui le fait déjà.

**Suggested tests**

Test SQL : avec le contexte du cabinet B, `select count(*) from v_account_balances`
doit renvoyer `0` — avec `RAISE EXCEPTION` si ce n'est pas le cas. Ce contrôle rejoint
NOVA-P1-07 (le test RLS actuel n'assertionne rien).

**Dependencies** — Aucune. Corrigeable seul, en une migration.

---

### NOVA-P0-02 — Aucun `FORCE ROW LEVEL SECURITY`, aucune garde sur le rôle de connexion

| | |
|---|---|
| **Severity** | P0 |
| **Status** | **CONFIRMED** — reproduit |
| **Domain** | Multi-tenancy / déploiement |

**Evidence**

```
TOTAL_TABLES | 59
RLS_ENABLED  | 57
RLS_FORCED   |  0     ← aucune table
```

Sans `FORCE`, la RLS **ne s'applique pas au propriétaire des tables**. La sécurité de
tout Nova repose donc sur une seule hypothèse non vérifiée à l'exécution : que
`DATABASE_URL` désigne un rôle non-propriétaire.

Aucune garde ne vérifie cette hypothèse. Recherche exhaustive dans `server/` :
aucune occurrence de `rolbypassrls`, `rolsuper`, `session_user` ou `pg_roles`.
`assertAuthConfig()` (`server/index.ts:10`) protège le secret JWT — rien ne protège le
rôle base.

**Reproduction** — même code applicatif, même contexte utilisateur, connexion en rôle
propriétaire :

```
-- Bob (cabinet B), connecté via un rôle propriétaire :
entries_visibles_par_Bob   | 1
dossiers_visibles_par_Bob  | 2
description_fuitee         | SECRET-A-CONFIDENTIEL
```

Toute l'isolation disparaît. Silencieusement : aucune erreur, aucun log, aucun symptôme.
L'application se comporte normalement — elle montre simplement tout à tout le monde.

**Impact**

C'est le défaut le plus dangereux du lot, non par sa complexité mais par sa probabilité.
Les Postgres managés (Railway, Neon, Supabase, RDS) fournissent par défaut une chaîne de
connexion **en rôle propriétaire ou superutilisateur**. Le dépôt lui-même documente le bon
usage (`docs/DEV-LOCAL.md`, `.env.example` : `nova_app`), et l'existence de
`MIGRATION_DATABASE_URL` montre que la distinction est comprise. Mais rien n'empêche une
variable d'environnement posée à la main un vendredi soir de désactiver l'étanchéité de
toute la plateforme.

Sur un produit multi-cabinets, c'est un incident de confidentialité de niveau réglementaire.

**Recommendation**

Deux mesures, complémentaires :

1. **Ceinture** — migration : `ALTER TABLE … FORCE ROW LEVEL SECURITY` sur les 57 tables
   à RLS. Attention : cela s'applique aussi au propriétaire, donc les migrations et jobs
   passant par `MIGRATION_DATABASE_URL` devront utiliser un rôle `BYPASSRLS` explicite.
   À valider sur la base de test avant.
2. **Bretelles** — garde au démarrage, dans `server/index.ts`, sur le modèle exact
   d'`assertAuthConfig()` : interroger `pg_roles` pour le rôle courant et **refuser de
   démarrer en production** si `rolsuper` ou `rolbypassrls` est vrai, ou si le rôle est
   propriétaire de `entries`. Message explicite. En développement, avertissement seulement.

La mesure 2 seule apporte déjà l'essentiel de la protection et ne présente aucun risque
de régression — c'est celle à faire en premier.

**Suggested tests**

Test d'intégration : connexion en rôle propriétaire → la garde lève. Connexion en
`nova_app` → démarrage normal. Ce test doit tourner en CI (Tier 1).

**Dependencies** — La mesure 1 dépend de la stratégie de rôle pour les migrations
(cf. NOVA-P1-08). La mesure 2 est indépendante.

---

### NOVA-P0-03 — Les écritures validées ne sont pas immuables : on peut leur ajouter des lignes

| | |
|---|---|
| **Severity** | P0 |
| **Status** | **CONFIRMED** — reproduit |
| **Domain** | Ledger / intégrité comptable |

**Evidence**

`supabase/migrations/20260629000004_integrity.sql:170` :

```sql
create trigger trg_protect_lines
  before update or delete on entry_lines     -- ← INSERT absent
  for each row execute function protect_posted_lines();
```

L'INSERT n'est pas couvert. Le seul autre garde-fou est le trigger d'équilibre différé,
qui contrôle la **somme** des lignes — or une paire de lignes équilibrée laisse la somme
inchangée. Les deux contrôles se croisent sans se rencontrer.

**Reproduction** (rôle `nova_app`, Alice, sur **son propre** dossier — aucun franchissement
de tenant nécessaire) :

```
AVANT_nb_lignes        | 2
INSERT 0 1
INSERT 0 1
COMMIT                       ← aucune erreur

APRES_nb_lignes        | 4
total_debit_ecriture   | 1277777.0000      ← était 777 777
statut_ecriture        | posted | 2026-09-08 19:06:08   ← statut et horodatage inchangés
```

Une écriture **validée** a été gonflée de 500 000 XOF. Statut inchangé, `posted_at`
inchangé, aucune trace, aucun lien de contre-passation.

Défauts connexes, même trigger : `protect_posted_entries` autorise la modification de
`piece_ref`, `document_url`, `ai_confidence`, `posted_at` et `created_by` sur une écriture
validée — seuls `dossier_id`, `fiscal_year_id`, `journal_id`, `entry_date`, `description`
et `source` sont figés.

**Impact**

L'immuabilité est le fondement de l'auditabilité AUDCIF, et l'argument central du produit
(README : « ledger double-entrée **immuable** »). Cette garantie n'existe pas. Une écriture
validée peut être enrichie indéfiniment de paires équilibrées : les comptes touchés changent,
la TVA change, les états financiers changent, la piste d'audit ne montre rien.

**Reproductibilité par l'API : non.** Recherche exhaustive : `insert into entry_lines`
n'apparaît qu'à un seul endroit du serveur (`domain/accounting.ts`), toujours pour une
écriture nouvellement créée. **Aucune route HTTP n'atteint ce défaut aujourd'hui.**

C'est précisément ce qui le rend P0 plutôt que P2 : la protection actuelle est une
propriété accidentelle du code applicatif, pas une garantie du système. Elle disparaît au
premier import en masse, au premier outil Lexa d'écriture, au premier script de reprise —
et aucun des 439 tests actuels ne le verrait, puisqu'ils empruntent tous le chemin sûr.

**Recommendation**

1. Étendre le trigger : `before insert or update or delete on entry_lines`. Attention :
   `protect_posted_lines` lit `entries.status` — sur INSERT, l'écriture parente existe
   déjà, la fonction fonctionne telle quelle. Vérifier que `reverse_entry` n'est pas cassée
   (elle insère ses lignes **avant** de passer l'extourne à `posted` : l'ordre est bon).
2. Restreindre `protect_posted_entries` aux seules colonnes réellement mutables
   (`reversed_by_entry_id`, `status`), par liste blanche plutôt que par liste noire.

**Suggested tests**

Test SQL bloquant : insérer une paire équilibrée dans une écriture `posted` doit lever.
Test SQL : `update entries set piece_ref=… where status='posted'` doit lever.
À placer en Tier 1 (chaque PR) — c'est un invariant fondateur.

**Dependencies** — Vérifier `reverse_entry` (0007) et `redresser` (`reclassement.ts`)
après le changement : ce sont les deux chemins légitimes qui écrivent des lignes autour
d'écritures validées.

---

## 6. P1 findings — HIGH

### NOVA-P1-01 — `is_postable` n'est jamais imposé, seulement constaté

**Status : CONFIRMED** · Domain : ledger

La colonne `accounts.is_postable` existe (`migration 0002:48`, « false = compte de
regroupement »). Recherche exhaustive : **aucune contrainte, aucun trigger** ne l'utilise.
Côté serveur, elle n'est lue que pour être *affichée* (`agent.ts:590`, `accounting.ts:301`)
ou *détectée après coup* (`controls.ts:44-55`, contrôle de révision).

Reproduction : écriture posée directement sur le compte de tête `401`
(`is_postable = false`) → `A7_sur_compte_tete_acceptee = 1`. `postEntry` ne le vérifie
pas non plus (`accounting.ts:439` résout les comptes par code, sans filtrer `is_postable`).

Réponse à la question posée : **l'invariant « compte non saisissable → aucune écriture
directe » est uniquement signalé, jamais imposé.**

Impact : balance non ventilée, agrégats faussés (un montant sur `401` et sur `4011` se
cumule deux fois dans une lecture par racine), notes annexes et postes du bilan
imprévisibles. Le contrôle de révision le détecte — après coup, et seulement si on le lance.

Recommandation : contrainte en base (trigger sur `entry_lines` : refuser un `account_id`
dont `is_postable = false`) **et** contrôle dans `postEntry` pour un message utilisateur
clair. Prévoir une échappatoire explicite pour la reprise de balance d'ouverture si elle
en a besoin.

---

### NOVA-P1-02 — Bornes d'exercice non imposées en base

**Status : CONFIRMED** · Domain : ledger / exercices

`check_period_open` (`migration 0004:130`) vérifie que l'exercice n'est pas `closed`.
Il ne vérifie **pas** que `entry_date` tombe entre `start_date` et `end_date`.

Reproduction : écriture datée du `2019-07-04`, rattachée à l'exercice `2026-01-01 →
2026-12-31`, validée → `A6_hors_exercice_acceptee = 1`.

`postEntry` **impose** ce contrôle côté applicatif (`accounting.ts:416-423`), et le
commentaire y documente un bug réel déjà corrigé (comparaison `Date` JS vs chaîne, qui
laissait passer toutes les dates). Le domaine expose même un détecteur d'écritures hors
bornes (`accounting.ts:232`) — preuve que le cas se produit en pratique, typiquement à
l'import.

Impact : l'écriture compte dans la balance de l'exercice (filtrée par `fiscal_year_id`)
mais se place hors période dans tout état filtré par date (journal, grand livre, TFT,
FEC). Deux lectures du même exercice divergent.

Recommandation : ajouter la vérification des bornes dans `check_period_open`. La détection
existante (`accounting.ts:232`) et l'outil `reaffecter_exercice` restent utiles pour
l'existant à redresser.

---

### NOVA-P1-03 — Une ligne peut être imputée sur un compte d'un autre dossier du même cabinet

**Status : CONFIRMED** · Domain : ledger / multi-tenancy

Aucune contrainte ne lie `entry_lines.account_id` au dossier de la ligne. La clé étrangère
pointe `accounts(id)` sans condition sur `dossier_id`.

Entre cabinets, la RLS bloque indirectement (le compte de l'autre cabinet n'est pas
visible → `INSERT 0 0`). **Entre deux dossiers du même cabinet — le cas normal d'un cabinet
d'expertise — elle ne bloque rien**, puisque les deux sont dans `app_dossier_ids()` :

```
dossiers_du_cabinet_visibles   | 2
A10_lignes_compte_hors_dossier | 1     ← accepté
A10_ecriture_posted            | 1     ← et validé
```

De même, `entry_lines.dossier_id` peut différer de `entries.dossier_id` sans contrainte
(bloqué inter-cabinet par la RLS seulement).

Non atteignable par l'API : `postEntry` résout les comptes par **code dans le périmètre
du dossier** (`accounting.ts:439`), ce qui referme le trou côté applicatif.

Impact : contamination comptable entre deux clients d'un même cabinet. Le grand livre
joint `accounts` sur `account_id` : le libellé affiché appartiendrait au dossier voisin.

Recommandation : trigger de cohérence sur `entry_lines` vérifiant en une fois
`account.dossier_id = line.dossier_id = entry.dossier_id`. Une seule fonction couvre
les trois invariants.

---

### NOVA-P1-04 — XSS stocké : type MIME arbitraire servi en `inline`, sans CSP

**Status : CONFIRMED (par lecture de code, non exploité)** · Domain : documents / sécurité

`domain/documents.ts:saveDocument` ne valide **que** la taille (15 Mo) et la non-vacuité.
Le `mimeType` est fourni par le client et stocké tel quel. La table `EXT`
(`documents.ts:9`) ne recense que 6 types mais n'est utilisée que pour **nommer la clé
R2** — ce n'est pas une liste blanche (`EXT[input.mimeType] ?? 'bin'`).

La restitution (`api.ts:~896`) :

```js
res.setHeader('Content-Type', doc.mime);                      // ← contrôlé par l'uploadeur
res.setHeader('Content-Disposition', `inline; filename="…"`); // ← rendu dans le navigateur
```

Aucun en-tête `Content-Security-Policy` n'est posé (recherche exhaustive dans `api.ts` :
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`,
HSTS — pas de CSP). `nosniff` ne protège pas ici : le type *déclaré* est déjà `text/html`.

Aggravant : le middleware du portail client autorise explicitement le dépôt de pièces par
un rôle restreint (`api.ts:157` : `clientCanWrite` → `POST /documents`). **Un client
externe peut donc déposer le fichier.** Le front sert sur la même origine que l'API
(`SERVE_STATIC=true`) et le jeton JWT est en `localStorage` (`src/lib/session.ts:6`).

Chaîne : client externe dépose un `text/html` piégé → un collaborateur du cabinet ouvre
la pièce → script exécuté sur l'origine de l'application → vol du jeton (7 jours de
validité, non révocable, cf. NOVA-P2-02).

Recommandation : liste blanche de types MIME à l'entrée (les 6 de `EXT`), vérification
des octets d'en-tête (magic bytes) plutôt que confiance au champ déclaré,
`Content-Disposition: attachment` par défaut, `Content-Type: application/octet-stream`
pour tout type hors liste, et en-tête CSP global.

---

### NOVA-P1-05 — `reaffecter_exercice` : outil classé « brouillon » qui écrit réellement au grand livre

**Status : CONFIRMED** · Domain : AI/Lexa

`reaffecter_exercice` figure dans `DRAFT_TOOLS` (`agent.ts:437`), donc disponible dès le
palier **`assist`**, **sans exigence de rôle administrateur** (le contrôle owner/associé
de `agent.ts:565` ne s'applique qu'à `ACTION_TOOL_NAMES`).

Or son implémentation (`agent.ts:646` → `reclassement.preparerReaffectationExercice` →
`redresser`) appelle `reverseEntry(c, entryId)` — c'est-à-dire la fonction SQL
`reverse_entry`, qui **poste une contre-passation validée** au grand livre. La description
de l'outil le dit d'ailleurs elle-même : « contre-passation dans l'exercice erroné
(obligatoire, il est immuable) ».

Cela contredit deux contrats explicites du même fichier :

- `SYSTEM_GUARDRAILS` règle 1 : « Tu es en LECTURE SEULE. Tu ne crées, ne modifies et ne
  postes **JAMAIS** d'écriture. »
- `ASSIST_NOTE` : « Tu ne postes/émets/règles/clôtures **JAMAIS**. Ces actions restent
  100 % humaines. »

Nuance importante, à charge de décharge : l'écriture produite est **déterministe** (miroir
exact de l'écriture source), **équilibrée par construction**, **tracée**
(`reverses_entry_id`), **bornée au périmètre** (garde de `reverse_entry`, migration 0007),
**auditée** (`agent.ts:1067`) et n'est possible que sur une écriture réellement hors bornes.
Ce n'est pas « une écriture IA non contrôlée ». Mais c'est **irréversible** (une extourne
validée ne s'annule pas), déclenchable par un collaborateur, et contraire à la règle
affichée à l'utilisateur.

Deux autres outils postent au grand livre, mais eux sont correctement classés en
`ACTION_TOOLS` (donc `assist_plus` **+** owner/associé) : `comptabiliser_tva`
(→ `tax.postVatLiquidation` → `postEntry`) et `comptabiliser_dotations_dues`. Leur gating
est cohérent ; c'est le classement de `reaffecter_exercice` qui ne l'est pas.

Recommandation : déplacer `reaffecter_exercice` dans `ACTION_TOOLS`. Corriger les deux
règles du prompt, qui sont fausses au palier `assist_plus` et induisent l'utilisateur en
erreur sur ce que Lexa peut faire.

---

### NOVA-P1-06 — La CI exécute 1 suite de tests sur 18

**Status : CONFIRMED** · Domain : CI/CD

`package.json` déclare **18 scripts `test:*`**. `.github/workflows/ci.yml` en exécute
**un seul** : `npm run test:domain` (10 contrôles).

Exécutées manuellement pendant cette revue, sur base propre, les 18 suites passent :

| Suite | Contrôles | En CI |
|---|---|---|
| `test:payroll` | 78/78 | ❌ |
| `test:reclassement` | 67 | ❌ |
| `test:exercices` | 49 | ❌ |
| `test:axes` | 34 | ❌ |
| `test:assistant-analytique` | 34 | ❌ |
| `test:paie-variable` | 25 | ❌ |
| `test:notes` | 24 | ❌ |
| `test:pnl` | 23 | ❌ |
| `test:production-immo` | 23 | ❌ |
| `test:veille` | 19 | ❌ |
| `test:capture` | 15 | ❌ |
| `test:bornes` | 14 | ❌ |
| `test:controles` | 11 | ❌ |
| `test:coherence` | 9 | ❌ |
| **`test:securite`** | **4** | **❌** |
| `test:etats`, `test:postes` | qualitatif | ❌ |
| `test:domain` | 10 | ✅ |

**≈ 429 contrôles sur 439 ne tournent jamais automatiquement**, dont l'intégralité du
moteur de paie, des états financiers, des notes annexes — et **la suite de sécurité**,
qui est précisément le test de non-régression de la faille `dossier_delete`.

Ce qu'un merge vert garantit aujourd'hui : le typecheck passe, les 77 migrations
s'appliquent sur une base neuve, 8 contrôles SQL de base passent, et 10 contrôles de
domaine passent. Rien d'autre.

Recommandation : quality gate à trois niveaux (§ 16).

---

### NOVA-P1-07 — Le test RLS de la CI n'assertionne rien

**Status : CONFIRMED** · Domain : CI/CD / sécurité

L'étape CI s'intitule « SQL smoke test (ledger, immuabilité, **RLS**) ». La partie RLS
(`supabase/tests/smoke_test.sql`, fin de fichier) est :

```sql
SET ROLE app_role;
SELECT set_config('app.current_user_id', current_setting('app.test_uid'), false) AS _ ;
SELECT count(*) AS dossiers_visibles_par_le_user FROM dossiers;
RESET ROLE;
SELECT 'Tous les dossiers (vue admin)' AS info, count(*) AS total FROM dossiers;
```

**Aucun `IF … RAISE EXCEPTION`.** Le compte est affiché, jamais comparé. Ce test ne peut
pas échouer — même si la RLS était entièrement désactivée, la CI resterait verte. Sortie
observée : `dossiers_visibles_par_le_user = 1` face à `total = 23`, imprimé sans contrôle.

Second point, sur le même fichier : le contrôle 8 (`PASS 8 : balance équilibrée`) fait
`select coalesce(sum(balance),0) from v_account_balances` — c'est-à-dire une somme
**tous tenants confondus**, sur la vue même qui fuit (NOVA-P0-01). Et c'est une
tautologie : le trigger d'équilibre garantit déjà que chaque écriture est équilibrée,
donc la somme est nécessairement nulle. Ce contrôle ne peut rien détecter.

Recommandation : transformer les deux en assertions bloquantes. Pour la RLS, comparer à
une valeur attendue exacte et lever sinon. Pour l'équilibre, contrôler **par dossier** et
depuis les tables de base, pas depuis la vue.

---

### NOVA-P1-08 — Migrations « best-effort » : l'API sert avant et malgré l'échec

**Status : CONFIRMED** · Domain : base de données / déploiement

Trois éléments se combinent :

1. `Dockerfile` : `CMD ["sh","-c","node scripts/migrate-boot.mjs; npm run start"]` —
   le `;` (et non `&&`) démarre l'API même si les migrations échouent.
2. `scripts/migrate-boot.mjs` : chaque migration en erreur est `rollback`, journalisée,
   **ignorée**, et la suivante est tentée.
3. `server/index.ts:13` : `applyPendingMigrations()` est appelée **à l'intérieur du
   callback de `app.listen()`** — donc *après* que le port est ouvert. Le serveur accepte
   des requêtes pendant que le schéma se modifie, et continue si tout échoue.

C'est un choix assumé et documenté (« ne bloque JAMAIS le démarrage »), avec une intention
défendable : éviter un conteneur qui ne boote pas. Mais la conséquence est qu'**un schéma
incomplet est servi à l'application, sans signal**.

Le code de domaine s'en défend d'ailleurs par des `tableExists(…)` dispersés
(`accounting.ts:426`, `ledger.ts:31`, `ledger.ts:45`, `ledger.ts:62`…). Ces gardes
« tolérantes » sont elles-mêmes un symptôme : `postEntry` **saute silencieusement le
contrôle de clôture mensuelle** si `period_closures` n'existe pas encore. Une migration
ratée transforme donc un garde-fou comptable en non-opération, sans erreur.

`/api/health` expose bien un diagnostic de schéma (6 sondes), mais **personne ne le lit** :
il renvoie `ok: true` même si toutes les sondes sont fausses.

Recommandation : `migrate → verify → start`.

1. Séparer les phases : migrations en tâche de déploiement (release command), pas dans
   le processus API.
2. Introduire une **version de schéma attendue** (constante côté serveur + ligne en base).
   Au démarrage : si `version_en_base < version_attendue`, refuser de démarrer en
   production — même modèle qu'`assertAuthConfig()`.
3. Faire échouer `/api/health` (503) si une sonde de schéma est fausse, pour que
   l'orchestrateur ne bascule pas le trafic.
4. Retirer les `tableExists` des chemins portant un garde-fou comptable : à ces endroits,
   une table absente doit lever, pas passer.

---

### NOVA-P1-09 — ~~Un correctif P0 dort dans l'arbre de travail, non commité~~ → **RÉSOLU pendant la revue**

**Status : RESOLVED** (était CONFIRMED) · Domain : process

Au démarrage de la revue, à HEAD `a786be7`, le correctif de la faille `dossier_delete`
n'était **pas commité** :

```
 M package.json, server/api.ts, server/auth.ts, server/index.ts
?? server/integration-test-securite.ts
?? supabase/migrations/20260908000077_fix_dossier_delete_null_guard.sql
```

La migration 0077 corrige, de l'aveu même de son en-tête, une faille par laquelle
« **tout utilisateur authentifié pouvait SUPPRIMER n'importe quel dossier de la
plateforme** à partir de son seul identifiant — opération irréversible, avec toutes ses
écritures ».

**Commité pendant la revue** sous `9c5045b` (« Sécurité : faille critique de suppression
de dossier + durcissement »), avec son test de non-régression et trois durcissements
associés (en-têtes de sécurité, limiteur de débit sur l'authentification,
`assertAuthConfig()`). Le risque de perte du correctif est levé.

**Reste à faire** : vérifier en production que la version déployée contient bien la
migration 0077 — c'est-à-dire que `dossier_delete` refuse un appelant d'un autre cabinet.
Compte tenu du mode « best-effort » d'application des migrations (**NOVA-P1-08**), le fait
que le correctif soit dans le dépôt ne garantit pas qu'il soit appliqué en base. Point
maintenu au critère 10 du gate de pilote (§ 22).

---

## 7. P2 findings — MEDIUM

### NOVA-P2-01 — Politique monétaire : `NUMERIC` converti en flottant IEEE 754

**Status : CONFIRMED** · Domain : ledger / money

`server/db.ts:6` : `pg.types.setTypeParser(1700, (v) => Number(v))`. Tout `NUMERIC`
devient un `number` JavaScript (double 64 bits). Les colonnes sont en `numeric(20,4)`
(et `fx_rate` en `numeric(20,8)`), dont l'amplitude dépasse `Number.MAX_SAFE_INTEGER`.

Mesures effectuées :

```
1234567890123.4567   → 1234567890123.4568        perte au 4e décimal
99999999999999.9999  → 100000000000000           décimales entièrement perdues
0.1 + 0.2            = 0.30000000000000004 ≠ 0.3
10 000 × 0.01        = 100.00000000001425
```

Conséquence directe sur le contrôle applicatif : `postEntry` compare
`totalDebit !== totalCredit` **en flottant** (`accounting.ts:401`). Une écriture
légitimement équilibrée dont les lignes somment à `0.30000000000000004` face à `0.3`
serait **rejetée à tort**.

Atténuations réelles : le XOF n'a pas de sous-unité (la majorité des montants sont
entiers), et le trigger d'équilibre compare en `numeric` côté base — donc **exact**.
La base reste le juge ; le flottant n'est qu'un pré-filtre. Le risque est dormant, pas nul :
il se réveille sur la TVA, la paie, les taux de change et les devises à décimales.

**Money Policy recommandée**

1. **Unité de compte entière.** Stocker en plus petite unité indivisible de la devise
   (XOF : le franc ; devises à 2 décimales : le centime) en `BIGINT`, ou conserver
   `NUMERIC` en base et **ne jamais le convertir en `number`** côté Node.
2. **Retirer le `setTypeParser` global.** Laisser `pg` renvoyer la chaîne, et convertir
   explicitement au point d'usage — en entier pour les montants, en `Decimal` pour les
   calculs à décimales.
3. **Comparaisons d'équilibre en entier**, jamais en flottant. Le contrôle applicatif de
   `postEntry` doit raisonner dans la même unité que la base.
4. **Arrondi explicite et unique.** Un seul helper d'arrondi (demi-supérieur), appelé au
   moment de la persistance, jamais en cours de cumul. `round2` existe déjà dans
   `assets.ts` : le centraliser.
5. **Sérialisation JSON en chaîne** pour les montants exposés par l'API, afin que le front
   n'hérite pas du problème.
6. **Bornes explicites.** Contrainte `CHECK` sur les montants pour rejeter ce que
   l'application ne saura pas représenter fidèlement.

Chantier à traiter comme une migration de fond (WAVE 5), pas comme un correctif chaud.

---

### NOVA-P2-02 — Jetons JWT non révocables, 7 jours, aucune invalidation

**Status : CONFIRMED** · Domain : auth

`server/auth.ts` : TTL de 7 jours, pas de `jti`, aucune liste de révocation, aucune
vérification du statut du compte à chaque requête (le middleware `api.ts:127` ne fait que
vérifier la signature et poser `req.userId`).

Conséquences : la déconnexion est purement côté client (`localStorage.removeItem`) ;
un changement de mot de passe n'invalide pas les sessions existantes ; la désactivation
d'un compte ou le retrait d'un membre du cabinet laisse un accès valide jusqu'à 7 jours ;
un jeton volé (cf. NOVA-P1-04) reste exploitable.

À l'actif : l'algorithme n'est **pas** lu depuis l'en-tête du jeton (`verifyToken`
recalcule toujours en HMAC-SHA256), donc l'attaque « alg: none » et la confusion
d'algorithme ne s'appliquent pas. La comparaison de signature est à temps constant. Le
hachage `scrypt` est correct. `assertAuthConfig()` refuse de démarrer en production avec
un secret faible ou le repli `dev-secret-change-me` — bien vu, et vérifié.

Recommandation : ramener le TTL à 24 h avec jeton de rafraîchissement ; ajouter un
`token_version` sur `app_users`, incrémenté au changement de mot de passe et à la
désactivation, contrôlé à la vérification.

---

### NOVA-P2-03 — Webhooks : accusé 200 puis traitement en mémoire, sans reprise

**Status : CONFIRMED** · Domain : fiabilité

`api.ts` (WhatsApp et Telegram) :

```js
res.sendStatus(200);                        // accusé immédiat
if (msgs.length) waHandler.handleInbound(msgs).catch(() => {});   // puis traitement
```

Si le processus meurt (redéploiement, OOM, crash) entre les deux, **le message est
définitivement perdu** : le fournisseur a reçu son 200 et ne réémettra pas. Le `.catch(() => {})`
avale par ailleurs toute erreur de traitement, sans journal ni file d'attente.

Aucun mécanisme de reprise, d'idempotence sur l'identifiant de message, ni de
dead-letter. Redéployer pendant qu'un utilisateur écrit à Lexa perd son message.

Recommandation : persister le message entrant en base **avant** le 200 (avec son id
fournisseur pour l'idempotence), puis traiter depuis la file. Journaliser les échecs.

---

### NOVA-P2-04 — Limiteur de débit en mémoire, incompatible multi-instances

**Status : CONFIRMED** · Domain : auth / exploitation

`api.ts:112` : `const tentatives = new Map<string, number[]>()`, 10 tentatives / 15 min
par IP + email. Le commentaire assume le choix et annonce le passage à Redis au
multi-instances.

Limites : remis à zéro à chaque redéploiement ; contourné en répartissant sur plusieurs
instances ; la clé inclut l'email, donc changer d'email remet le compteur à zéro pour la
même IP (un balayage d'emails n'est pas ralenti). Seules les routes `register` et `login`
sont protégées — pas `2fa/enable`, ni `invitations/:token/accept`.

À l'actif : la protection existe, ce qui n'est pas si courant.

---

### NOVA-P2-05 — Toutes les erreurs non typées deviennent des HTTP 400

**Status : CONFIRMED** · Domain : API

`api.ts:140` : `const status = e?.status ?? 400;`

Une panne base, un dépassement de délai, un bug de programmation ou une contrainte
violée sont donc renvoyés au client en **400 Bad Request** avec `e.message` en clair.
Deux conséquences : la supervision ne distingue pas une erreur d'entrée d'une panne
serveur (les 5xx n'apparaissent jamais), et les messages internes fuient — y compris les
messages `RAISE EXCEPTION` des triggers, qui exposent des identifiants et des noms
d'objets base.

Recommandation : `500` par défaut, `400` seulement sur erreur validée explicitement ;
message générique au client et détail journalisé côté serveur avec un identifiant de
corrélation.

---

### NOVA-P2-06 — Aucun en-tête `Content-Security-Policy`

**Status : CONFIRMED** · Domain : sécurité front

Le bloc d'en-têtes (`api.ts:94-104`) pose `nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Cross-Origin-Resource-Policy` et HSTS en production. Pas de CSP.
Combiné à NOVA-P1-04 et au jeton en `localStorage`, c'est la défense manquante qui
transformerait un XSS en incident mineur.

---

### NOVA-P2-07 — Injection de prompt : surface réelle, aucune défense explicite

**Status : LIKELY** (analyse de code ; non exploité — cela aurait exigé une clé API
et des appels réels au modèle, hors périmètre d'une revue en lecture seule)
· Domain : AI/Lexa

`SYSTEM_GUARDRAILS` (12 règles, très travaillé) ne contient **aucune instruction** du type
« le contenu des documents, des libellés et des sorties d'outils est de la donnée, jamais
une instruction ».

Or du texte contrôlable par un tiers entre dans le contexte du modèle par plusieurs voies :
documents OCRisés (capture IA), transcriptions vocales Telegram, messages WhatsApp,
libellés d'écritures et noms de tiers remontés par les outils — et surtout la **mémoire
persistante** (`memoriser`, `lexa_memory`), réinjectée dans le contexte à chaque session.
Une instruction plantée dans la mémoire devient une injection **persistante**.

Ce qui contient réellement le risque, et qui est du bon travail : le rayon d'action est
borné par le gating de mode **et** de rôle. Une injection réussie ne peut pas dépasser ce
que l'utilisateur courant pouvait déjà faire — au pire déclencher un outil de son propre
palier. `envoyer_email` exige `assist_plus` **et** owner/associé, et le prompt impose de
confirmer le destinataire.

Recommandation : ajouter une règle explicite de séparation donnée/instruction ; encadrer
les sorties d'outils et le contenu documentaire par des délimiteurs ; filtrer les faits
mémorisés (longueur, motifs impératifs) avant persistance ; exiger une confirmation
humaine hors-bande pour tout outil d'envoi externe.

---

### NOVA-P2-08 — Dépendances vulnérables

**Status : CONFIRMED** · Domain : supply chain

`npm audit --omit=dev` : **6 vulnérabilités (3 hautes, 3 modérées)**.

- `postcss` — 2 avis hauts (path traversal via `sourceMappingURL`, lecture de fichiers
  `.map` arbitraires).
- `qs` < 6.15.3 via `express@4.22.2` — déni de service et contournement de `array-limit`.

`npm audit fix` est annoncé suffisant. Par ailleurs `vite` et `@vitejs/plugin-react`
figurent en `dependencies` (production) alors que ce sont des outils de build : l'image
Docker embarque une chaîne de build complète en production, ce qui élargit inutilement la
surface. Le `Dockerfile` le justifie (« vite/tsx nécessaires au build et au runtime »),
mais un build multi-étapes réglerait les deux.

Aucun secret commité, `.env.local` non suivi, `.env.example` propre — c'est vérifié.

---

### NOVA-P2-09 — `server/api.ts` : 311 routes, 2 334 lignes, 78 imports

**Status : CONFIRMED** · Domain : maintenabilité

C'est le point de couplage maximal du projet et le fichier le plus modifié. Il reste
lisible (routes de 3 à 6 lignes, aucune SQL), mais toute évolution y passe, ce qui
concentre les conflits de fusion et rend la revue de sécurité par route difficile.

273 des 311 routes partagent le préfixe `/api/dossiers/:id` — le découpage naturel existe
déjà. Recommandation : `express.Router()` par domaine, sans changement de comportement
(WAVE 5).

---

### NOVA-P2-10 — Trois versions de Node, et un nom de paquet trompeur

**Status : CONFIRMED** · Domain : supply chain / exploitation

Node 24.14.0 en local, **20** en CI (`ci.yml`), **22-slim** dans l'image Docker. Aucun
champ `engines`, aucun `.nvmrc`. La CI ne valide donc pas le runtime de production.

`package.json` : `"name": "react-example"`, `"version": "0.0.0"` — reliquat de gabarit sur
un produit financier, gênant en traçabilité (journaux, rapports d'incident, SBOM).

---

## 8. P3 findings — LOW

### NOVA-P3-01 — `PLAN-MISE-EN-OEUVRE.md` promet un offline-first qui n'existe pas
**Status : CONFIRMED** · Détail en § 18.

### NOVA-P3-02 — Aucun identifiant de corrélation, journalisation non structurée
Les journaux sont des `console.log`/`console.warn` en texte libre. Aucun `requestId`, donc
impossible de relier les événements d'une même requête. Aucune métrique, aucune alerte.
Point à traiter en WAVE 6, avant d'ouvrir le pilote.

### NOVA-P3-03 — 49 fonctions `SECURITY DEFINER`, 47 avec `search_path` explicite
Les deux exceptions sont les **définitions initiales** de `reverse_entry`
(`0004:146`) et d'une fonction de `0006`, toutes deux **remplacées ensuite** par des
versions correctes (`0007` pour `reverse_entry`, avec `set search_path = public` et une
garde de périmètre). Sur une base migrée à jour, l'état final est sain. Le risque est
résiduel : il ne concerne qu'une base arrêtée en cours de migration. À nettoyer par
hygiène.

### NOVA-P3-04 — Numérotation des migrations couplée à la date
`20260908000077_…` mêle horodatage et numéro de séquence. Deux développeurs en parallèle
peuvent produire un ordre incohérent entre local et production. Sans conséquence
aujourd'hui (un seul contributeur), à cadrer avant d'ouvrir le dépôt.

### NOVA-P3-05 — Aucun test sur l'authentification
Aucune suite ne couvre `server/auth.ts` : ni signature JWT, ni expiration, ni TOTP, ni
limiteur de débit. C'est le module le plus sensible du produit et le seul totalement non
testé.

### NOVA-P3-06 — Fichiers résiduels à la racine
`out.txt` (14 octets) est suivi par git. `dist/` et `scratchpad/` existent localement mais
sont bien ignorés.

---

## 9. Accounting Integrity

**Statut : PARTIAL**

### Ce qui est prouvé solide

| Invariant | Méthode | Résultat |
|---|---|---|
| Équilibre débit = crédit à la validation | trigger `check_entry_balanced_on_post` | ✅ rejette (D=100 / C=50) |
| Équilibre après modification des lignes | trigger différé `trg_entry_balanced` | ✅ rejette |
| Suppression d'une écriture validée | `protect_posted_entries` | ✅ rejette |
| Modification des montants d'une ligne validée | `protect_posted_lines` (UPDATE) | ✅ rejette |
| Écriture dans un exercice clos | `check_period_open` | ✅ rejette |
| Contre-passation | `reverse_entry` | ✅ statut + lien posés |
| Contre-passation hors périmètre | garde de `reverse_entry` (0007) | ✅ rejette |
| **25 validations concurrentes** | 25 transactions parallèles | ✅ **25/25, zéro déséquilibre** |
| Cohérence globale après tous les tests | requête d'audit | ✅ **0 écriture posted déséquilibrée** |

### Ce qui ne l'est pas

| Invariant annoncé | Réalité | Finding |
|---|---|---|
| « Une écriture validée est immuable » | On peut lui **ajouter** des lignes équilibrées | **P0-03** |
| « Compte non saisissable → aucune écriture » | Uniquement **détecté** par la révision | **P1-01** |
| Date dans les bornes de l'exercice | Imposé en TypeScript, **pas en base** | **P1-02** |
| Ligne rattachée au bon dossier | Aucune contrainte compte↔dossier | **P1-03** |

### Le constat central

Le contrat écrit dans `20260629000004_integrity.sql` — « ces règles vivent EN BASE (pas
dans l'applicatif) » — **n'est tenu que pour l'équilibre**. Les quatre autres invariants
vivent dans `server/domain/accounting.ts`.

Ce n'est pas un défaut de conception : c'est un **écart entre l'intention et la
réalisation**, avec une intention correcte. Le code applicatif fait bien le travail
aujourd'hui, et un seul chemin écrit dans `entry_lines` — c'est pourquoi les 439 tests
passent et pourquoi aucune donnée n'est corrompue. La faiblesse est structurelle, pas
opérationnelle : la garantie est portée par une discipline, pas par le moteur.

### États financiers

L'articulation est vérifiée, et bien conçue :

- `test:etats` contrôle l'équilibre du bilan **et** le recoupement du résultat avec la
  balance — deux sources de calcul distinctes qui se recoupent.
- Deux implémentations coexistent volontairement (`financialStatements` par nature,
  `etatsOfficiels` au format officiel avec SIG). **Ce n'est pas de la duplication
  accidentelle mais un contrôle croisé.**
- Les comptes non affectés à un poste sont **exposés** (`comptesNonAffectes`) plutôt que
  masqués — `docs/RESTE-A-FAIRE.md § 1.1` documente les 10 comptes concernés et assume le
  choix : « un trou visible vaut mieux qu'un trou comblé au jugé ». C'est la bonne
  décision d'ingénierie comptable.
- Les notes annexes (`test:notes`, 24 contrôles) sont dérivées du grand livre, pas d'un
  écart de soldes.
- Le TFT s'annonce lui-même comme indicatif et expose son écart de réconciliation.

**Un seul contrôle auto-référentiel détecté** : `PASS 8` du smoke test (cf. NOVA-P1-07),
qui vérifie l'équilibre depuis la vue en sommant tous tenants — tautologique, puisque le
trigger le garantit déjà.

---

## 10. Security

**Statut AUTHORIZATION : PARTIAL**

### Authentification

| Point | État |
|---|---|
| Hachage mot de passe | ✅ `scrypt` natif, sel 16 o, sortie 64 o |
| Comparaison | ✅ `timingSafeEqual`, longueur vérifiée d'abord |
| JWT — algorithme | ✅ **non lu depuis l'en-tête** : « alg: none » et confusion inopérantes |
| JWT — signature | ✅ HMAC-SHA256, comparaison à temps constant |
| JWT — secret faible en production | ✅ `assertAuthConfig()` **refuse le démarrage** |
| JWT — expiration | ✅ vérifiée · ⚠️ 7 jours |
| Révocation de session | ❌ inexistante (**P2-02**) |
| TOTP (RFC 6238) | ✅ base32 + HMAC-SHA1, fenêtre ±1, format validé |
| Limitation de débit | ⚠️ en mémoire, `login`/`register` seulement (**P2-04**) |
| Énumération de comptes | ✅ message unique « Identifiants invalides » |
| Récupération MFA | ❌ aucun code de secours : 2FA perdue = compte perdu |

`assertAuthConfig()` mérite d'être souligné : le repli `dev-secret-change-me` existe pour
le confort local, mais le démarrage est **refusé en production** si le secret est absent,
égal au repli, ou plus court que 24 caractères. C'est le bon compromis, correctement
implémenté, et le commentaire explique pourquoi.

### Autorisation

Le modèle est à trois étages, et les trois ont été testés :

1. **RLS** — périmètre des données (`app_dossier_ids()`).
2. **Fonctions `SECURITY DEFINER`** — contrôle de rôle métier (`owner`/`associe`).
3. **Middleware portail** (`api.ts:158`) — liste blanche en écriture pour les rôles
   restreints (`client`/`lecture`), refus par défaut.

Cinq attaques inter-tenant, toutes bloquées, chacune par une garde différente :

| Attaque (Bob, cabinet B → cabinet A) | Résultat |
|---|---|
| Lire les écritures de A | ✅ 0 ligne |
| Lister les membres du cabinet A | ✅ `Accès refusé à ce cabinet` |
| S'ajouter comme owner du cabinet A | ✅ `Réservé aux administrateurs du cabinet` |
| Renommer le cabinet A | ✅ `Réservé aux administrateurs du cabinet` |
| Contre-passer une écriture de A | ✅ `Accès refusé au dossier de l'écriture` |
| S'attribuer un accès au dossier A | ✅ `violates row-level security policy` |

Le classement en PARTIAL tient à trois points, pas à la conception : NOVA-P0-02 (le modèle
entier repose sur une hypothèse non vérifiée au démarrage), NOVA-P1-04 (XSS → vol de
jeton) et NOVA-P2-02 (jeton non révocable).

Matrices complètes : [`NOVA_SECURITY_BOUNDARY_MAP_001.md`](./NOVA_SECURITY_BOUNDARY_MAP_001.md).

---

## 11. Multi-tenancy

**Statut TENANT_ISOLATION : PARTIAL**

### Le modèle

```
app_users
    └── cabinet_members (owner | associe | collaborateur)
            └── cabinets
                    └── dossiers ──── dossier_access (client | lecture)
                            └── 54 tables métier portant dossier_id
```

Deux fonctions `STABLE SECURITY DEFINER set search_path = public` calculent le périmètre :
`app_cabinet_ids()` et `app_dossier_ids()` (appartenance au cabinet **ou** accès direct).
Une seule policy `FOR ALL USING (…) WITH CHECK (…)` par table, avec le même motif partout —
uniformité qui rend l'audit possible.

### Couverture mesurée

```
TOTAL_TABLES  | 59
RLS_ENABLED   | 57     ← les 2 exceptions sont du référentiel système partagé
RLS_FORCED    |  0     ← NOVA-P0-02
```

Les 2 tables sans RLS (`chart_templates`, `chart_template_accounts`) sont le gabarit
SYSCOHADA, identique pour tous, sans donnée client : c'est correct.

### Le verdict

L'isolation est **réelle et bien conçue au niveau des tables**, et elle résiste aux
attaques directes. Elle échoue à deux endroits :

- par une **vue** qui court-circuite la RLS (NOVA-P0-01) ;
- par une **hypothèse de déploiement** non vérifiée (NOVA-P0-02).

Le second point est le plus préoccupant, parce qu'il ne se voit pas : la plateforme
fonctionne parfaitement en montrant tout à tout le monde.

Recherche d'IDOR : les 311 routes ont été extraites et analysées. 273 passent par
`/api/dossiers/:id` et sont donc soumises au middleware portail **et** à la RLS. Les 13
routes portant un autre identifiant de ressource délèguent toutes leur autorisation à des
fonctions SQL contrôlées. Les 6 routes non authentifiées sont légitimes (`health`,
`register`, `login`, consultation et acceptation d'invitation par jeton, catch-all SPA).
**Aucun IDOR confirmé par changement d'identifiant.**

---

## 12. AI / Lexa

**Statut AI_GUARDRAILS : PARTIAL** — proche du PASS.

### La chaîne

```
Utilisateur (app | WhatsApp | Telegram | voix)
   │  dossierId ← route ou table de liaison — JAMAIS le modèle
   ▼
runAgent(client, dossierId, historique, userId)
   ├── mode  = dossiers.agent_mode        (readonly | assist | assist_plus)
   └── admin = cabinet_members.role ∈ (owner, associe)
   ▼
Outils exposés au modèle :
   readonly     → READ_TOOLS (56)
   assist       → + DRAFT_TOOLS (4)
   assist_plus  → + REVERSIBLE_TOOLS (2) + (admin ? ACTION_TOOLS (9) : ∅)
   ▼
executeTool() — REVÉRIFIE mode ET rôle  ← défense en profondeur
   ▼
domain/*.ts → withUser → RLS → PostgreSQL → triggers d'intégrité
```

### Ce qui est bien fait

- **Le périmètre n'est jamais contrôlé par le modèle.** `dossierId` vient de la route ou
  de `resolvePhone`/`resolveChat`. Aucun outil ne prend un identifiant de dossier en
  paramètre. Lexa ne peut pas se déplacer entre dossiers.
- **Double gating.** Les outils ne sont pas exposés (`agent.ts:1017`) **et** le dispatcher
  revérifie (`agent.ts:553-563`). Le commentaire précise que c'est délibéré, pour couvrir
  WhatsApp et Telegram — canaux qui n'empruntent pas le middleware HTTP.
- **Mode ≠ rôle.** Le mode est une propriété du dossier, le rôle une propriété de la
  personne. Les actions irréversibles exigent **les deux**. Un collaborateur en
  `assist_plus` ne peut pas envoyer d'email ni lancer une paie.
- **`LLM ≠ moteur comptable`.** `postEntry` n'est jamais appelé depuis `agent.ts`. Les
  validateurs AQM (`valider_ecriture`, `valider_facture`, `valider_declaration`) sont
  déterministes, en TypeScript.
- **Ancrage anti-hallucination.** L'outil `plan_comptable` est obligatoire avant toute
  proposition d'imputation, et refuse explicitement d'inventer un code.
- **Traçabilité.** Chaque outil mutant est journalisé dans `audit_log`
  (`agent.ts:1067`) ; le `decision_ledger` conserve question, mode, modèle, outils,
  validations et confiance.

### Ce qui manque

| | |
|---|---|
| **P1-05** | `reaffecter_exercice` classé « brouillon » alors qu'il **poste une contre-passation** — et le prompt affirme le contraire à l'utilisateur |
| **P2-07** | Aucune défense explicite contre l'injection de prompt, alors que documents, transcriptions et **mémoire persistante** entrent dans le contexte |

### Matrice RÔLE × ACTION LEXA

| Capacité | readonly | assist | assist_plus (collab.) | assist_plus (owner/associé) |
|---|:--:|:--:|:--:|:--:|
| Lecture (56 outils) | ✅ | ✅ | ✅ | ✅ |
| Brouillons facture vente/achat | ❌ | ✅ | ✅ | ✅ |
| Brouillon de reclassement | ❌ | ✅ | ✅ | ✅ |
| **`reaffecter_exercice` (poste une extourne)** | ❌ | **⚠️ ✅** | ⚠️ ✅ | ⚠️ ✅ |
| Lettrage automatique (réversible) | ❌ | ❌ | ✅ | ✅ |
| Préparer une relance (sans envoi) | ❌ | ❌ | ✅ | ✅ |
| Comptabiliser dotations / TVA (**poste**) | ❌ | ❌ | ❌ | ✅ |
| Préparer le livre de paie | ❌ | ❌ | ❌ | ✅ |
| Envoyer un email / relancer (irréversible) | ❌ | ❌ | ❌ | ✅ |
| Valider, émettre, clôturer | ❌ | ❌ | ❌ | ❌ (100 % humain) |

La seule case incohérente est signalée en ⚠️.

---

## 13. Database

**Statut MIGRATIONS : PARTIAL**

### Ce qui est vérifié

- **Les 77 migrations s'appliquent sans erreur** sur une base Postgres 16 neuve, dans
  l'ordre lexicographique : `MIGRATIONS FAILED: 0`.
- Le schéma final compte 59 tables, 1 vue, 49 fonctions `SECURITY DEFINER`.
- Les clés étrangères sont posées avec des politiques `ON DELETE` réfléchies :
  `restrict` sur `entries.dossier_id` et `entry_lines.account_id` (on ne supprime pas
  sous une écriture), `cascade` sur `entry_lines.entry_id` (les lignes suivent leur
  écriture), `set null` sur les rattachements optionnels.
- Les index couvrent les accès principaux (`idx_entries_dossier_year`,
  `idx_entry_lines_entry`, `idx_entry_lines_account`, `idx_accounts_dossier`) et la
  déduplication des imports est garantie par un index unique partiel
  (`uq_entry_lines_external`).
- La suppression d'un dossier passe par `dossier_delete(uuid)`, un démontage ordonné —
  pas par une cascade implicite.
- **47 des 49 fonctions `SECURITY DEFINER` posent `set search_path = public`.** Les deux
  exceptions sont des définitions initiales remplacées plus tard (cf. NOVA-P3-03).

### Ce qui pose problème

| | |
|---|---|
| **P0-01** | Vue sans `security_invoker` → contournement de la RLS |
| **P0-02** | Aucun `FORCE ROW LEVEL SECURITY` |
| **P0-03 / P1-01 / P1-02 / P1-03** | Quatre invariants comptables absents du schéma |
| **P1-08** | Application « best-effort » : schéma incomplet servi sans signal |

### Idempotence

Les migrations ne sont pas idempotentes individuellement (`create type`, `create table`
sans `if not exists`), mais le registre `_migrations` garantit qu'elles ne sont jouées
qu'une fois. C'est un compromis acceptable — à condition que le registre soit fiable, ce
que le mode best-effort fragilise : une migration ignorée n'est **pas** enregistrée, donc
elle sera retentée au démarrage suivant, indéfiniment, sans alerte.

---

## 14. API

311 routes, un seul fichier. Inventaire complet et analyse par route :
[`NOVA_SECURITY_BOUNDARY_MAP_001.md`](./NOVA_SECURITY_BOUNDARY_MAP_001.md).

| Méthode | Nombre |
|---|---|
| GET | 145 |
| POST | 116 |
| DELETE | 32 |
| PATCH | 13 |
| PUT | 5 |

**Routes non authentifiées (6, toutes légitimes)** : `/api/health`, `/api/auth/register`,
`/api/auth/login`, `GET /api/invitations/:token`, `POST /api/invitations/:token/accept`,
et le catch-all `GET *` (SPA).

**Routes à secret partagé (3)** : `/api/cron/watchdog` (`x-cron-secret`, **refuse si le
secret n'est pas configuré** — fail-closed correct), `/api/whatsapp/webhook`
(signature HMAC `x-hub-signature-256` sur le corps brut), `/api/telegram/webhook`
(`x-telegram-bot-api-secret-token`).

**Points positifs** : aucune SQL dans `api.ts` ; `requireUser` systématique ailleurs ;
en-têtes de sécurité posés globalement ; corps limité à 15 Mo ; corps brut conservé
uniquement pour la vérification de signature ; le middleware portail refuse par défaut
(liste blanche, pas liste noire).

**Points à corriger** : NOVA-P2-05 (tout devient 400 et les messages internes fuient),
NOVA-P1-04 (téléversement), NOVA-P2-06 (pas de CSP), NOVA-P2-09 (taille du fichier).

Pas de mass assignment détecté : les routes déstructurent explicitement
(`const { email, role } = req.body ?? {}`), elles ne passent jamais `req.body` entier au
domaine. C'est une discipline tenue sur les 311 routes.

---

## 15. Frontend

69 fichiers, ~15 400 lignes. React 19 + Vite + Tailwind 4.

**Organisation** — 62 composants dans un `src/components/` plat, un module `src/lib/api.ts`
(1 156 lignes) qui centralise **tous** les appels réseau. Aucune logique comptable côté
client : les calculs viennent de l'API. Cette séparation est tenue et c'est le point le
plus important pour un produit comptable.

**État** — pas de gestionnaire d'état global (ni Redux, ni Zustand, ni React Query). État
local et remontée de props. Acceptable à cette taille, mais `App.tsx` (287 lignes) porte
déjà la navigation entre 62 écrans et deviendra le point de friction.

**Authentification** — jeton JWT en `localStorage` (`src/lib/session.ts:6`). Accessible en
JavaScript, donc exposé à tout XSS (cf. NOVA-P1-04).

### Offline-first : la promesse et la réalité

Recherche exhaustive dans `src/`, `public/`, `index.html`, `vite.config.ts` :

| Élément | Présent |
|---|---|
| `manifest.webmanifest` | ✅ |
| **Service worker** | ❌ **aucun** |
| Cache hors-ligne | ❌ |
| IndexedDB / stockage local de données | ❌ |
| File de synchronisation différée | ❌ |
| CRDT | ❌ |

**Verdict : l'offline-first n'est pas partiel — il est absent.** Ce qui existe est un
manifeste PWA : l'application est *installable* sur un écran d'accueil, rien de plus.
Sans réseau, elle ne fonctionne pas.

Le README est honnête (« PWA-ready »). `docs/PLAN-MISE-EN-OEUVRE.md` ne l'est pas
(cf. § 18) : il annonce « offline-first dès le MVP, non rétrofité » et un « moteur local
(IndexedDB) + CRDT/queue de sync ». Sur un marché où la connectivité intermittente est
présentée comme « exigence #1 terrain », c'est l'écart de documentation le plus coûteux
du dépôt — pour un développeur qui construit dessus comme pour un discours commercial.

---

## 16. Tests & CI

**Statut CI_GATE : FAIL**

Détail complet : [`NOVA_TEST_COVERAGE_MAP_001.md`](./NOVA_TEST_COVERAGE_MAP_001.md).

### Ce qu'un merge vert garantit aujourd'hui

1. `tsc --noEmit` passe sur le front **et** le serveur (vérifié : **propre**).
2. Les 77 migrations s'appliquent sur une base neuve (vérifié : **0 échec**).
3. 8 contrôles SQL passent — dont **un qui n'assertionne rien** (NOVA-P1-07).
4. 10 contrôles de domaine passent.

**Rien d'autre.** Ni la paie (78 contrôles), ni les états financiers, ni les notes
annexes, ni l'analytique, ni les reclassements, ni **la sécurité**.

### Ce que les tests valent réellement

Le chiffre brut (439 contrôles) flatte moins que leur **conception**, qui est bonne :

- `test:exercices` verrouille la règle la plus glissante du produit — lecture par exercice
  (avec à-nouveaux) vs lecture cumulée (qui doit écarter les reports). `docs/DEV-LOCAL.md`
  explique pourquoi : « sinon tout ce qui touche au bilan double après la première clôture ».
  C'est un test écrit par quelqu'un qui a compris le piège.
- `test:etats` recoupe deux sources de calcul indépendantes.
- `test:payroll` inclut des tests « golden » sur le barème ITS officiel.
- `test:securite` est un test de non-régression écrit **à partir d'une faille réelle**.

Faiblesses de fond : les tests d'intégration partagent une base et créent des données
sans nettoyage systématique (dépendance à l'ordre possible) ; **aucun test unitaire pur**
(tout passe par Postgres) ; **aucun test sur `auth.ts`** ; aucun test de propriété ni de
fuzzing sur les invariants comptables ; et surtout **aucun test ne vérifie les invariants
manquants** identifiés ici — ce qui est logique, puisqu'ils passent tous par le chemin sûr.

### Quality gate proposé

**Tier 1 — chaque PR (cible < 5 min)**
- `typecheck` + `build`
- Migrations sur base neuve
- **Invariants ledger en SQL** — assertions bloquantes : équilibre, immuabilité
  (y compris **INSERT** sur écriture validée, P0-03), bornes d'exercice, `is_postable`,
  cohérence compte↔dossier
- **Smoke sécurité** — RLS avec assertion réelle (P1-07), garde de rôle base (P0-02),
  vue `v_account_balances` isolée (P0-01)
- `test:domain`, `test:securite`, `test:payroll` (rapides et à fort enjeu)

**Tier 2 — PR touchant le domaine, et tout merge sur `main`**
- Les 18 suites `test:*`
- `test:exercices`, `test:etats`, `test:postes`, `test:notes`, `test:controles`,
  `test:coherence`, `test:axes`, `test:pnl`, `test:reclassement`, `test:bornes`,
  `test:production-immo`, `test:paie-variable`, `test:capture`, `test:veille`,
  `test:assistant-analytique`
- `npm audit --omit=dev` (échec sur `high`)

**Tier 3 — nocturne**
- Scénario complet : cabinet → dossiers → exercices → clôture → réouverture → états
- Tests de propriété sur le ledger (montants aléatoires, dates aux bornes, très grands
  nombres, décimales) — c'est ce qui aurait attrapé NOVA-P2-01
- Fuzzing des routes (corps malformés, identifiants d'autres tenants)
- Tests IA avec clé réelle : injection de prompt, tentative de franchissement de dossier,
  tentative de dépassement de palier
- Performance : 10 000 écritures, temps de génération des états

---

## 17. DevOps

| Point | État |
|---|---|
| Image Docker | ⚠️ mono-étage, embarque la chaîne de build en production |
| Migrations | ❌ best-effort, après l'ouverture du port (**P1-08**) |
| Version Node | ❌ trois versions différentes (**P2-10**) |
| Sonde de santé | ⚠️ existe et diagnostique le schéma, mais renvoie `ok` même si le schéma est incomplet |
| Journalisation | ❌ `console.*` en texte libre, sans corrélation (**P3-02**) |
| Métriques / alertes | ❌ aucune |
| Sauvegarde / restauration | ❌ non documentée, non testée |
| Runbook incident | ❌ absent |
| Secrets | ✅ par variables d'environnement, rien de commité |
| Tâches planifiées | ⚠️ `setInterval` dans le processus API — **suppose une instance unique** |
| Reprise après crash | ❌ aucune (**P2-03**) |

Le point le plus structurant : **l'ordonnanceur nocturne et le limiteur de débit vivent
dans le processus API et supposent une instance unique**. C'est assumé et commenté, et
correct à l'échelle actuelle — mais cela signifie que Nova ne peut pas être mis à
l'échelle horizontalement sans travail préalable. À connaître avant de vendre un pilote
multi-cabinets.

Avant d'ouvrir le pilote, deux manques sont bloquants pour l'exploitation : **sauvegarde
vérifiée** (une restauration jamais testée n'est pas une sauvegarde) et **runbook**.

---

## 18. Documentation

La documentation est abondante et souvent excellente — les commentaires de migration et
de domaine expliquent le *pourquoi*, ce qui est rare. `docs/RESTE-A-FAIRE.md` est un
modèle d'honnêteté technique : il documente les incertitudes non résolues (postes AL et BS)
plutôt que de les masquer.

Le problème n'est pas la quantité mais la **divergence**.

| Document | Affirmation | Réalité |
|---|---|---|
| `PLAN-MISE-EN-OEUVRE.md:88` | « Principe directeur : **offline-first** » | Aucun service worker (§ 15) |
| `PLAN-MISE-EN-OEUVRE.md:92` | « PWA **offline-first**, fonctionne sans réseau, sync différée » | Un manifeste, rien de plus |
| `PLAN-MISE-EN-OEUVRE.md:93` | « Moteur local (IndexedDB) + CRDT/queue de sync » | Aucune trace |
| `PLAN-MISE-EN-OEUVRE.md:150` | « Offline-first **dès le MVP**, non rétrofité » | Non commencé |
| `PLAN-MISE-EN-OEUVRE.md:72` | « Parsing SMS Mobile Money **offline, sur device** » | Parsing serveur (`mobilemoney/parser.ts`) |
| `README.md:37` | « ledger double-entrée **immuable** » | Faux : **NOVA-P0-03** |
| `migration 0004` (en-tête) | « Ces règles vivent **EN BASE** (pas dans l'applicatif) » | Vrai pour l'équilibre seul ; 4 invariants en TypeScript |
| `ci.yml` (étape) | « SQL smoke test (ledger, immuabilité, **RLS**) » | La partie RLS n'assertionne rien (**P1-07**) |
| `agent.ts` `SYSTEM_GUARDRAILS` règle 1 | « Tu es en LECTURE SEULE… ne postes **JAMAIS** d'écriture » | Faux en `assist_plus` et via `reaffecter_exercice` (**P1-05**) |
| `agent.ts` `ASSIST_NOTE` | « Tu ne postes/émets/règles/clôtures **JAMAIS** » | Idem |
| `DEV-LOCAL.md` § Tests | Cite 3 suites | Il en existe **18** |
| `RESTE-A-FAIRE.md` | « Dernière mise à jour : 2 août 2026 » | 5 semaines de retard ; ne mentionne aucun P0 de cette revue |
| `package.json` | `"name": "react-example"` | Produit financier |

Les trois lignes sur les invariants sont les plus dangereuses : elles ne trompent pas
seulement un lecteur humain, elles trompent **Claude Code, Codex et tout agent** qui lira
ces fichiers comme une spécification faisant autorité. Un agent qui lit « ces règles vivent
en base » n'ira pas revérifier l'invariant avant d'ajouter un chemin d'écriture — et c'est
exactement ainsi que NOVA-P0-03 deviendra exploitable.

**Recommandation** : traiter la correction documentaire comme faisant partie du correctif,
pas comme une tâche annexe. Une garantie fausse est pire qu'une garantie absente.

---

## 19. Production Readiness Score

| Axe | Note | Justification |
|---|:--:|---|
| Product architecture | **8/10** | Monolithe modulaire cohérent, couches respectées, couverture fonctionnelle remarquable pour la taille de l'équipe |
| Accounting architecture | **8/10** | Modèle SYSCOHADA sérieux, exercices, clôtures, à-nouveaux, analytique multi-axes, notes dérivées du grand livre |
| Ledger integrity | **5/10** | Équilibre et concurrence irréprochables ; immuabilité rompue, 3 invariants hors base |
| SYSCOHADA reporting | **8/10** | Deux implémentations qui se recoupent, SIG, comptes non affectés exposés plutôt que masqués |
| Multi-tenancy | **5/10** | Modèle propre et uniforme, 5 attaques bloquées — mais une vue qui fuit et une hypothèse de déploiement non gardée |
| Authorization | **7/10** | RBAC à trois étages testé et solide ; pas de révocation de session |
| Security | **5/10** | Auth maison de bonne facture ; XSS stocké, pas de CSP, jeton non révocable |
| AI safety | **7/10** | Architecture parmi les meilleures vues sur ce type de produit ; un outil mal classé, pas de défense anti-injection |
| Backend architecture | **7/10** | Séparation nette, `withUser` unique ; `api.ts` trop gros |
| Frontend architecture | **6/10** | Propre et sans logique métier ; pas d'état global, offline-first inexistant |
| Database architecture | **6/10** | FK et index réfléchis, RLS uniforme, `search_path` maîtrisé ; invariants manquants, pas de `FORCE` |
| Testing | **6/10** | 439 contrôles bien conçus, qui verrouillent les vrais pièges ; aucun sur l'auth, aucun sur les invariants manquants |
| CI/CD | **3/10** | 1 suite sur 18 ; le test RLS n'assertionne rien ; migrations best-effort |
| Reliability | **4/10** | Concurrence ledger excellente ; webhooks sans reprise, instance unique, pas de sauvegarde testée |
| Observability | **2/10** | `console.log`, aucune corrélation, aucune métrique, aucune alerte |
| Documentation | **6/10** | Abondante et souvent excellente (le *pourquoi* est écrit) ; 13 divergences dont 4 sur des garanties |
| Maintainability | **7/10** | Code lisible, commentaires utiles, nommage cohérent ; deux fichiers trop gros |
| **Pilot readiness** | **4/10** | 3 P0 confirmés + 8 P1 ouverts (P1-09 résolu pendant la revue) ; aucun ne demande de refonte |

### Note globale : **5,8 / 10**

Cette note dit ceci : **un très bon socle, une chaîne de garantie incomplète.**

Elle n'est pas basse par sévérité. Un produit de cette ampleur fonctionnelle, avec un
ledger qui tient sous concurrence, une RLS qui bloque cinq attaques réelles et une
architecture IA correctement gatée, mérite mieux qu'un 5,8 sur ses fondations. Ce qui la
tire vers le bas est concentré et réparable : trois défauts d'intégrité, une chaîne de CI
qui ne contrôle presque rien, et une observabilité absente.

Après WAVE 1 et WAVE 2, une réévaluation autour de **7,5** est réaliste — sans écrire une
seule fonctionnalité nouvelle.

---

## 20. Recommended Target Architecture

**Ne pas passer aux microservices.** Le domaine comptable est fortement transactionnel :
une écriture, ses lignes, son analytique et son audit doivent commiter ensemble. Une
architecture distribuée ajouterait des transactions distribuées à un problème que
PostgreSQL résout déjà correctement.

La cible est le **même monolithe modulaire, avec ses garanties remises à leur place**.

### Principe directeur

> Chaque invariant comptable est imposé au niveau le plus bas capable de le faire.
> La base est le juge ; l'application est l'ergonomie ; l'IA est la proposition.

Concrètement, pour chaque règle métier, trois couches — dans cet ordre :

1. **Base** — contrainte ou trigger. Non contournable, quel que soit le chemin d'écriture.
2. **Domaine** — même contrôle, pour produire un message utilisateur clair *avant* que la
   base ne rejette.
3. **IA** — validateur AQM déterministe, pour que Lexa ne propose pas ce qui sera rejeté.

La couche 1 manque pour quatre invariants. C'est tout le chantier d'intégrité.

### Évolutions structurantes

**Frontière tenant à deux verrous.** Ceinture : `FORCE ROW LEVEL SECURITY` partout,
`security_invoker` sur toute vue. Bretelles : garde au démarrage refusant un rôle base
propriétaire ou `BYPASSRLS` en production. Aucune des deux ne suffit seule ; ensemble
elles rendent l'accident impossible plutôt qu'improbable.

**Déploiement `migrate → verify → start`.** Migrations en tâche de déploiement, version de
schéma attendue en constante, refus de démarrer si l'écart existe, `/api/health` en 503
si une sonde échoue. Supprimer les `tableExists` qui dégradent silencieusement un
garde-fou comptable.

**Politique monétaire unique.** Une seule représentation des montants du bout en bout
(§ NOVA-P2-01), un seul point d'arrondi, aucune comparaison de montant en flottant.

**Découpage de `api.ts`.** Un `express.Router()` par domaine, à comportement strictement
identique. 273 routes partagent déjà le préfixe `/api/dossiers/:id` : le découpage est
mécanique.

**Ingestion asynchrone durable.** Les webhooks persistent avant d'accuser réception ;
un travailleur consomme la file avec idempotence sur l'identifiant fournisseur et une
file d'échec. Prérequis à toute mise à l'échelle horizontale, en même temps que la
sortie du limiteur de débit et de l'ordonnanceur hors du processus API.

**Observabilité minimale.** Journal structuré JSON, identifiant de corrélation par
requête propagé jusqu'au domaine, compteurs (écritures validées, appels Lexa par palier,
échecs de migration), alerte sur échec de sauvegarde et sur sonde de schéma en défaut.

---

## 21. Remediation Roadmap

Plan détaillé, avec fichiers, dépendances et parallélisation :
[`NOVA_REMEDIATION_PLAN_001.md`](./NOVA_REMEDIATION_PLAN_001.md).

| Vague | Objet | Effort | Feu |
|---|---|---|:--:|
| **WAVE 0** | Gel et référence : commiter le correctif 0077, figer Node, geler le schéma | 0,5 j | 🟢 |
| **WAVE 1** | Les 3 P0 : vue RLS, `FORCE` + garde de rôle, immuabilité INSERT | 2 j | 🔴 |
| **WAVE 2** | Sécurité et tenancy : téléversement, CSP, révocation de session | 2 j | 🟠 |
| **WAVE 3** | Intégrité comptable : `is_postable`, bornes, cohérence compte↔dossier, outil Lexa mal classé | 2,5 j | 🟠 |
| **WAVE 4** | CI et migrations : gate à 3 niveaux, assertions réelles, `migrate→verify→start` | 3 j | 🟢 |
| **WAVE 5** | Nettoyage : découpage `api.ts`, politique monétaire, dépendances | 5 j | 🟢 |
| **WAVE 6** | Durcissement pilote : observabilité, sauvegarde vérifiée, runbook, charge | 4 j | 🟢 |

**Chemin critique vers le pilote : WAVE 0 → 1 → 2 → 3 → 4**, soit environ **10 jours-homme**.
WAVE 5 et 6 peuvent suivre pendant le pilote, à l'exception de la **sauvegarde vérifiée**
et du **runbook**, à remonter en WAVE 4 : ce sont des prérequis d'exploitation, pas du confort.

---

## 22. Pilot Readiness Gate

Critères de sortie, vérifiables un par un.

| # | Critère | Aujourd'hui | Preuve exigée |
|:--:|---|:--:|---|
| 1 | Aucun P0 ouvert | ❌ 3 ouverts | Cette revue re-jouée, section P0 vide |
| 2 | Aucun P1 bloquant ouvert | ❌ 8 ouverts | P1-01 à P1-08 fermés (P1-09 déjà résolu) |
| 3 | Isolation tenant démontrée | ❌ | Test automatisé : cabinet A/B sur tables **et vues**, en Tier 1 |
| 4 | Impossible de démarrer sur un rôle base propriétaire | ❌ | Test d'intégration de la garde de démarrage |
| 5 | Invariants ledger prouvés en base | ❌ 4 manquants | Suite SQL bloquante : équilibre, immuabilité (INSERT compris), bornes, `is_postable`, compte↔dossier |
| 6 | États financiers articulés | ✅ | `test:etats` + `test:postes` en CI |
| 7 | Migrations fiables | ❌ | `migrate→verify→start`, refus de démarrer sur schéma incomplet |
| 8 | CI complète verte | ❌ 1/18 | Les 18 suites en Tier 1 ou Tier 2, vertes sur `main` |
| 9 | Frontières d'autorisation explicites | ⚠️ | Matrices RÔLE × ACTION et RÔLE × LEXA versionnées et testées |
| 10 | Correctif 0077 **appliqué en base de production** | ⚠️ commité (`9c5045b`), application en base non vérifiée | Vérification en production : `dossier_delete` refuse un appelant d'un autre cabinet |
| 11 | Sauvegarde restaurée avec succès | ❌ | Restauration datée sur environnement de test |
| 12 | Runbook incident | ❌ | Document : perte base, fuite tenant, échec de migration, révocation de jeton |
| 13 | Documentation alignée | ❌ 13 écarts | Tableau du § 18 vidé |

**Statut : 1 critère sur 13.**

Le seul critère aujourd'hui satisfait — l'articulation des états financiers — est
précisément celui qui demandait le plus d'expertise métier. C'est le bon signal :
**ce qui manque à Nova est de l'ingénierie de garantie, pas de la compétence comptable.**
La première s'ajoute en une dizaine de jours ; la seconde met des années à s'acquérir, et
elle est déjà là.

---

*Revue en lecture seule. Aucun fichier applicatif, migration ou configuration n'a été
modifié. Base de test isolée `nova-cto-audit` (Postgres 16, port 55999), détruite en fin
de revue. Toutes les sorties citées sont reproductibles depuis HEAD `a786be7`.*
