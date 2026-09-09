# Nova Comptabilité — Remédiation des P0 nº 001

> Vague 1 de la revue CTO 001. **Périmètre strict : les trois P0 confirmés.**
> Aucun P1/P2/P3 corrigé. Aucun refactoring. Aucune fonctionnalité.
> Aucune base de production touchée : tout a été mené sur des conteneurs
> PostgreSQL 16 jetables, détruits à la fin.

| | |
|---|---|
| **Base de départ** | `9c5045b10634f81362bb3ff541365a241dc24bd9` |
| **Arbre de travail au départ** | propre côté application (seuls les 5 rapports de revue, non suivis) |
| **PostgreSQL** | 16.14 — CI (`postgres:16`), image de dév (`postgres:16-alpine`) |
| **Date** | 9 septembre 2026 |

---

## 1. Baseline — les trois P0 reproduits séparément

Chaque faille a été rejouée isolément sur une base neuve reconstruite depuis les
77 migrations, avec le rôle applicatif réel `nova_app`, avant toute modification.

```text
BASELINE_HEAD=9c5045b10634f81362bb3ff541365a241dc24bd9
WORKTREE_CLEAN=YES (application) — 5 rapports de revue non suivis

P0_01_REPRODUCED=YES
P0_02_REPRODUCED=YES
P0_03_REPRODUCED=YES
```

**P0-01** — Bob (cabinet B), via la vue :

```
Bob_tables_lignes_de_A=0          ← RLS correcte sur les tables
Bob_VUE_lignes_de_A=2             ← FUITE
Bob_VUE_montant_fuite=777777.0000
SANS_identite_tables=0
SANS_identite_VUE=2               ← la vue répond même sans identité
```

**P0-02** — même code, connexion en rôle propriétaire :

```
Bob_en_role_proprietaire_ecritures_de_A=1
donnee_fuitee=SECRET-A-CONFIDENTIEL
tables_RLS_sans_FORCE=57
```

**P0-03** — le scénario historique, dans une transaction :

```
AVANT_debit=777777.0000
INSERT 0 1 / INSERT 0 1 / COMMIT   ← aucune erreur
APRES_debit=1277777.0000
APRES_nb_lignes=4
statut=posted posted_at=2026-09-09 04:44:31   ← inchangé
```

Les scénarios sont conservés comme tests de régression :
`supabase/tests/fixture_two_tenants.sql` + `supabase/tests/p0_invariants.sql`.

---

## 2. NOVA-P0-03 — Immuabilité des écritures validées

### Cause racine

`supabase/migrations/20260629000004_integrity.sql:170` :

```sql
create trigger trg_protect_lines
  before update or delete on entry_lines     -- INSERT absent
```

Le second garde-fou, le trigger d'équilibre `trg_entry_balanced`, est **différé**
et contrôle la **somme** des lignes. Une paire ajoutée au débit *et* au crédit
laisse la somme inchangée : il ne voit rien. Les deux contrôles se croisaient
sans se rencontrer — c'est le trou exact.

Défaut jumeau, découvert en corrigeant : `protect_posted_entries` fonctionnait
par **liste noire** de colonnes. Tout ce qui n'y figurait pas restait modifiable
sur une écriture validée — `piece_ref` (clé de la piste d'audit), `posted_at`
(antidatage possible de la validation), `document_url`, `ai_confidence`,
`created_by`.

### Politique retenue, explicite

| Statut | Lignes | En-tête |
|---|---|---|
| `draft` | libres | libre |
| `posted` | **figées** (ajout, modif, suppression) | figé sauf 3 colonnes |
| `reversed` | **figées** | figé sauf 3 colonnes |

`reversed` est traité comme final bien qu'il ne soit **plus posé** : depuis la
migration 0075, une contre-passation laisse l'écriture d'origine en `posted` et
la marque par `reversed_by_entry_id`, et l'existant a été ramené à `posted`.
Le laisser ouvert rouvrirait par la bande les écritures d'une base ancienne, ou
d'un futur code qui le reposerait.

Les trois seules colonnes modifiables sur une écriture en statut final :

| Colonne | Pourquoi |
|---|---|
| `status` | transition `posted` → `reversed` (compatibilité) |
| `reversed_by_entry_id` | posé par `reverse_entry` sur l'origine, **qui reste `posted`** depuis 0075. Sans cela, plus aucune contre-passation possible. |
| `reverses_entry_id` | remis à `NULL` par `dossier_delete`, qui dénoue les liens croisés avant suppression |

La comparaison passe par `to_jsonb(new) - <colonnes autorisées>` plutôt que par
une énumération. Ce n'est pas un raccourci d'écriture : c'est ce qui fait que
**toute colonne ajoutée plus tard au schéma est figée par défaut**, sans qu'il
faille penser à revenir modifier le trigger. C'est précisément l'oubli qui avait
créé la faille.

### Fichiers

| Fichier | Nature |
|---|---|
| `supabase/migrations/20260909000078_immuabilite_ecriture_validee.sql` | nouveau |

### Tests de régression — 11 contrôles

`supabase/tests/p0_invariants.sql` § NOVA-P0-03 :

| # | Scénario | Attendu | Résultat |
|:--:|---|---|:--:|
| .1 | INSERT d'une ligne dans une écriture validée | refus | PASS |
| .2 | **INSERT de deux lignes équilibrées (777 777 → 1 277 777)** | refus | PASS |
| .3 | UPDATE d'une ligne validée | refus | PASS |
| .4 | DELETE d'une ligne validée | refus | PASS |
| .5 | UPDATE date / `piece_ref` / `posted_at` de l'en-tête | refus | PASS |
| .6 | DELETE de l'écriture validée | refus | PASS |
| .7 | Création d'un brouillon | **autorisé** | PASS |
| .8 | Ajout de lignes à un brouillon | **autorisé** | PASS |
| .9 | Validation d'un brouillon équilibré | **autorisé** | PASS |
| .10 | Contre-passation : origine conservée + marquée, **net = 0** | autorisé | PASS |
| .11 | Extourne figée + pas de double contre-passation | refus | PASS |

Le test .2 rejoue le scénario historique à l'identique et refuse de passer si
l'écriture dépasse 777 777.

> **Un test s'est révélé faux, pas le code.** La première version de .10
> attendait que l'écriture d'origine passe en `reversed`. C'est l'ancienne
> sémantique, celle que la migration 0075 a corrigée parce qu'elle sortait
> l'écriture des comptes et laissait le solde à l'opposé du montant. Le test a
> été aligné sur la sémantique réelle, et enrichi du contrôle qui compte
> vraiment : origine + extourne s'annulent au compte (net = 0).

### Risques résiduels

- Les données **déjà** corrompues avant ce correctif ne sont pas détectées : le
  trigger ne s'applique qu'aux écritures futures. Un inventaire des écritures
  validées dont le nombre de lignes a varié après `posted_at` serait utile —
  hors périmètre de cette vague.
- Le verrou est en base, donc valable pour tout chemin d'écriture. Il reste
  contournable par un rôle capable de faire `ALTER TABLE ... DISABLE TRIGGER`,
  c'est-à-dire le propriétaire — d'où l'importance de P0-02.

---

## 3. NOVA-P0-02 — Contournement de la RLS par le rôle de connexion

### Cause racine

Deux manques cumulés :

1. Aucune table n'avait `FORCE ROW LEVEL SECURITY` (57 sur 57). Or la RLS ne
   s'applique jamais au **propriétaire** d'une table tant qu'elle n'est pas
   forcée.
2. Rien ne vérifiait, au démarrage, l'identité PostgreSQL réellement utilisée.
   `assertAuthConfig()` protégeait le secret JWT ; rien ne protégeait le rôle base.

Toute l'étanchéité reposait donc sur une hypothèse jamais vérifiée à l'exécution.
Les Postgres managés (Railway, Neon, Supabase, RDS) fournissent par défaut une
chaîne de connexion en propriétaire ou en superutilisateur : le chemin par défaut
est le chemin dangereux.

### La mesure évidente ne suffisait pas — mesuré, pas supposé

`FORCE ROW LEVEL SECURITY` a été posé sur les 57 tables, puis l'attaque rejouée :

```
=== ATTAQUE P0-02 : connexion en rôle propriétaire (postgres), contexte = Bob ===
ecritures_de_A_vues_par_Bob=3
donnee_fuitee=SECRET-A-CONFIDENTIEL      ← la fuite persiste
```

**FORCE n'a rien changé**, parce que le rôle reproduisant l'attaque est
*superutilisateur*, et qu'un superutilisateur ignore la RLS quelle que soit la
configuration des tables. La couverture réelle :

| Identité du runtime | FORCE la neutralise ? |
|---|:--:|
| Propriétaire des tables, non-superutilisateur | ✅ oui |
| `SUPERUSER` | ❌ non |
| `BYPASSRLS` | ❌ non |

C'est ce qui décide de l'architecture retenue : **la garde de démarrage est la
mesure principale**, FORCE en est le complément. L'ordre inverse aurait donné une
fausse impression de sécurité — on aurait posé FORCE, coché la case, et laissé
grande ouverte la porte la plus empruntée.

### Ce qui a été mis en œuvre

**A. Garde de démarrage — `server/dbguard.ts`** (mesure principale)

Interroge la base sur `current_user` — pas sur `DATABASE_URL`, qui peut mentir
(pgbouncer, `SET ROLE` d'infrastructure, alias). Refuse le démarrage **en
production** si le rôle est `SUPERUSER`, a `BYPASSRLS`, ou possède une table sous
RLS. Hors production : avertissement, pour ne pas gêner un Postgres local jetable.

Même contrat qu'`assertAuthConfig()`, et appelée **avant `app.listen()`** : servir
une seule requête avec un rôle capable de contourner la RLS suffit à exposer un
cabinet à un autre.

La garde ne lève pas si la base est injoignable — transformer un incident réseau
en panne totale n'aurait rien sécurisé ; l'indisponibilité est déjà signalée par
`/api/health`.

**B. `FORCE ROW LEVEL SECURITY`** — migration 0080, sur les 57 tables sous RLS.

Compatibilité **vérifiée avant application**, comme le demandait la revue :
les 15 suites adossées à la base rejouées avec FORCE posé partout — 438 contrôles,
zéro échec. Contrôles ciblés également passés : `get_user_for_login` (connexion
sans identité en session), `register_user`, `onboard_cabinet`, lecture des
dossiers et des cabinets. Le risque théorique de récursion (les 57 policies
appellent `app_dossier_ids()`, qui lit lui-même `dossiers` et `cabinet_members`)
ne s'est pas matérialisé.

**C. Durcissement du rôle applicatif** — `alter role nova_app nosuperuser
nobypassrls nocreatedb nocreaterole`. Ce sont les valeurs par défaut de
`CREATE ROLE` ; on réaffirme l'état attendu au cas où une base aurait dérivé.

**D. Propriété des tables** — *non modifiée*, volontairement. Un `REASSIGN OWNED`
depuis une migration supposerait de connaître le rôle propriétaire cible, qui
dépend de l'hébergeur, et un échec rendrait la base inadministrable. La séparation
`nova_migrator` (DDL) / `nova_app` (runtime) reste une exigence de déploiement —
et c'est la garde de démarrage qui la **vérifie à l'exécution**, ce qui est plus
robuste qu'un `ALTER` joué une fois.

### Fichiers

| Fichier | Nature |
|---|---|
| `supabase/migrations/20260909000080_force_rls_et_role_applicatif.sql` | nouveau |
| `server/dbguard.ts` | nouveau |
| `server/index.ts` | modifié — garde appelée avant `app.listen()` |
| `server/integration-test-dbguard.ts` | nouveau |
| `package.json` | modifié — script `test:dbguard` |

### Tests de régression

**`npm run test:dbguard` — 11 contrôles.** Crée de **vrais rôles PostgreSQL** et
interroge la base avec chacun. Un test qui se contenterait d'appeler `dangersFor()`
sur des objets fabriqués vérifierait la logique de décision, pas la détection —
or c'est la détection qui manquait.

| Identité | Attendu | Résultat |
|---|---|:--:|
| `nova_guard_sain` (NOSUPERUSER, NOBYPASSRLS, non-owner) | démarrage **autorisé** | PASS |
| `nova_guard_bypass` (BYPASSRLS) | démarrage **refusé** | PASS |
| `nova_guard_super` (SUPERUSER) | démarrage **refusé** | PASS |
| `postgres` (propriétaire de 57 tables) | démarrage **refusé** | PASS |
| FORCE posé sur toutes les tables sous RLS | 0 table sans FORCE | PASS |

**Vérification bout en bout, processus réellement lancé :**

```
NODE_ENV=production  DATABASE_URL=…postgres…   → exit 1
  [dbguard] Identité PostgreSQL dangereuse en production : démarrage refusé.
    · le rôle « postgres » est SUPERUSER : il ignore la RLS…
    · le rôle « postgres » a l'attribut BYPASSRLS : il ignore la RLS
    · le rôle « postgres » est PROPRIÉTAIRE de 57 table(s) sous RLS…

NODE_ENV=production  DATABASE_URL=…nova_app…   → démarre
  [dbguard] rôle « nova_app » : NOSUPERUSER, NOBYPASSRLS, non propriétaire —
            isolation applicable.
  Nova Comptabilité API → port 4124
```

**`supabase/tests/p0_invariants.sql` § NOVA-P0-02 — 4 contrôles**, dont les six
attaques inter-cabinets de la revue (T1, R1–R5, T2), toutes bloquées.

> **Un bug réel de ma propre garde, attrapé par ce test.** `array_agg(relname)`
> renvoie un `name[]` (OID 1003), que le pilote `pg` ne sait pas décoder et
> restitue comme une chaîne. `ownedTenantTables` valait donc `'{}'` — une chaîne
> de longueur 2 — et `length > 0` était vrai : **la garde aurait refusé de
> démarrer sur un rôle parfaitement sain.** Corrigé par
> `array_agg(c.relname::text)`. C'est exactement ce qu'un test sur objets
> fabriqués n'aurait jamais vu.

### Risques résiduels

- La garde s'appuie sur `pg_roles`. Un hébergeur exposant un rôle non-superuser,
  non-owner, mais membre d'un rôle qui l'est (héritage) ne serait pas détecté :
  la garde lit les attributs directs, pas l'appartenance transitive. À renforcer
  si un hébergeur impose ce montage.
- FORCE reste levable par le propriétaire (`ALTER TABLE … NO FORCE`). C'est
  pourquoi la non-propriété du rôle runtime est vérifiée séparément.
- **Point d'attention pour les migrations futures** : si `MIGRATION_DATABASE_URL`
  désigne un rôle propriétaire **non superutilisateur**, une migration faisant un
  backfill sur une table locataire se verra appliquer la RLS et ne verra aucune
  ligne — silencieusement. Documenté en tête de la migration 0080.

---

## 4. NOVA-P0-01 — Fuite inter-cabinet par `v_account_balances`

### Cause racine

`supabase/migrations/20260629000004_integrity.sql:183` créait la vue sans option
de sécurité. En PostgreSQL, une vue s'exécute par défaut avec les droits de son
**propriétaire**, pas de l'appelant. Le propriétaire est ici le rôle qui a joué
les migrations — donc le propriétaire des tables, pour qui la RLS ne s'appliquait
pas (P0-02). La vue lisait tout, pour tout appelant ayant `SELECT` dessus — et
`nova_app` l'avait, hérité du `grant select on all tables` de la migration 0007.

### Correction

`alter view v_account_balances set (security_invoker = true)` — la vue s'exécute
désormais avec les droits de l'appelant, donc sous les policies de `entry_lines`,
`entries` et `accounts`.

C'est la bonne primitive plutôt qu'un filtre locataire écrit à la main dans le
corps de la vue : un filtre serait une **seconde expression** de la règle
d'étanchéité, à maintenir en parallèle des 57 policies. Deux sources de vérité
pour une même règle finissent par diverger — c'est le genre d'écart qui a produit
cette faille. Ici la vue hérite de la règle unique.

Disponible depuis PostgreSQL 15 ; CI, image de dév et production sont en 16.

### Le défaut portait sur la classe, pas sur l'instance

Rien dans le projet n'imposait l'option aux vues. Le contrôle ajouté ne nomme donc
aucun objet : `p0_invariants.sql` § P0-01.4 parcourt `pg_class` et **échoue si une
seule vue du schéma `public` n'est pas en `security_invoker`**. La prochaine vue
créée sans l'option mettra la CI au rouge.

### Audit complémentaire exigé

**Vues — inventaire exhaustif (1 objet)**

| VIEW | OWNER | SECURITY MODE | SOURCE TABLES | RLS SOURCES | TENANT SAFE? | TESTED? |
|---|---|---|---|---|:--:|:--:|
| `v_account_balances` | `postgres` | `security_invoker = true` | `accounts`, `entries`, `entry_lines` | les 3 sous RLS + FORCE | ✅ oui | ✅ P0-01.1/.2/.3 |

**Fonctions `SECURITY DEFINER` — 37 objets, toutes possédées par `postgres`**

| Critère | Compte |
|---|---|
| Avec `set search_path` explicite | **36** |
| Sans `search_path` | **1** — `instantiate_chart` |

`instantiate_chart` correspond à NOVA-P3-03 de la revue. **Exploitabilité testée,
non supposée** : une attaque par `search_path` suppose que l'appelant puisse créer
un schéma ou une table portant les objets leurres. Vérifié pour `nova_app` :

```
create schema attaque;              → ERROR: permission denied for database nova
create table public.attaque_test…   → ERROR: permission denied for schema public
has_create_on_db=false
has_create_on_public=false
```

Le rôle applicatif ne peut créer ni schéma ni table : **non exploitable par le
runtime**. Reste un défaut d'hygiène (P3), laissé en l'état — hors périmètre de
cette vague, conformément à la consigne.

**Aucune seconde fuite critique reproduite → `NEW_P0_FOUND=0`.**

### Tests de régression — 4 contrôles

| # | Scénario | Résultat |
|:--:|---|:--:|
| .1 | Bob ne voit le cabinet A ni en table ni par la vue | PASS |
| .2 | Sans identité, tables **et** vue renvoient zéro ligne | PASS |
| .3 | Alice voit toujours ses propres soldes (non-régression) | PASS |
| .4 | Aucune vue du schéma sans `security_invoker` | PASS |

Le contrôle .3 compte autant que les autres : un verrou qui bloque aussi le
travail légitime n'est pas un verrou, c'est une panne.

### Risques résiduels

- `security_invoker` est une propriété de chaque vue. Une nouvelle vue créée sans
  l'option rouvrirait le trou — d'où le contrôle .4, qui porte sur la règle.
- Les **fonctions** retournant des tables (`SETOF`) ne sont pas couvertes par ce
  mécanisme : une future fonction `SECURITY DEFINER` renvoyant des données
  locataires devrait porter sa propre garde de périmètre, comme `reverse_entry`.

---

## 5. Defense in Depth

Pourquoi chaque correction tient même si une couche applicative se trompe.

### Immuabilité (P0-03)

Le verrou est un **trigger de base**, pas un contrôle applicatif. Il s'applique
quel que soit le chemin : API, import en masse, outil Lexa, script de reprise,
`psql` à la main. C'était précisément le manque : la protection réelle venait du
fait qu'un seul endroit du code écrit dans `entry_lines` — une propriété
accidentelle, qui disparaissait au premier second chemin.

La liste blanche par `to_jsonb` ajoute une couche temporelle : **une colonne
ajoutée dans six mois est protégée le jour où elle est créée**, sans que personne
ait à y penser. Une liste noire aurait exigé une vigilance permanente — et c'est
l'absence de cette vigilance qui a produit la faille.

### Frontière locataire (P0-02)

Trois barrières indépendantes, aucune ne suffisant seule :

| Barrière | Couvre | Ne couvre pas |
|---|---|---|
| Garde de démarrage | superuser, BYPASSRLS, propriétaire | une dérive de droits **après** le boot |
| `FORCE ROW LEVEL SECURITY` | propriétaire non-superutilisateur, à tout instant | superuser, BYPASSRLS |
| `nova_app` NOSUPERUSER/NOBYPASSRLS | dérive d'attributs du rôle | rôle changé dans `DATABASE_URL` |

Si la garde est contournée (variable d'environnement oubliée, `NODE_ENV` mal
posé), FORCE protège encore du cas propriétaire. Si FORCE est levé, la garde a
déjà refusé le démarrage sur un rôle propriétaire. Il faut **échouer sur les
trois** pour rouvrir la faille.

Et si tout tombe, le contrôle `p0_invariants.sql` § P0-02.1 met la CI au rouge dès
qu'une table perd son FORCE : la dérive se voit avant d'atteindre la production.

### Isolation des vues (P0-01)

`security_invoker` fait dépendre la vue des **mêmes policies** que les tables : il
n'y a plus deux règles d'étanchéité, il y en a une. Une erreur dans une policy
serait visible partout d'un coup — mieux qu'un filtre qui masquerait la
divergence sur un seul objet.

Le contrôle porte sur la classe (toute vue) et non sur `v_account_balances` : le
prochain objet dérivé est couvert avant d'exister.

### La couche qui manquait : la CI

Les trois correctifs vivent en base, donc sous la ligne de flottaison
applicative. Mais rien ne les empêcherait d'être défaits par une migration
future. Les contrôles sont donc **bloquants dans la CI** — c'est ce qui
transforme trois correctifs en trois invariants.

---

## 6. Nouveaux défauts constatés (documentés, non corrigés)

Trouvés pendant la remédiation. **Aucun n'est un P0**, aucun n'est corrigé ici,
conformément au périmètre.

### NOUVEAU-P1-A — `dossier_delete` échoue sur tout dossier contenant une écriture validée

**Statut : CONFIRMED — pré-existant, antérieur à cette vague.**

`dossier_delete` (migrations 0068 / 0077) fait `delete from entry_lines` puis
`delete from entries` sur le dossier. Ces suppressions sont bloquées par les
triggers de protection dès qu'une écriture est validée.

Vérifié sur une base **sans** la migration 0078 (donc à l'état de la revue) :

```
ecritures_posted_dans_le_dossier=1
ERROR: Suppression interdite : les lignes de l'écriture … sont verrouillées
CONTEXT: SQL statement "delete from entry_lines where dossier_id = p_dossier"
         PL/pgSQL function dossier_delete(uuid) line 23
```

Comportement **identique après** la migration 0078 (seul le message change) : ce
n'est pas une régression de cette vague.

Conséquence : la suppression d'un dossier ne fonctionne que sur un dossier **vide**.
C'est aussi la raison pour laquelle `test:securite` ne l'avait pas vu — il
supprime un dossier sans écriture.

Correction possible (vague ultérieure) : faire désactiver localement les triggers
par `dossier_delete`, ou passer les écritures en `draft` avant suppression, en
gardant la garde d'autorisation. À traiter avec soin : c'est la seule opération
légitime qui doit franchir le verrou d'immuabilité.

### NOUVEAU-P3-A — `instantiate_chart` sans `search_path`

Déjà relevé comme NOVA-P3-03. Exploitabilité **testée** : `nova_app` ne peut créer
ni schéma ni table, donc non exploitable par le runtime. Hygiène, hors périmètre.

---

## 7. Non-régression

### Suites de tests — 19 sur 19, aucune régression

| Suite | Contrôles | | Suite | Contrôles |
|---|---:|---|---|---:|
| `test:payroll` | 78/78 | | `test:notes` | 24 |
| `test:reclassement` | 67 | | `test:pnl` | 23 |
| `test:exercices` | 49 | | `test:production-immo` | 23 |
| `test:axes` | 34 | | `test:veille` | 19 |
| `test:assistant-analytique` | 34 | | `test:capture` | 15 |
| `test:paie-variable` | 25 | | `test:bornes` | 14 |
| `test:controles` | 11 | | `test:domain` | 10 |
| **`test:dbguard`** (nouveau) | **11** | | `test:coherence` | 9 |
| `test:securite` | 4 | | `test:etats`, `test:postes` | qualitatif |

**≈ 450 contrôles, 0 échec.** `npm run typecheck` : propre. `npm run build` : OK.

Le `smoke_test.sql` existant passe 8/8 sur base fraîche, inchangé.

> Note : le `smoke_test.sql` échoue s'il est rejoué **deux fois sur la même base**
> (il choisit une écriture validée arbitraire pour la contre-passer et retombe sur
> une déjà contre-passée). Propriété pré-existante du test, sans lien avec cette
> vague — en CI il tourne toujours sur une base neuve.

### Migrations — les quatre cas exigés

| Cas | Résultat |
|---|---|
| Base vierge (80 migrations dans l'ordre) | ✅ 0 échec |
| Base à l'état **avant** correction, peuplée par 4 suites (26 écritures, 60 lignes) | ✅ les 3 migrations passent |
| Deuxième exécution des 3 nouvelles | ✅ rejouables sans erreur |
| Validation après migration | ✅ **26 écritures / 60 lignes conservées**, 0 table sans FORCE, invariants verts, suites vertes |

Aucune perte de données. Les nouveaux triggers ne s'appliquent qu'aux écritures
futures : une donnée déjà non conforme n'est pas rejetée rétroactivement (voir
risques résiduels § 2).

### CI

Trois étapes ajoutées, strictement pour les P0 — le renforcement complet de la
chaîne de tests reste NOVA-P1-06, hors de cette vague :

```yaml
- name: Invariants P0 (immuabilité, isolation des vues, frontière locataire)
  run: |
    psql -v ON_ERROR_STOP=1 -q -f supabase/tests/fixture_two_tenants.sql
    psql -v ON_ERROR_STOP=1 -f supabase/tests/p0_invariants.sql

- name: Garde d'identité PostgreSQL au démarrage (NOVA-P0-02)
  run: npm run test:dbguard
```

Plus `MIGRATION_DATABASE_URL` dans l'environnement du job (`test:dbguard` crée des
rôles jetables). Pipeline simulée de bout en bout sur base neuve : **verte**.

---

## 8. Ce qui reste ouvert

Les trois P0 sont fermés. **Le pilote reste NON prêt** : 8 P1 et 10 P2 de la revue
sont intacts. Les plus structurants :

| | |
|---|---|
| **NOVA-P1-08** | migrations « best-effort » appliquées après l'ouverture du port — un schéma incomplet est servi sans alerte. **Concerne directement ces correctifs** : rien ne garantit aujourd'hui que 0078/0079/0080 soient réellement appliquées en production. |
| **NOVA-P1-06** | la CI n'exécute toujours qu'une petite partie des 19 suites |
| **NOVA-P1-04** | XSS stocké par téléversement de pièce |
| **NOVA-P1-01/02/03** | `is_postable`, bornes d'exercice, cohérence compte↔dossier — toujours hors base |
| **NOUVEAU-P1-A** | `dossier_delete` inopérant sur un dossier contenant des écritures |

**Vague suivante recommandée : WAVE 2 (sécurité et tenancy)**, avec une exception
à remonter en priorité — **NOVA-P1-08**. Tant que l'application des migrations
reste « au mieux », les trois invariants posés ici ne sont garantis que dans le
dépôt, pas nécessairement en base de production. Un invariant qu'on n'est pas sûr
d'avoir déployé n'est pas un invariant.

**Vérification à faire en production, dès le déploiement** :

```sql
select name from _migrations where name like '202609090000%';   -- doit retourner 3 lignes
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname='public' and c.relkind='r'
   and c.relrowsecurity and not c.relforcerowsecurity;          -- doit valoir 0
```

Et au démarrage, le journal doit porter :
`[dbguard] rôle « … » : NOSUPERUSER, NOBYPASSRLS, non propriétaire — isolation applicable.`

---

*Remédiation menée sur conteneurs PostgreSQL 16 jetables (`nova-p0`, `nova-pre`,
`nova-upg`, `nova-ci`, `nova-smoke`), tous détruits. Aucune base de production
touchée, aucun secret demandé, aucune donnée réelle introduite dans les fixtures.*
