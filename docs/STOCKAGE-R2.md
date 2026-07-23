# Basculement du stockage des pièces vers Cloudflare R2

Runbook de passage du stockage des justificatifs de **`db`** (octets en base
Postgres) vers **`r2`** (Cloudflare R2, stockage objet S3-compatible).

> **À qui / quand** : à faire avant la mise en production, quand le volume de
> pièces commence à peser sur la base. En phase de test (données démo), rien ne
> presse. Opération réservée à l'exploitant (accès Cloudflare + Railway).

---

## 1. Pourquoi

En mode `db`, chaque justificatif (jusqu'à 15 Mo) vit dans la table
`document_blobs` : la base grossit, chaque sauvegarde Neon s'alourdit, et le
stockage base coûte plus cher que le stockage objet. R2 sort les binaires de la
base : sauvegardes allégées, coût au Go bien inférieur, **pas de frais de
sortie (egress)** chez Cloudflare.

## 2. Ce que le code fait déjà — aucun changement à livrer

- `storageMode()` (`server/storage/provider.ts`) renvoie `r2` **dès que les 4
  variables `R2_*` sont présentes**, sinon `db`. La bascule est donc un simple
  ajout de variables d'environnement.
- **Mode mixte natif** : chaque ligne `documents` mémorise son propre mode
  (`storage`) et sa clé (`storage_key`). La relecture (`getDocument`) choisit la
  bonne source par pièce. Donc après bascule : **les nouvelles** pièces vont
  dans R2, **les anciennes** restent lues depuis la base, sans rien casser.
- Signature AWS SigV4 faite maison (aucune dépendance), endpoint
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, région `auto`.
- Clé d'objet : `"<dossier_id>/<document_id>.<ext>"` (les pièces sont
  cloisonnées par dossier dans le bucket).

## 3. Prérequis

- Un compte Cloudflare avec **R2 activé** (nécessite une carte, même sur le
  palier gratuit : 10 Go/mois inclus).
- Accès au projet **Railway** de Nova (variables d'environnement).

## 4. Étape 1 — Créer le bucket R2

1. Cloudflare Dashboard → **R2** → **Create bucket**.
2. Nom, par ex. `nova-justificatifs` (ce sera `R2_BUCKET`).
3. Région : **Automatic**. Ne PAS activer l'accès public — les pièces sont
   servies **par l'API Nova** (authentifiée), jamais en direct.

## 5. Étape 2 — Créer un token API S3

1. R2 → **Manage R2 API Tokens** → **Create API token**.
2. Permissions : **Object Read & Write**.
3. Portée : **limiter au bucket** `nova-justificatifs` (principe du moindre
   privilège).
4. Cloudflare affiche alors :
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY` (affiché **une seule fois** —
     copiez-le tout de suite)
5. **Account ID** (`R2_ACCOUNT_ID`) : visible sur la page d'accueil R2 (ou dans
   l'URL du dashboard). C'est l'ID du compte Cloudflare, pas celui du bucket.

## 6. Étape 3 — Variables d'environnement Railway

Dans le service Nova sur Railway, ajouter les **4** variables :

| Variable | Valeur |
|---|---|
| `R2_ACCOUNT_ID` | Account ID Cloudflare |
| `R2_ACCESS_KEY_ID` | Access Key ID du token |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key du token |
| `R2_BUCKET` | `nova-justificatifs` |

⚠️ **Les 4 sont requises** : s'il en manque une, `storageMode()` retombe en
`db` silencieusement. Ne pas les mettre à moitié.

## 7. Étape 4 — Redéployer et vérifier

1. Railway redéploie au changement de variables (sinon, redéploiement manuel).
2. Vérifier le mode actif :

   ```
   GET https://<domaine>/api/health   →   "storage":"r2"
   ```

3. Test fonctionnel de bout en bout : **Comptabilité → Capture IA**, scanner une
   pièce, valider l'écriture, puis rouvrir la pièce depuis l'écriture. Si elle
   s'affiche, l'écriture ET la relecture R2 fonctionnent.
4. (Optionnel) Vérifier dans le bucket R2 qu'un objet `…/<uuid>.pdf` est apparu.

## 8. Étape 5 (optionnelle) — Reprise des pièces déjà en base

La bascule ne déplace **pas** les pièces déjà stockées en base : elles restent
lues depuis `document_blobs` (aucune perte). Migrer l'existant vers R2 n'a
d'intérêt que pour **alléger la base** une fois en production avec du volume
réel. La reprise consiste à, pour chaque `documents` en `storage='db'` :

1. lire le binaire (`document_blobs.data`),
2. `putObject("<dossier>/<id>.<ext>", mime, data)`,
3. repasser la ligne en `storage='r2'` + `storage_key`,
4. (après vérification) supprimer le blob de `document_blobs`.

> Ce script (tsx, via `MIGRATION_DATABASE_URL` pour contourner la RLS et voir
> toutes les pièces, réutilisant `putObject` existant) **n'est pas encore
> écrit** — inutile en phase de test. À me demander le moment venu ; il sera
> **non destructif par défaut** (copie + repointage), la purge des blobs base
> derrière un drapeau explicite après contrôle.

## 9. Contrôles de sécurité

- **Aucune règle de cycle de vie (lifecycle / expiration)** sur le bucket :
  c'est le seul endroit qui pourrait introduire une durée de rétention. Les
  pièces comptables se conservent 10 ans (OHADA).
- Bucket **non public** : la diffusion passe par l'API Nova (contrôle d'accès +
  RLS par dossier). Ne pas activer de domaine public R2.
- Token **limité au bucket**, en lecture/écriture seulement (pas d'admin).

## 10. Rollback — attention

- **Avant qu'aucune pièce ne soit écrite dans R2** : retirer les 4 variables
  suffit, retour propre en mode `db`.
- **Après** : les pièces créées en mode R2 ont `storage='r2'`. Si on retire les
  variables, leur relecture échoue (plus de credentials). **Ne pas retirer les
  variables R2 une fois des pièces stockées dedans** — les garder, ou d'abord
  rapatrier ces pièces en base (opération inverse de l'étape 5). La bascule
  `db → r2` est donc à considérer comme **peu réversible** en pratique : la
  faire une fois, proprement.

## 11. Coûts (ordre de grandeur, palier R2)

- Stockage : ~0,015 $/Go/mois. **Sortie (egress) : gratuite** (l'atout R2).
- Opérations : facturées par million (négligeable à l'échelle d'un cabinet).
- 10 Go de stockage + les requêtes usuelles restent dans le palier gratuit.

---

Voir aussi [DEPLOIEMENT.md](DEPLOIEMENT.md). Implémentation : `server/storage/provider.ts`
(SigV4 + `putObject`/`getObject`) et `server/domain/documents.ts` (choix du mode
par pièce, relecture).
