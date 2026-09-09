# Nova Comptabilité — Carte des frontières de sécurité nº 001

> Annexe de [`NOVA_CTO_ARCHITECTURE_REVIEW_001.md`](./NOVA_CTO_ARCHITECTURE_REVIEW_001.md).
> HEAD `9c5045b10634f81362bb3ff541365a241dc24bd9` · 9 septembre 2026 · lecture seule.
> Modèle : `Route → Auth → Rôle → Tenant → RLS → Action`.

---

## 1. Les cinq portes

Toute requête franchit au plus cinq contrôles. Savoir lesquels s'appliquent à une route
donnée, c'est savoir ce qui la protège.

| # | Porte | Où | Ce qu'elle vérifie | Défaut si absente |
|:--:|---|---|---|---|
| **1** | **AUTH** | `api.ts:127` | Signature JWT HS256 + expiration → `req.userId` | `requireUser` lève 401 |
| **2** | **PORTAIL** | `api.ts:158` | Sur `/api/dossiers/:id` non-GET : rôle restreint (`client`/`lecture`) → liste blanche | 403 `CLIENT_FORBIDDEN` |
| **3** | **TENANT** | `db.ts:28` | `set_config('app.current_user_id', …, LOCAL)` dans la transaction | RLS renvoie 0 ligne (fail-closed) |
| **4** | **RLS** | 57 tables | `dossier_id in (select app_dossier_ids())` en USING **et** WITH CHECK | rien n'est lisible ni écrivable |
| **5** | **RÔLE SQL** | 49 fonctions `SECURITY DEFINER` | `v_caller is null or v_caller not in ('owner','associe')` | `raise exception` |

**Faille structurelle du modèle** : la porte 4 ne s'applique **pas** au propriétaire des
tables, car aucune table n'a `FORCE ROW LEVEL SECURITY`, et rien ne vérifie au démarrage
que la connexion n'est pas propriétaire → **NOVA-P0-02**. La porte 4 est également
contournée par la vue `v_account_balances` → **NOVA-P0-01**.

---

## 2. Routes sans authentification (6)

| Méthode | Route | Protection réelle | Verdict |
|---|---|---|---|
| GET | `/api/health` | aucune | ✅ légitime — expose état DB, fournisseurs, commit, 6 sondes de schéma. Aucune donnée client. ⚠️ renvoie `ok:true` même si le schéma est incomplet (**P1-08**) |
| POST | `/api/auth/register` | `limiteAuth` (10/15 min) | ✅ légitime |
| POST | `/api/auth/login` | `limiteAuth` + message d'erreur unique | ✅ légitime — pas d'énumération de comptes |
| GET | `/api/invitations/:token` | jeton opaque en base | ✅ légitime — lecture d'une invitation par son secret |
| POST | `/api/invitations/:token/accept` | jeton opaque en base | ⚠️ **non couvert par `limiteAuth`** — un jeton pourrait être forcé par essais. Vérifier l'entropie du jeton (migration 0060) |
| GET | `*` | — | ✅ catch-all SPA (sert `dist/`) |

## 3. Routes à secret partagé (3)

| Méthode | Route | Vérification | Verdict |
|---|---|---|---|
| POST | `/api/cron/watchdog` | `x-cron-secret` == `CRON_SECRET` | ✅ **fail-closed** : refuse si `CRON_SECRET` n'est pas défini (`!secret || …`) — le bon réflexe |
| GET | `/api/whatsapp/webhook` | `hub.verify_token` | ✅ vérification d'abonnement Meta |
| POST | `/api/whatsapp/webhook` | HMAC `x-hub-signature-256` sur le **corps brut** | ✅ signature correcte · ⚠️ 200 puis traitement async (**P2-03**) |
| POST | `/api/telegram/webhook` | `x-telegram-bot-api-secret-token` | ✅ · ⚠️ idem (**P2-03**) |

Les deux webhooks établissent le tenant via la table de liaison
(`resolvePhone` / `resolveChat` → `{userId, dossierId}`) puis `withUser(link.userId, …)`.
**Le périmètre n'est jamais dérivé du contenu du message.**

---

## 4. Routes authentifiées hors périmètre dossier (13)

Ces routes ne passent **pas** par le middleware portail (porte 2). Leur autorisation
repose entièrement sur la porte 5 (fonction SQL) ou la porte 4 (RLS).

| Méthode | Route | Rôle exigé | Où le contrôle vit | Testé |
|---|---|---|---|:--:|
| PATCH | `/api/cabinets/:cid` | owner/associé | `cabinet_rename()`, `setCabinetAccountType()` | ✅ R3 |
| GET | `/api/cabinets/:cid/members` | membre | `cabinet_members_list()` — `raise 'Accès refusé à ce cabinet'` | ✅ R1 |
| POST | `/api/cabinets/:cid/members` | owner/associé | `cabinet_member_add()` | ✅ R2 |
| PATCH | `/api/cabinets/:cid/members/:uid` | owner/associé | `cabinet_member_set_role()` | ⚠️ non testé |
| DELETE | `/api/cabinets/:cid/members/:uid` | owner/associé | `cabinet_member_remove()` | ⚠️ non testé |
| GET/PUT | `/api/cabinets/:cid/members/:uid/access` | owner/associé | migration 0063 | ⚠️ non testé |
| POST/GET | `/api/cabinets/:cid/invitations` | owner/associé | `invitations.ts:33` (rôle lu explicitement) | ⚠️ non testé |
| DELETE | `/api/cabinets/:cid/invitations/:iid` | owner/associé | idem | ⚠️ non testé |
| **POST** | **`/api/entries/:id/reverse`** | accès au dossier de l'écriture | **garde interne de `reverse_entry()`** (migration 0007) | ✅ R4 |
| POST | `/api/onboarding/cabinet` | authentifié | `onboard_cabinet()` — l'appelant devient owner | ✅ implicite |
| GET | `/api/cabinets`, `/api/dossiers`, `/api/dashboard`, `/api/usage` | authentifié | RLS | ✅ T1 |
| GET | `/api/platform/overview` | **platform admin** | `app_is_platform_admin()` | ⚠️ non testé |
| POST | `/api/demo/seed` | authentifié | crée dans `listCabinets(c)[0]` — borné par RLS | ✅ borné |

`POST /api/entries/:id/reverse` est la route la plus sensible de cette liste : elle prend
un identifiant d'écriture **arbitraire** et appelle une fonction `SECURITY DEFINER` (qui
contourne la RLS par nature). Elle est protégée parce que la migration 0007 a **ajouté une
garde de périmètre explicite** dans la fonction. Vérifié — attaque R4 bloquée.

> Nuance à connaître : la garde s'écrit `if app_current_user_id() is not null and not exists(...)`.
> Un appel via `withUser(null, …)` — donc sans identité — **ne déclenche pas** le contrôle.
> C'est voulu (jobs, migrations), mais tout futur chemin appelant `reverse_entry` hors
> contexte utilisateur perdrait la protection.

---

## 5. Les 273 routes `/api/dossiers/:id/**`

Toutes franchissent les portes 1 → 2 → 3 → 4.

### Porte 2 — garde du portail client (`api.ts:156-171`)

```js
const clientCanWrite = (method, subPath) =>
  method === 'POST' && subPath === '/documents';

app.use('/api/dossiers/:id', (req, res, next) => {
  if (!req.userId) return next();                    // requireUser renverra 401
  if (req.method === 'GET' || req.method === 'HEAD') return next();  // borné par RLS
  withUser(req.userId, c => portal.myDossierRole(c, req.params.id))
    .then(role => {
      if (portal.isRestricted(role) && !clientCanWrite(req.method, req.path))
        return res.status(403).json({ code: 'CLIENT_FORBIDDEN' });
      next();
    }).catch(next);
});
```

**Liste blanche, refus par défaut** — la bonne polarité. Le rôle est recalculé en base
(`dossier_role_for()`) à chaque requête, pas lu depuis le jeton.

| Rôle effectif | GET | POST /documents | Toute autre écriture |
|---|:--:|:--:|:--:|
| `owner` / `associe` / `collaborateur` (membre du cabinet) | ✅ | ✅ | ✅ |
| `client` / `lecture` (accès direct au dossier) | ✅ | ✅ | ❌ 403 |
| non rattaché | ✅ *(RLS → 0 ligne)* | ✅ *(RLS refuse)* | ❌ 403 ou RLS |

⚠️ Le seul point d'écriture ouvert aux rôles restreints — `POST /documents` — est
précisément celui qui ne valide pas le type MIME (**NOVA-P1-04**). Un client externe peut
donc déposer un fichier servi ensuite en `inline` avec un `Content-Type` qu'il contrôle.

### Répartition des 273 routes

| Famille | Routes | Mutation | Transaction | Audité |
|---|---:|:--:|:--:|:--:|
| Écritures / balance / grand livre / journaux | ~40 | oui | ✅ `withUser` | ✅ |
| Plan comptable, exercices, clôtures | ~20 | oui | ✅ | ✅ |
| Facturation, devis, avoirs, récurrences, catalogue | ~35 | oui | ✅ | partiel |
| Achats, tiers, relances | ~25 | oui | ✅ | partiel |
| Banque, Mobile Money, lettrage, rapprochement | ~20 | oui | ✅ | partiel |
| Immobilisations, en-cours | ~15 | oui | ✅ | ✅ |
| Paie & RH, congés, pointage, déclarations | ~30 | oui | ✅ | ✅ |
| Analytique, axes, sections | ~15 | oui | ✅ | partiel |
| États, notes, ratios, révision, contrôles, AQM | ~30 | non | ✅ | n/a |
| Budget, prévisionnel, scoring, financement | ~15 | oui | ✅ | partiel |
| Documents, capture IA | ~10 | oui | ✅ | partiel |
| Lexa (assistant, mémoire, voix, décisions, veille) | ~15 | oui | ✅ | ✅ |
| WhatsApp / Telegram (liaison) | ~8 | oui | ✅ | partiel |

**Toutes** les routes passent par `withUser`, donc toutes ouvrent une transaction avec
identité — vérifié : `api.ts` ne contient aucune requête SQL directe et aucun accès `pool`
hors `/api/health`.

---

## 6. Matrice RÔLE × ACTION (actions sensibles)

`PA` = platform admin · `O` = owner · `A` = associé · `C` = collaborateur ·
`Cl` = client/lecture (portail)

| Action sensible | PA | O | A | C | Cl | Contrôle |
|---|:--:|:--:|:--:|:--:|:--:|---|
| Créer un cabinet | ✅ | ✅ | ✅ | ✅ | ✅ | `onboard_cabinet()` — devient owner |
| Renommer un cabinet | ✅ | ✅ | ✅ | ❌ | ❌ | `cabinet_rename()` |
| Changer le type de compte | ✅ | ✅ | ✅ | ❌ | ❌ | `set_cabinet_account_type()` |
| Lister les membres | ✅ | ✅ | ✅ | ✅ | ❌ | `cabinet_members_list()` |
| Ajouter / retirer un membre | ✅ | ✅ | ✅ | ❌ | ❌ | `cabinet_member_add/remove()` |
| Changer le rôle d'un membre | ✅ | ✅ | ✅ | ❌ | ❌ | `cabinet_member_set_role()` |
| Créer un dossier | — | ✅ | ✅ | ✅ | ❌ | RLS `dossiers_write` |
| **Supprimer un dossier** | ✅ | ✅ | ✅ | ❌ | ❌ | `dossier_delete()` — **corrigé par 0077** |
| Donner un accès client | — | ✅ | ✅ | ✅ | ❌ | `dossier_client_grant()` |
| Changer le mode agent Lexa | — | ✅ | ✅ | ❌ | ❌ | `dossier_set_agent_mode()` + `dossier_is_admin()` |
| Saisir / valider une écriture | — | ✅ | ✅ | ✅ | ❌ | porte 2 + RLS |
| Contre-passer une écriture | — | ✅ | ✅ | ✅ | ❌ | garde de `reverse_entry()` |
| Clôturer un exercice / un mois | — | ✅ | ✅ | ✅ | ❌ | porte 2 + RLS |
| Déposer une pièce | — | ✅ | ✅ | ✅ | **✅** | `clientCanWrite` |
| Consulter les états | — | ✅ | ✅ | ✅ | ✅ | RLS |
| Console plateforme | ✅ | ❌ | ❌ | ❌ | ❌ | `app_is_platform_admin()` |

**Observation** : la granularité s'arrête au niveau cabinet. Un `collaborateur` a les mêmes
droits comptables qu'un `owner` sur tous les dossiers du cabinet (saisir, valider,
contre-passer, clôturer). Pour un cabinet de plusieurs personnes avec des juniors, c'est
un grain grossier. La table `member_dossier_access` (migration 0063) permet de restreindre
le **périmètre de dossiers** d'un membre, mais pas ses **capacités** à l'intérieur.
À arbitrer produit — ce n'est pas un défaut, c'est une limite de conception à connaître.

---

## 7. Matrice RÔLE × ACTION LEXA

Double gating : **mode du dossier** (`dossiers.agent_mode`) **et** **rôle de la personne**
(`cabinet_members.role`). Vérifié deux fois : au filtrage des outils (`agent.ts:1017`) et
au dispatch (`agent.ts:553-570`).

| Outil / capacité | Palier requis | Rôle requis | Écrit au grand livre ? | Réversible |
|---|---|---|:--:|:--:|
| **56 outils de lecture** | `readonly` | tout membre | non | n/a |
| `preparer_facture_vente` | `assist` | tout membre | non (brouillon) | ✅ |
| `preparer_facture_achat` | `assist` | tout membre | non (brouillon) | ✅ |
| `preparer_reclassement` | `assist` | tout membre | non (brouillon) | ✅ |
| **`reaffecter_exercice`** | **`assist`** ⚠️ | **tout membre** ⚠️ | **OUI — extourne validée** | ❌ **non** |
| `lettrer_automatiquement` | `assist_plus` | tout membre | non | ✅ délettrable |
| `preparer_relance_client` | `assist_plus` | tout membre | non | ✅ |
| `comptabiliser_dotations_dues` | `assist_plus` | **owner/associé** | **OUI** (681→28x) | ❌ |
| `comptabiliser_tva` | `assist_plus` | **owner/associé** | **OUI** (liquidation) | ❌ |
| `generer_recurrences` | `assist_plus` | **owner/associé** | oui | ❌ |
| `generer_factures_recurrentes` | `assist_plus` | **owner/associé** | oui | ❌ |
| `preparer_livre_paie` | `assist_plus` | **owner/associé** | non (bulletins brouillons) | ✅ |
| `distribuer_bulletins` | `assist_plus` | **owner/associé** | non (envoi) | ❌ |
| `envoyer_email` | `assist_plus` | **owner/associé** | non (envoi) | ❌ |
| `envoyer_relance_client` | `assist_plus` | **owner/associé** | non (envoi) | ❌ |
| `relance_groupee` | `assist_plus` | **owner/associé** | non (envoi de masse) | ❌ |
| `memoriser` | `readonly` | tout membre | non | ✅ *(mais persistant — **P2-07**)* |
| Émettre une facture, clôturer, valider un brouillon | **jamais** | — | — | 100 % humain |

**La seule incohérence** : `reaffecter_exercice` est la seule ligne du tableau qui écrit au
grand livre de façon irréversible sans exiger `assist_plus` **ni** le rôle administrateur
→ **NOVA-P1-05**.

### Ce que le périmètre IA ne permet jamais

| Tentative | Barrière |
|---|---|
| Lire un autre dossier | `dossierId` fixé par la route / la table de liaison, jamais paramétrable par le modèle |
| Poster une écriture libre | `postEntry` n'est pas exposé comme outil ; aucun outil ne prend des lignes arbitraires à comptabiliser |
| Produire une écriture déséquilibrée | trigger base — la porte 4 ne dépend pas de l'IA |
| Écrire dans un exercice clos | `check_period_open` |
| Dépasser son palier via WhatsApp/Telegram | `executeTool()` revérifie (les canaux ne passent pas par le middleware HTTP) |
| Contourner un rôle par prompt | rôle relu en base à chaque appel (`callerCabinetRole`), jamais depuis le contexte |

---

## 8. Résultats des attaques menées

Toutes exécutées avec le rôle applicatif réel `nova_app`, sur deux tenants complets
(Cabinet A / Dossier A, Cabinet B / Dossier B).

### 8.1 Isolation inter-cabinet — 6 tentatives, 6 blocages

| # | Attaque (Bob, cabinet B → cabinet A) | Résultat | Barrière |
|:--:|---|---|---|
| T1 | Lire `entries` / `entry_lines` de A | ✅ **0 ligne** | RLS |
| R1 | `cabinet_members_list(cabinet_A)` | ✅ `Accès refusé à ce cabinet` | fonction SQL |
| R2 | `cabinet_member_add(cabinet_A, 'b@b.com', 'owner')` | ✅ `Réservé aux administrateurs du cabinet` | fonction SQL |
| R3 | `cabinet_rename(cabinet_A, 'PIRATE')` | ✅ `Réservé aux administrateurs du cabinet` | fonction SQL |
| R4 | `reverse_entry(ecriture_de_A)` | ✅ `Accès refusé au dossier de l'écriture` | garde 0007 |
| R5 | `insert into dossier_access(dossier_A, bob, 'client')` | ✅ `violates row-level security policy` | RLS WITH CHECK |

### 8.2 Contournements réussis — 2

| # | Attaque | Résultat | Finding |
|:--:|---|---|---|
| T2 | Lire les soldes de A via `v_account_balances` | ❌ **FUITE** — 102 lignes, 148 958 793 XOF tous tenants | **P0-01** |
| T3 | Lire la vue **sans aucun contexte utilisateur** | ❌ **FUITE** — la garantie fail-closed ne tient pas pour la vue | **P0-01** |
| T4 | Même code, connexion en **rôle propriétaire** | ❌ **EFFONDREMENT TOTAL** — `SECRET-A-CONFIDENTIEL` lu par Bob | **P0-02** |

### 8.3 Intégrité comptable — 10 tentatives

| # | Attaque | Attendu | Obtenu |
|:--:|---|---|---|
| A1 | Valider une écriture déséquilibrée (D=100 / C=50) | rejet | ✅ rejet |
| A2 | Ajouter une ligne **déséquilibrante** à une écriture validée | rejet | ✅ rejet *(par le trigger d'équilibre, pas par l'immuabilité)* |
| A3 | Supprimer une écriture validée | rejet | ✅ rejet |
| A4 | Modifier le montant d'une ligne validée | rejet | ✅ rejet |
| **A5** | **Ajouter une paire ÉQUILIBRÉE à une écriture validée** | **rejet** | ❌ **ACCEPTÉ** — 777 777 → 1 277 777 · **P0-03** |
| **A6** | Écriture datée 2019 dans l'exercice 2026 | rejet en base | ❌ **ACCEPTÉ** en base *(bloqué par `postEntry`)* · **P1-02** |
| **A7** | Écriture directe sur compte de tête `401` (`is_postable=false`) | rejet | ❌ **ACCEPTÉ** · **P1-01** |
| A8 | Ligne du dossier A sur un compte du cabinet **B** | rejet | ✅ rejet *(indirect : RLS masque le compte)* |
| A9 | `entry_lines.dossier_id` ≠ `entries.dossier_id` (inter-cabinet) | rejet | ✅ rejet *(RLS WITH CHECK)* |
| **A10** | Ligne du dossier A sur un compte du dossier A2 — **même cabinet** | rejet | ❌ **ACCEPTÉ et validé** · **P1-03** |

### 8.4 Concurrence

25 validations d'écritures simultanées via 25 connexions : **25 réussites, 0 erreur,
0 écriture déséquilibrée en base**. Contrôle global après l'ensemble des tests :

```
Écritures posted déséquilibrées en base      : 0
Lignes dont dossier_id ≠ celui de l'écriture : 0
Lignes pointant un compte d'un AUTRE dossier : 0   (avant l'attaque A10)
```

---

## 9. Surface d'authentification

| Vecteur | État | Détail |
|---|:--:|---|
| Force brute mot de passe | ⚠️ | `limiteAuth` 10/15 min · en mémoire, par IP+email (**P2-04**) |
| Énumération de comptes | ✅ | message unique « Identifiants invalides » |
| Confusion d'algorithme JWT | ✅ | l'en-tête n'est **jamais** lu ; HMAC-SHA256 imposé |
| `alg: none` | ✅ | idem |
| Falsification de signature | ✅ | `timingSafeEqual`, longueur vérifiée d'abord |
| Secret faible en production | ✅ | `assertAuthConfig()` **refuse le démarrage** |
| Rejeu de jeton expiré | ✅ | `exp` vérifié |
| Jeton volé / révocation | ❌ | aucune (**P2-02**) — 7 jours |
| Changement de mot de passe | ❌ | n'invalide pas les sessions |
| Compte désactivé | ❌ | garde l'accès jusqu'à expiration |
| Force brute TOTP | ⚠️ | `2fa/enable` non couvert par `limiteAuth` |
| Récupération MFA | ❌ | aucun code de secours |
| Vol de jeton par XSS | ❌ | `localStorage` + XSS stocké possible (**P1-04**) + pas de CSP (**P2-06**) |
| Réinitialisation de mot de passe | — | **fonctionnalité absente** du produit |

---

## 10. Synthèse des frontières

### Solide

- Frontière tenant sur les **tables** : uniforme, testée, fail-closed.
- Frontière de rôle : portée par des fonctions SQL, pas par l'applicatif — donc valable
  quel que soit l'appelant (API, Lexa, WhatsApp, job).
- Frontière IA : double gating mode + rôle, revérifié au dispatch.
- `reverse_entry` : la seule fonction `SECURITY DEFINER` prenant un identifiant arbitraire
  a reçu une garde de périmètre explicite.

### À réparer

| Priorité | Frontière | Finding |
|---|---|---|
| 1 | La RLS ne s'applique pas aux **vues** | P0-01 |
| 2 | La RLS ne s'applique pas au **propriétaire**, et rien ne le vérifie | P0-02 |
| 3 | L'immuabilité ne couvre pas l'**INSERT** | P0-03 |
| 4 | Le seul point d'écriture ouvert au portail client ne valide pas le **type de fichier** | P1-04 |
| 5 | Un outil IA écrivant au grand livre est classé « brouillon » | P1-05 |
| 6 | Le test de RLS en CI **n'assertionne rien** | P1-07 |
