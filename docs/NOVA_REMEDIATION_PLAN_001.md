# Nova Comptabilité — Plan de remédiation nº 001

> Annexe de [`NOVA_CTO_ARCHITECTURE_REVIEW_001.md`](./NOVA_CTO_ARCHITECTURE_REVIEW_001.md).
> HEAD `9c5045b10634f81362bb3ff541365a241dc24bd9` · 9 septembre 2026.
> Ce plan **décrit** le travail à faire. Il n'a rien modifié : la revue était en lecture seule.

---

## Comment lire ce plan

Chaque lot indique :

- **Fichiers** concernés ;
- **Risque** de la correction elle-même (pas du défaut) ;
- **Dépendances** — ce qui doit être fait avant ;
- **Tests requis** — la preuve que la correction corrige ;
- **Parallèle** — peut-il être traité en même temps qu'un autre lot, par un autre agent ;
- **Feu** — 🟢 sans risque de régression · 🟠 vigilance · 🔴 touche un invariant, à valider
  sur base de test avant production.

**Règle qui vaut pour tous les lots** : chaque correction commence par un test qui
**échoue** sur le HEAD actuel. Sans cela, rien ne prouve que le correctif corrige.

**Estimation totale du chemin critique (WAVE 0 → 4) : ~10 jours-homme.**

---

## WAVE 0 — Gel et référence

*Aucune modification métier. Objectif : savoir exactement d'où l'on part.*

**Effort : 0,5 j · Feu : 🟢 · Parallèle : non (prérequis à tout)**

| Lot | Action | Fichiers |
|---|---|---|
| 0.1 | **Vérifier que la migration 0077 est appliquée en base de production.** Le correctif est commité (`9c5045b`) mais le mode best-effort (P1-08) ne garantit pas son application. Interroger `_migrations` en production. | — (exploitation) |
| 0.2 | Figer le runtime : ajouter `"engines": {"node": ">=22 <23"}` et un `.nvmrc`, aligner `ci.yml` sur Node 22 (version de l'image). | `package.json`, `.nvmrc`, `.github/workflows/ci.yml` |
| 0.3 | Renommer le paquet : `"name": "nova-comptabilite"`, version réelle. | `package.json` |
| 0.4 | Capturer le schéma de référence (`pg_dump --schema-only`) et le versionner comme empreinte de départ. | `docs/schema-baseline-0077.sql` |
| 0.5 | Retirer `out.txt` du suivi git. | `out.txt` |

**Tests requis** : `npm run typecheck` + les 18 suites vertes avant de commencer WAVE 1
(état de référence établi par cette revue : toutes vertes).

**Sortie de vague** : on sait que la production est à jour, et le runtime est le même
partout.

---

## WAVE 1 — Les trois P0

*Le seul objectif : refermer les trois défauts critiques. Rien d'autre dans ces commits.*

**Effort : 2 j · Feu : 🔴**

### Lot 1.1 — Fuite inter-tenant par la vue (**NOVA-P0-01**)

| | |
|---|---|
| **Fichiers** | nouvelle migration `…_0078_view_security_invoker.sql` |
| **Action** | `create or replace view v_account_balances with (security_invoker = true) as …` (PostgreSQL 15+ ; l'image et la CI sont en 16). Si une version antérieure doit être supportée : supprimer la vue et retirer son usage du smoke test — l'application ne s'en sert pas. |
| **Risque** | 🟢 très faible — la vue n'est utilisée par **aucun** code applicatif (recherche exhaustive : seul `supabase/tests/smoke_test.sql:108`). |
| **Dépendances** | aucune |
| **Parallèle** | ✅ oui — indépendant de 1.2 et 1.3 |
| **Tests requis** | SQL bloquant : contexte cabinet B → `select count(*) from v_account_balances` **doit** valoir 0, sinon `RAISE EXCEPTION`. Doit échouer avant le correctif. |
| **Vérification** | Rejouer : `via_la_VUE` doit passer de 102 à 0. |

**À faire en même temps** : ajouter une règle de revue — *toute nouvelle vue déclare
`security_invoker = true`*. C'est le genre de défaut qui revient.

### Lot 1.2 — `FORCE RLS` + garde du rôle de connexion (**NOVA-P0-02**)

Deux mesures indépendantes. **Faire 1.2.a en premier** : bénéfice immédiat, risque nul.

**1.2.a — Garde au démarrage (bretelles)** · Feu : 🟢

| | |
|---|---|
| **Fichiers** | `server/db.ts` (ou nouveau `server/dbguard.ts`), `server/index.ts` |
| **Action** | Sur le modèle exact d'`assertAuthConfig()` : au démarrage, interroger `pg_roles` pour le rôle courant. Si `rolsuper` ou `rolbypassrls`, ou si le rôle est propriétaire de `entries` → **refuser de démarrer en production**, avertir en développement. Message explicite (« la RLS ne s'appliquera pas : toute la plateforme verrait tous les cabinets »). |
| **Risque** | 🟢 faible — mais **vérifier d'abord** que la production ne tourne pas déjà en rôle propriétaire, sinon le déploiement échoue au boot. C'est justement l'information qu'on cherche : la vérifier **avant** de poser la garde. |
| **Dépendances** | lot 0.1 (connaître l'état de la production) |
| **Parallèle** | ✅ oui |
| **Tests requis** | Test d'intégration : connexion propriétaire → la garde lève ; connexion `nova_app` → démarrage normal. |

**1.2.b — `FORCE ROW LEVEL SECURITY` (ceinture)** · Feu : 🔴

| | |
|---|---|
| **Fichiers** | nouvelle migration `…_0079_force_rls.sql` |
| **Action** | `ALTER TABLE … FORCE ROW LEVEL SECURITY` sur les 57 tables à RLS. |
| **Risque** | 🔴 **élevé** — `FORCE` s'applique aussi au propriétaire. Tout ce qui tourne en propriétaire cesse de voir les données : migrations avec backfill, `dossier_delete`, jobs, `nightly_targets()`. Les fonctions `SECURITY DEFINER` sont concernées si leur propriétaire est le propriétaire des tables. |
| **Dépendances** | 1.2.a (savoir avec quel rôle tourne la production) ; stratégie de rôle de migration (WAVE 4, lot 4.3) |
| **Parallèle** | ❌ non — à faire seul, sur base de test d'abord |
| **Tests requis** | Les **18 suites** doivent rester vertes après application. Vérifier spécifiquement : `dossier_delete`, `reverse_entry`, `nightly_targets`, `onboard_cabinet`, et les migrations à backfill. |
| **Repli** | Si trop de casse : créer un rôle `nova_migrator` avec `BYPASSRLS` explicite, l'utiliser pour `MIGRATION_DATABASE_URL`, puis réappliquer `FORCE`. |

> **Recommandation** : livrer 1.2.a immédiatement, et traiter 1.2.b comme un chantier à
> part entière avec validation complète sur base de test. La garde de démarrage supprime
> déjà l'essentiel du risque réel.

### Lot 1.3 — Immuabilité des écritures validées (**NOVA-P0-03**)

| | |
|---|---|
| **Fichiers** | nouvelle migration `…_0080_immutabilite_insert.sql` |
| **Action** | 1. `create trigger trg_protect_lines before insert or update or delete on entry_lines …` — la fonction `protect_posted_lines()` fonctionne telle quelle sur INSERT (l'écriture parente existe déjà, elle lit `entries.status`). 2. Restreindre `protect_posted_entries()` à une **liste blanche** de colonnes mutables (`status`, `reversed_by_entry_id`) au lieu de la liste noire actuelle. |
| **Risque** | 🔴 — touche le chemin d'écriture principal. **Point de vigilance** : `reverse_entry()` insère ses lignes **avant** de passer l'extourne à `posted` (ordre vérifié dans la migration 0007) → non impacté. Même chose pour `postEntry()`, qui crée l'écriture en `draft`. |
| **Dépendances** | aucune |
| **Parallèle** | ✅ oui — indépendant de 1.1 et 1.2 |
| **Tests requis** | SQL bloquant : insérer une paire **équilibrée** dans une écriture `posted` **doit** lever. `update entries set piece_ref=… where status='posted'` **doit** lever. Les 18 suites doivent rester vertes — en particulier `test:reclassement` (67), qui exerce `redresser()` → `reverseEntry` + `postEntry`. |
| **Vérification** | Rejouer A5 : `lignes_apres` doit rester à `lignes_avant`. |

**Sortie de WAVE 1** : les trois attaques T2, T4 et A5 échouent. Section P0 vide.

---

## WAVE 2 — Sécurité et tenancy

**Effort : 2 j · Feu : 🟠 · Parallélisable en 3 pistes**

### Lot 2.1 — Téléversement de pièces (**NOVA-P1-04**) · 🟠

| | |
|---|---|
| **Fichiers** | `server/domain/documents.ts`, `server/api.ts` (route de restitution) |
| **Action** | (a) Liste blanche de types MIME à l'entrée — les 6 de la table `EXT`. (b) Vérifier les **octets d'en-tête** (magic bytes) plutôt que le champ déclaré. (c) `Content-Disposition: attachment` par défaut ; `inline` uniquement pour `image/*` et `application/pdf`. (d) Forcer `Content-Type: application/octet-stream` pour tout type hors liste. |
| **Risque** | 🟠 — un dossier existant peut contenir des pièces au MIME hors liste. Prévoir un inventaire avant, et servir l'existant en `attachment` plutôt que le refuser. |
| **Dépendances** | aucune |
| **Parallèle** | ✅ |
| **Tests requis** | Téléverser `text/html`, `image/svg+xml`, un PDF avec un MIME menteur → refus ou service inoffensif. Vérifier que le dépôt légitime (JPEG, PNG, PDF) fonctionne toujours, y compris par un rôle `client`. |

### Lot 2.2 — En-tête CSP (**NOVA-P2-06**) · 🟠

| | |
|---|---|
| **Fichiers** | `server/api.ts` (bloc d'en-têtes, ligne ~94) |
| **Action** | Ajouter `Content-Security-Policy`. Commencer en `Report-Only` pour mesurer, puis durcir. Le front est du React bundlé par Vite : viser `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`. |
| **Risque** | 🟠 — un CSP trop strict casse le front en silence. **Ne pas livrer sans avoir parcouru les 62 écrans**, en particulier ceux qui génèrent des PDF (`pdfkit`, `pdf-lib`), les graphiques (`recharts`) et la voix (`LexaVoice`). |
| **Dépendances** | aucune |
| **Parallèle** | ✅ |
| **Tests requis** | Parcours manuel complet + vérification console navigateur vide. |

### Lot 2.3 — Révocation de session (**NOVA-P2-02**) · 🟠

| | |
|---|---|
| **Fichiers** | migration (colonne `app_users.token_version`), `server/auth.ts`, `server/api.ts` (middleware), `server/domain/users.ts` |
| **Action** | (a) `token_version int not null default 0` sur `app_users`. (b) Inclure `tv` dans le JWT. (c) Le middleware compare `tv` à la valeur en base. (d) Incrémenter au changement de mot de passe, à la désactivation du compte, au retrait d'un membre. (e) Ramener le TTL à 24 h et ajouter un jeton de rafraîchissement. |
| **Risque** | 🟠 — un contrôle en base **à chaque requête** ajoute une lecture. Mettre en cache par processus avec une TTL courte (30 s) si la latence gêne. Le passage à 24 h déconnectera tout le monde une fois. |
| **Dépendances** | aucune |
| **Parallèle** | ✅ |
| **Tests requis** | Jeton émis → changement de mot de passe → le jeton doit être refusé. Membre retiré → accès refusé immédiatement. |

### Lot 2.4 — Durcissements d'authentification · 🟢

Étendre `limiteAuth` à `POST /api/auth/2fa/enable` et `POST /api/invitations/:token/accept`
(P2-04). Vérifier l'entropie du jeton d'invitation (migration 0060). Ajouter des codes de
secours MFA (aujourd'hui, 2FA perdue = compte perdu). Ajouter la réinitialisation de mot de
passe, **absente du produit**.

---

## WAVE 3 — Intégrité comptable

*Remettre les invariants là où ils sont annoncés : en base.*

**Effort : 2,5 j · Feu : 🟠**

### Lot 3.1 — Trigger de cohérence unifié (**P1-01, P1-02, P1-03**) · 🔴

Un seul trigger `before insert or update on entry_lines` + un complément sur `entries`
couvrent les trois défauts :

| Invariant | Vérification | Finding |
|---|---|---|
| Compte imputable | `accounts.is_postable = true` pour `new.account_id` | P1-01 |
| Compte du bon dossier | `accounts.dossier_id = new.dossier_id` | P1-03 |
| Ligne du bon dossier | `new.dossier_id = entries.dossier_id` | P1-03 |
| Date dans les bornes | dans `check_period_open()` : `entry_date between fy.start_date and fy.end_date` | P1-02 |

| | |
|---|---|
| **Fichiers** | nouvelle migration `…_0081_invariants_lignes.sql` ; `server/domain/accounting.ts` (message utilisateur clair pour `is_postable`, avant que la base ne rejette) |
| **Risque** | 🔴 — **des données existantes peuvent violer ces règles.** Ordre impératif : (1) requête d'inventaire sur la production, (2) redressement de l'existant, (3) seulement ensuite, pose du trigger. L'attaque A10 de cette revue a d'ailleurs créé une ligne non conforme dans la base de test. |
| **Dépendances** | lot 1.3 (même zone de code) |
| **Parallèle** | ❌ non — à faire après WAVE 1 |
| **Tests requis** | A6, A7, A10 doivent échouer. Les 18 suites vertes. **`test:reclassement` (67) et `test:exercices` (49) sont les plus exposés.** |
| **Point d'attention** | Prévoir une échappatoire explicite si la reprise de balance d'ouverture (`importbalance.ts`, `importledger.ts`) a besoin d'écrire sur des comptes non imputables — à vérifier avant de poser le trigger. |

### Lot 3.2 — Reclasser `reaffecter_exercice` (**P1-05**) · 🟢

| | |
|---|---|
| **Fichiers** | `server/ai/agent.ts` |
| **Action** | (a) Déplacer `reaffecter_exercice` de `DRAFT_TOOLS` vers `ACTION_TOOLS` → exige `assist_plus` **et** owner/associé. (b) Corriger `SYSTEM_GUARDRAILS` règle 1 et `ASSIST_NOTE`, qui affirment aujourd'hui à l'utilisateur que Lexa ne poste jamais — c'est faux au palier `assist_plus`. |
| **Risque** | 🟢 — restriction de capacité, pas d'extension. Un collaborateur perdra l'accès à cet outil : c'est l'intention. |
| **Dépendances** | aucune |
| **Parallèle** | ✅ |
| **Tests requis** | **Nouveau test de gating** : pour chaque outil, vérifier (mode, rôle) → autorisé/refusé, conformément à la matrice de `NOVA_SECURITY_BOUNDARY_MAP_001.md § 7`. Ce test n'existe pas aujourd'hui. |

### Lot 3.3 — Défenses anti-injection de prompt (**P2-07**) · 🟢

Ajouter à `SYSTEM_GUARDRAILS` une règle explicite de séparation donnée/instruction.
Encadrer les sorties d'outils et le contenu documentaire par des délimiteurs. Filtrer les
faits `memoriser` avant persistance (longueur, motifs impératifs) — c'est le seul vecteur
d'injection **persistante**. Exiger une confirmation hors-bande pour `envoyer_email` et
`relance_groupee`.

### Lot 3.4 — Corriger les affirmations fausses de la documentation (**P3-01**) · 🟢

À traiter **dans les mêmes commits** que les corrections, pas après :

| Fichier | Correction |
|---|---|
| `migration 0004` (en-tête) | Ne plus affirmer « ces règles vivent EN BASE » tant que WAVE 3 n'est pas livrée ; ensuite, ce sera vrai |
| `README.md:37` | « ledger immuable » — vrai après le lot 1.3 |
| `PLAN-MISE-EN-OEUVRE.md` | Marquer offline-first comme **non implémenté** (5 affirmations, cf. revue § 18) |
| `ci.yml` | Renommer l'étape tant que la RLS n'est pas réellement testée (lot 4.1) |
| `DEV-LOCAL.md` | 18 suites, pas 3 |
| `RESTE-A-FAIRE.md` | Reporter les findings de cette revue |

> Ces documents sont lus comme des spécifications par les agents (Claude Code, Codex).
> Une garantie fausse est plus dangereuse qu'une garantie absente : elle dispense de vérifier.

---

## WAVE 4 — CI et fiabilité des migrations

**Effort : 3 j · Feu : 🟢 (aucun changement fonctionnel)**

### Lot 4.1 — Assertions réelles dans le smoke test (**P1-07**) · 🟢

| | |
|---|---|
| **Fichiers** | `supabase/tests/smoke_test.sql` |
| **Action** | (a) Bloc 9 : remplacer l'affichage par `IF v_visible <> <attendu> THEN RAISE EXCEPTION`. (b) Bloc 8 : contrôler l'équilibre **par dossier**, depuis les tables de base, pas depuis la vue. (c) Ajouter : isolation de la vue (P0-01), rôle de connexion (P0-02), immuabilité INSERT (P0-03), les trois invariants du lot 3.1. |
| **Risque** | 🟢 |
| **Dépendances** | les corrections correspondantes, sinon la CI passe au rouge — **ce qui est le comportement souhaité** : écrire ces tests **avant** les correctifs, les voir échouer, puis corriger. |
| **Parallèle** | ✅ |

### Lot 4.2 — Quality gate à trois niveaux (**P1-06**) · 🟢

| | |
|---|---|
| **Fichiers** | `.github/workflows/ci.yml` (+ éventuellement `ci-nightly.yml`) |
| **Action** | Tier 1 / Tier 2 / Tier 3 tels que détaillés dans `NOVA_TEST_COVERAGE_MAP_001.md § 7`. |
| **Risque** | 🟢 — mais les 18 suites partagent une base : **prévoir une base ou un schéma par suite** pour éviter les interférences et permettre le parallélisme. |
| **Dépendances** | aucune |
| **Parallèle** | ✅ |
| **Effet mesuré** | contrôles par merge : 18 → ~450 ; capacités critiques protégées : 5/30 → 26/30. |

### Lot 4.3 — `migrate → verify → start` (**P1-08**) · 🟠

| | |
|---|---|
| **Fichiers** | `Dockerfile`, `server/index.ts`, `server/migrate-runtime.ts`, `scripts/migrate-boot.mjs`, `server/api.ts` (`/api/health`) |
| **Action** | (a) Sortir les migrations du processus API : tâche de déploiement dédiée. (b) Constante `SCHEMA_VERSION` côté serveur + ligne en base ; **refus de démarrer en production** si l'écart existe. (c) `/api/health` renvoie **503** si une sonde de schéma est fausse. (d) Retirer les `tableExists()` des chemins portant un garde-fou comptable — notamment `postEntry` qui saute aujourd'hui le contrôle de clôture mensuelle si `period_closures` manque. |
| **Risque** | 🟠 — inverse le comportement actuel : un schéma incomplet **empêchera** désormais le démarrage. C'est l'intention, mais cela peut bloquer un déploiement qui passait avant. Prévoir une procédure de déblocage documentée. |
| **Dépendances** | lot 1.2.b (rôle de migration) |
| **Parallèle** | ❌ non |
| **Tests requis** | Migration volontairement cassée → l'API refuse de démarrer, `/api/health` renvoie 503. |

### Lot 4.4 — Sauvegarde et runbook · 🟢 — **remonté depuis WAVE 6**

Ces deux points sont des **prérequis d'exploitation**, pas du confort :

- Sauvegarde quotidienne automatisée, **avec une restauration réellement testée** sur un
  environnement de test et datée. Une sauvegarde jamais restaurée n'est pas une sauvegarde.
- Runbook incident : perte de base, fuite inter-tenant, échec de migration, révocation de
  jeton, restauration point-in-time.

---

## WAVE 5 — Nettoyage d'architecture

*Aucun changement fonctionnel. Peut se dérouler pendant le pilote.*

**Effort : 5 j · Feu : 🟢**

| Lot | Action | Fichiers | Parallèle |
|---|---|---|:--:|
| 5.1 | Découper `api.ts` en `express.Router()` par domaine, à comportement **strictement identique**. 273 des 311 routes partagent déjà `/api/dossiers/:id` : le découpage est mécanique. (P2-09) | `server/api.ts` → `server/routes/*.ts` | ❌ (conflits) |
| 5.2 | **Politique monétaire** (P2-01) : retirer `setTypeParser(1700, Number)`, représentation entière de bout en bout, comparaisons d'équilibre en entier, un seul helper d'arrondi, sérialisation JSON en chaîne, contraintes `CHECK` de bornes. Cf. revue § P2-01. | `server/db.ts`, `server/domain/**`, `src/lib/api.ts` | ❌ |
| 5.3 | `npm audit fix` (P2-08) ; sortir `vite`/`@vitejs/plugin-react` des `dependencies` ; **build Docker multi-étapes**. | `package.json`, `Dockerfile` | ✅ |
| 5.4 | Erreurs HTTP (P2-05) : `500` par défaut, `400` sur validation explicite ; message générique au client, détail journalisé avec identifiant de corrélation. | `server/api.ts` (`h()`) | ✅ |
| 5.5 | Nettoyer les deux `SECURITY DEFINER` sans `search_path` dans leur définition initiale (P3-03). | migrations 0004, 0006 | ✅ |
| 5.6 | Découper `accounting.ts` (1 347 l.) et `agent.ts` (1 086 l.). | `server/domain/`, `server/ai/` | ⚠️ après 5.1 |

Le lot **5.2 est le plus lourd et le plus sensible** : il touche tous les montants du
produit. À traiter comme un chantier isolé, avec tests de propriété (Tier 3) écrits
**avant**.

---

## WAVE 6 — Durcissement pilote

**Effort : 4 j · Feu : 🟢**

| Lot | Action | Finding |
|---|---|---|
| 6.1 | Journal structuré JSON + identifiant de corrélation par requête, propagé jusqu'au domaine. | P3-02 |
| 6.2 | Métriques : écritures validées, appels Lexa par palier, échecs de migration, latence des états. Alertes sur échec de sauvegarde et sonde de schéma en défaut. | P3-02 |
| 6.3 | **Ingestion asynchrone durable** : persister le message webhook **avant** le 200, idempotence sur l'identifiant fournisseur, file d'échec. | P2-03 |
| 6.4 | Sortir le limiteur de débit et l'ordonnanceur nocturne du processus API (store partagé). Prérequis à toute mise à l'échelle horizontale. | P2-04 |
| 6.5 | Tests de charge : 10 000 écritures, génération des états, `EXPLAIN` sur les requêtes clés. | — |
| 6.6 | Tests d'authentification (JWT, TOTP, limiteur) — le module le plus sensible et le seul sans aucun test. | P3-05 |

---

## Récapitulatif : lots parallélisables

Plusieurs agents peuvent travailler simultanément **à l'intérieur** d'une vague, jamais
entre vagues (sauf mention).

| Vague | Piste A | Piste B | Piste C |
|---|---|---|---|
| **1** | 1.1 vue RLS | 1.2.a garde de rôle | 1.3 immuabilité INSERT |
| **2** | 2.1 téléversement | 2.2 CSP | 2.3 révocation · 2.4 auth |
| **3** | 3.1 invariants *(seul)* | 3.2 outil Lexa · 3.3 anti-injection | 3.4 documentation |
| **4** | 4.1 assertions · 4.2 gate | 4.3 migrate→verify *(seul)* | 4.4 sauvegarde · runbook |
| **5** | 5.1 puis 5.6 *(seuls)* | 5.2 monnaie *(seul)* | 5.3 · 5.4 · 5.5 |
| **6** | 6.1 · 6.2 | 6.3 · 6.4 | 6.5 · 6.6 |

**Lots à traiter seuls** (conflits ou risque d'invariant) : 1.2.b, 3.1, 4.3, 5.1, 5.2, 5.6.

---

## Traçabilité finding → lot

| Finding | Sévérité | Lot | Vague |
|---|:--:|---|:--:|
| NOVA-P0-01 vue `v_account_balances` | P0 | 1.1 | 1 |
| NOVA-P0-02 pas de `FORCE RLS`, pas de garde de rôle | P0 | 1.2.a + 1.2.b | 1 |
| NOVA-P0-03 immuabilité — INSERT non couvert | P0 | 1.3 | 1 |
| NOVA-P1-01 `is_postable` non imposé | P1 | 3.1 | 3 |
| NOVA-P1-02 bornes d'exercice hors base | P1 | 3.1 | 3 |
| NOVA-P1-03 compte d'un autre dossier | P1 | 3.1 | 3 |
| NOVA-P1-04 XSS stocké par téléversement | P1 | 2.1 (+ 2.2) | 2 |
| NOVA-P1-05 `reaffecter_exercice` mal classé | P1 | 3.2 | 3 |
| NOVA-P1-06 CI : 1 suite sur 18 | P1 | 4.2 | 4 |
| NOVA-P1-07 test RLS sans assertion | P1 | 4.1 | 4 |
| NOVA-P1-08 migrations best-effort | P1 | 4.3 | 4 |
| NOVA-P1-09 correctif non commité | ~~P1~~ | **RÉSOLU** (`9c5045b`) — reste 0.1 | 0 |
| NOVA-P2-01 politique monétaire | P2 | 5.2 | 5 |
| NOVA-P2-02 jetons non révocables | P2 | 2.3 | 2 |
| NOVA-P2-03 webhooks sans reprise | P2 | 6.3 | 6 |
| NOVA-P2-04 limiteur en mémoire | P2 | 2.4 + 6.4 | 2 / 6 |
| NOVA-P2-05 erreurs en 400 | P2 | 5.4 | 5 |
| NOVA-P2-06 pas de CSP | P2 | 2.2 | 2 |
| NOVA-P2-07 injection de prompt | P2 | 3.3 | 3 |
| NOVA-P2-08 dépendances vulnérables | P2 | 5.3 | 5 |
| NOVA-P2-09 `api.ts` monolithique | P2 | 5.1 | 5 |
| NOVA-P2-10 versions de Node · nom du paquet | P2 | 0.2 + 0.3 | 0 |
| NOVA-P3-01 documentation offline-first | P3 | 3.4 | 3 |
| NOVA-P3-02 observabilité | P3 | 6.1 + 6.2 | 6 |
| NOVA-P3-03 `search_path` initial | P3 | 5.5 | 5 |
| NOVA-P3-04 numérotation des migrations | P3 | à cadrer | 5 |
| NOVA-P3-05 aucun test d'authentification | P3 | 6.6 | 6 |
| NOVA-P3-06 `out.txt` suivi | P3 | 0.5 | 0 |

---

## Critère de sortie

À la fin de WAVE 4, rejouer cette revue à l'identique. Le pilote peut s'ouvrir quand les
**13 critères** du gate (`NOVA_CTO_ARCHITECTURE_REVIEW_001.md § 22`) sont satisfaits — et
en particulier quand les huit attaques qui ont réussi pendant cette revue (T2, T3, T4, A5,
A6, A7, A10, et la non-assertion du bloc 9) échouent toutes.
