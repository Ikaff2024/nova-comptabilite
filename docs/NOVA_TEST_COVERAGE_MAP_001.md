# Nova Comptabilité — Carte de couverture de tests nº 001

> Annexe de [`NOVA_CTO_ARCHITECTURE_REVIEW_001.md`](./NOVA_CTO_ARCHITECTURE_REVIEW_001.md).
> HEAD `9c5045b10634f81362bb3ff541365a241dc24bd9` · 9 septembre 2026 · lecture seule.
> Toutes les suites ont été **exécutées** pendant la revue, sur une base Postgres 16
> neuve reconstruite depuis les 77 migrations. Les nombres viennent des sorties réelles.

---

## 1. Le chiffre qui compte

| | |
|---|---|
| Suites `test:*` déclarées dans `package.json` | **18** |
| Suites exécutées par `.github/workflows/ci.yml` | **1** |
| Contrôles automatisés au total | **≈ 439** |
| Contrôles couverts par un merge vert | **10** + 8 contrôles SQL |
| **Part de la couverture qui ne tourne jamais automatiquement** | **≈ 98 %** |

---

## 2. Inventaire des suites

Toutes exécutées avec `DATABASE_URL` pointant sur la base d'audit. **Toutes passent.**

| Suite | Domaine | DB | Niveau | CI actuelle | Critique production |
|---|---|:--:|---|:--:|:--:|
| `test:domain` | ledger, RLS, parcours de base — **10 checks** | ✅ | intégration | ✅ **oui** | 🔴 haute |
| `test:exercices` | exercices, clôture, à-nouveaux, encours — **49** | ✅ | intégration | ❌ | 🔴 **très haute** |
| `test:payroll` | moteur de paie CI-2024.2 — **78/78** | ❌ | unitaire + golden | ❌ | 🔴 **très haute** |
| `test:reclassement` | reclassements, redressement d'exercice — **67** | ✅ | intégration | ❌ | 🔴 haute |
| `test:axes` | axes analytiques multi-dimensions — **34** | ✅ | intégration | ❌ | 🟠 moyenne |
| `test:assistant-analytique` | assistant analytique — **34** | ✅ | intégration | ❌ | 🟠 moyenne |
| `test:paie-variable` | éléments variables de paie — **25** | ✅ | intégration | ❌ | 🔴 haute |
| `test:notes` | notes annexes DSF — **24** | ✅ | intégration | ❌ | 🔴 haute |
| `test:pnl` | résultat mensualisé — **23** | ✅ | intégration | ❌ | 🟠 moyenne |
| `test:production-immo` | production immobilisée, en-cours — **23** | ✅ | intégration | ❌ | 🟠 moyenne |
| `test:veille` | veille nocturne, digest — **19** | ✅ | intégration | ❌ | 🟡 faible |
| `test:capture` | fournisseur IA, ancrage plan comptable — **15** | ❌ | unitaire | ❌ | 🟠 moyenne |
| `test:bornes` | bornes de dates, hors-exercice — **14** | ✅ | intégration | ❌ | 🔴 **très haute** |
| `test:controles` | contrôles de révision — **11** | ✅ | intégration | ❌ | 🟠 moyenne |
| `test:coherence` | cohérence inter-modules — **9** | ✅ | intégration | ❌ | 🟠 moyenne |
| **`test:securite`** | **autorisation `dossier_delete`** — **4** | ✅ | intégration | ❌ | 🔴 **très haute** |
| `test:etats` | états officiels, équilibre + recoupement | ✅ | intégration | ❌ | 🔴 **très haute** |
| `test:postes` | couverture des postes du bilan / résultat | ❌ | unitaire | ❌ | 🔴 haute |
| `smoke_test.sql` | ledger, immuabilité, « RLS » — 8 blocs | ✅ | SQL | ✅ **oui** | 🔴 haute |

Sorties d'exécution (extraits) :

```
domain                 rc=0 | 10 checks PASS — tout vert ✅
exercices              rc=0 | 49 PASS / 0 FAIL
postes                 rc=0 |   COMPTE DE RESULTAT — couverture complète du plan ✅
etats                  rc=0 |   cas complet — équilibre, résultat recoupé, marge exacte ✅
bornes                 rc=0 | 14 PASS / 0 FAIL
coherence              rc=0 | 9 PASS / 0 FAIL
notes                  rc=0 | 24 PASS / 0 FAIL
controles              rc=0 | 11 PASS / 0 FAIL
pnl                    rc=0 | 23 PASS / 0 FAIL
axes                   rc=0 | 34 PASS / 0 FAIL
production-immo        rc=0 | 23 PASS / 0 FAIL
reclassement           rc=0 | 67 PASS / 0 FAIL
veille                 rc=0 | 19 PASS / 0 FAIL
paie-variable          rc=0 | 25 PASS / 0 FAIL
capture                rc=0 | 15 PASS / 0 FAIL
securite               rc=0 | 4 PASS / 0 FAIL
assistant-analytique   rc=0 | 34 PASS / 0 FAIL
payroll                rc=0 | ✓ SUCCÈS — 78/78 test(s) au vert.
```

---

## 3. Ce que la CI exécute réellement

`.github/workflows/ci.yml`, dans l'ordre :

| Étape | Ce qu'elle prouve | Ce qu'elle ne prouve pas |
|---|---|---|
| `npm ci` | dépendances installables | pas d'audit de vulnérabilités |
| `npm run typecheck` | ✅ front **et** serveur compilent (vérifié : **propre**) | rien sur le comportement |
| Application des 77 migrations | ✅ le schéma se construit à neuf (**0 échec**) | pas l'idempotence, pas le chemin de mise à niveau depuis une base existante |
| `smoke_test.sql` | 8 blocs — voir § 4 | la RLS (le bloc 9 n'assertionne rien) |
| `npm run test:domain` | 10 contrôles de domaine | les 429 autres |

**Non testé en CI par le runtime lui-même** : la CI utilise **Node 20**, l'image Docker de
production **Node 22**, le poste local **Node 24**. Le runtime de production n'est validé
nulle part.

---

## 4. Analyse du smoke test SQL

| Bloc | Assertion | Verdict |
|:--:|---|---|
| 1 | tenancy créée | ✅ réelle |
| 2 | plan instancié (n comptes) | ✅ réelle |
| 3 | écriture équilibrée validée | ✅ réelle |
| 4 | déséquilibre rejeté | ✅ réelle |
| 5 | modification du posted rejetée | ✅ réelle — mais **UPDATE seulement**, pas INSERT (**P0-03**) |
| 6 | suppression du posted rejetée | ✅ réelle |
| 7 | contre-passation OK | ✅ réelle |
| 8 | « balance équilibrée (somme des soldes = 0) » | ⚠️ **tautologique** — lit `v_account_balances`, somme **tous tenants**, et le trigger garantit déjà le résultat |
| **9** | **« RLS : un utilisateur ne voit que son périmètre »** | ❌ **N'ASSERTIONNE RIEN** |

Bloc 9, tel qu'écrit :

```sql
SET ROLE app_role;
SELECT set_config('app.current_user_id', current_setting('app.test_uid'), false) AS _ ;
SELECT count(*) AS dossiers_visibles_par_le_user FROM dossiers;   -- affiché
RESET ROLE;
SELECT 'Tous les dossiers (vue admin)' AS info, count(*) AS total FROM dossiers;
```

Aucun `IF … RAISE EXCEPTION`. **Ce test ne peut pas échouer** — la RLS pourrait être
entièrement désactivée que la CI resterait verte. L'étape s'intitule pourtant
« SQL smoke test (ledger, immuabilité, **RLS**) ».

Sortie observée : `dossiers_visibles_par_le_user = 1` face à `total = 23`, imprimé sans
comparaison.

---

## 5. Capacités critiques → couverture réelle

Le tableau qui compte : pour chaque garantie que Nova vend, qu'est-ce qui la protège
d'une régression ?

| Capacité critique | Test existant | En CI | Détecte une régression ? |
|---|---|:--:|---|
| Équilibre débit = crédit | smoke 3-4, `test:domain` | ✅ | ✅ **oui** |
| Immuabilité — UPDATE d'une ligne validée | smoke 5 | ✅ | ✅ oui |
| Immuabilité — DELETE d'une écriture validée | smoke 6 | ✅ | ✅ oui |
| **Immuabilité — INSERT dans une écriture validée** | **aucun** | ❌ | ❌ **non — défaut actif (P0-03)** |
| Contre-passation | smoke 7 | ✅ | ✅ oui |
| **Isolation inter-tenant (tables)** | smoke 9 | ✅ | ❌ **non — n'assertionne rien (P1-07)** |
| **Isolation inter-tenant (vues)** | **aucun** | ❌ | ❌ **non — fuite active (P0-01)** |
| **Rôle de connexion non-propriétaire** | **aucun** | ❌ | ❌ **non — effondrement possible (P0-02)** |
| **Autorisation `dossier_delete`** | `test:securite` | ❌ | ⚠️ existe mais **hors CI** |
| Autorisation `cabinet_member_*` | aucun | ❌ | ❌ non |
| Autorisation `reverse_entry` (périmètre) | aucun | ❌ | ❌ non |
| **Bornes d'exercice** | `test:bornes` (14) | ❌ | ⚠️ existe mais hors CI — et ne teste que le chemin applicatif (**P1-02**) |
| **`is_postable` — refus d'écriture** | **aucun** | ❌ | ❌ **non — jamais imposé (P1-01)** |
| **Cohérence compte ↔ dossier** | **aucun** | ❌ | ❌ **non — défaut actif (P1-03)** |
| Exercice clos → refus | smoke, `test:exercices` | partiel | ⚠️ hors CI |
| À-nouveaux / lecture par exercice vs cumulée | `test:exercices` (49) | ❌ | ⚠️ hors CI — **la règle la plus glissante du produit** |
| Équilibre du bilan | `test:etats` | ❌ | ⚠️ hors CI |
| Recoupement résultat ↔ balance | `test:etats` | ❌ | ⚠️ hors CI |
| Couverture des postes du bilan | `test:postes` | ❌ | ⚠️ hors CI |
| Notes annexes DSF | `test:notes` (24) | ❌ | ⚠️ hors CI |
| Moteur de paie (barème ITS) | `test:payroll` (78) | ❌ | ⚠️ hors CI |
| Analytique multi-axes | `test:axes` (34) | ❌ | ⚠️ hors CI |
| Reclassements / redressement | `test:reclassement` (67) | ❌ | ⚠️ hors CI |
| **Authentification (JWT, TOTP, débit)** | **aucun** | ❌ | ❌ **non (P3-05)** |
| **Politique monétaire / précision** | **aucun** | ❌ | ❌ **non (P2-01)** |
| **Gating des outils Lexa (mode × rôle)** | **aucun** | ❌ | ❌ **non** |
| **Validation de type des pièces jointes** | **aucun** | ❌ | ❌ **non (P1-04)** |
| Webhooks (signature, idempotence) | aucun | ❌ | ❌ non |
| Facturation / achats / banque / MoMo / fiscalité | aucun | ❌ | ❌ non |

**Lecture** : sur 30 capacités critiques, **5 sont réellement protégées en CI**,
14 disposent d'un test qui ne tourne pas, et **11 n'ont aucun test** — dont les six
défauts que cette revue a trouvés.

Ce n'est pas un hasard : **les défauts trouvés sont exactement ceux qu'aucun test ne
couvrait.** Là où les tests existent, le code est correct.

---

## 6. Qualité des tests existants

### Ce qui est bien conçu

**`test:exercices` (49 contrôles)** — verrouille la règle la plus dangereuse du produit :
lecture **par exercice** (filtre `fiscal_year_id`, à-nouveaux compris) vs lecture
**cumulée** (position à date, qui doit écarter les reports). `docs/DEV-LOCAL.md` explique
l'enjeu : « sinon tout ce qui touche au bilan double après la première clôture ». C'est un
test écrit par quelqu'un qui s'est déjà fait piéger.

**`test:etats`** — recoupe **deux sources de calcul indépendantes** (regroupement par
nature vs format officiel avec SIG) et vérifie l'équilibre du bilan **et** le recoupement
du résultat avec la balance. C'est l'inverse d'un contrôle auto-référentiel.

**`test:payroll` (78)** — inclut des tests « golden » sur le barème ITS officiel DGI :
`engine.golden.test.ts`, plus des suites dédiées aux absences, heures supplémentaires,
prêts, solde de tout compte, allocation spéciale.

**`test:securite` (4)** — écrit **à partir d'une faille réelle** (la logique ternaire de
`dossier_delete`), il teste les trois profils qui comptent : étranger, collaborateur,
propriétaire. C'est le bon réflexe.

**`test:postes`** — signale les comptes non couverts par un poste **sans faire échouer**,
volontairement : « un trou visible vaut mieux qu'un trou comblé au jugé »
(`docs/RESTE-A-FAIRE.md § 1.1`). Décision assumée et documentée.

### Faiblesses de fond

| Faiblesse | Conséquence |
|---|---|
| **Aucun test unitaire pur hors paie** | tout passe par Postgres ; les suites sont lentes et non parallélisables |
| **Base partagée, nettoyage non systématique** | possible dépendance à l'ordre d'exécution ; une suite peut masquer l'échec d'une autre |
| **Aucun test négatif sur les invariants base** | on teste que le chemin correct marche, jamais que le chemin incorrect échoue |
| **Aucun test de propriété / fuzz** | c'est ce qui aurait attrapé P2-01 (précision monétaire) |
| **Aucun test sur `auth.ts`** | module le plus sensible, zéro couverture |
| **Aucun test sur le gating Lexa** | la matrice mode × rôle n'est vérifiée par rien |
| **Aucune mesure de couverture** | pas de `c8`/`nyc` ; le pourcentage réel est inconnu |
| **Tous les tests empruntent `postEntry`** | par construction, ils ne peuvent pas voir les invariants absents du schéma |

Ce dernier point est le plus important. Les 439 contrôles valident **le comportement du
chemin applicatif**. Aucun ne valide **la garantie du moteur**. C'est pourquoi ils sont
tous verts alors que quatre invariants manquent.

---

## 7. Quality gate proposé

### Tier 1 — chaque PR · cible < 5 min

| Étape | Contenu | Nouveau ? |
|---|---|:--:|
| Typecheck | `tsc --noEmit` front + serveur | existant |
| Build | `npm run build` | **nouveau** |
| Migrations | 77 migrations sur base neuve | existant |
| **Invariants ledger (SQL bloquant)** | équilibre · immuabilité **UPDATE + DELETE + INSERT** · bornes d'exercice · `is_postable` · cohérence compte↔dossier↔écriture · exercice clos | **nouveau** — couvre P0-03, P1-01, P1-02, P1-03 |
| **Smoke sécurité (SQL bloquant)** | RLS avec `RAISE EXCEPTION` réelle · vue `v_account_balances` isolée · rôle de connexion non-propriétaire | **nouveau** — couvre P0-01, P0-02, P1-07 |
| `test:domain` | 10 contrôles | existant |
| `test:securite` | 4 contrôles d'autorisation | **à ajouter** |
| `test:payroll` | 78 contrôles, sans base, rapide | **à ajouter** |

### Tier 2 — PR touchant `server/domain/**` ou `supabase/**`, et tout merge sur `main`

Les 15 suites restantes : `exercices`, `etats`, `postes`, `notes`, `controles`,
`coherence`, `axes`, `pnl`, `reclassement`, `bornes`, `production-immo`, `paie-variable`,
`capture`, `veille`, `assistant-analytique`.

Plus : `npm audit --omit=dev` en échec sur `high` (couvre P2-08).

### Tier 3 — nocturne

| Suite | Ce qu'elle attraperait |
|---|---|
| Scénario complet : cabinet → dossiers → 2 exercices → clôture → réouverture → états | régressions inter-modules |
| **Tests de propriété sur le ledger** — montants aléatoires, très grands nombres, décimales, dates aux bornes | **P2-01** (précision monétaire) |
| Fuzzing des 311 routes — corps malformés, identifiants d'autres tenants, types inattendus | IDOR, mass assignment, 500 masqués en 400 |
| **Tests IA avec clé réelle** — injection de prompt, tentative de franchissement de dossier, tentative de dépassement de palier | **P2-07**, **P1-05** |
| Téléversement de fichiers hostiles (HTML, SVG, MIME menteur) | **P1-04** |
| Performance : 10 000 écritures, génération des états, `EXPLAIN` sur les requêtes clés | dérive de performance |

### Effet attendu

| | Avant | Après Tier 1 | Après Tier 1+2 |
|---|:--:|:--:|:--:|
| Contrôles par PR | 18 | ~110 | ~110 |
| Contrôles par merge | 18 | ~110 | **~450** |
| Capacités critiques protégées | 5/30 | **19/30** | **26/30** |
| Défauts de cette revue qui seraient détectés | 0/6 | **6/6** | 6/6 |

---

## 8. Recommandations d'infrastructure de test

1. **Isoler chaque suite.** Une base (ou un schéma) par suite, créée et détruite autour de
   l'exécution. Supprime la dépendance à l'ordre et permet le parallélisme.
2. **Tester avec `nova_app`, migrer avec le propriétaire.** C'est déjà la convention du
   projet (`DATABASE_URL` en `nova_app` dans `ci.yml`) : la conserver explicitement, et
   ajouter une assertion qui échoue si les tests tournent en rôle propriétaire — sinon la
   RLS est contournée et les tests d'isolation passent à tort.
3. **Aligner les versions de Node** (`engines` + `.nvmrc`), et faire tourner la CI sur
   celle de l'image de production.
4. **Mesurer la couverture** (`c8`) sur `server/domain/**`, sans en faire une porte
   bloquante au début — juste pour savoir.
5. **Écrire les tests négatifs d'abord** pour les six défauts de cette revue : ils doivent
   **échouer** sur le HEAD actuel, puis passer après correction. C'est la seule preuve que
   le correctif corrige.
