# Déploiement — Neon (base) + Railway (application)

Architecture cible : **un seul service applicatif** (l'API Express sert aussi le front build) + **Neon** pour Postgres.

```
Navigateur ──► Railway (Nova : API /api + front statique) ──► Neon (Postgres)
```

## 1. Base de données — Neon

1. Crée un compte sur **neon.tech** → **New Project** (région **EU / Frankfurt**, la plus proche de l'Afrique de l'Ouest).
2. Récupère la **connection string** du projet (rôle propriétaire), ex. :
   `postgres://neondb_owner:xxxx@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`
3. **Applique les migrations** (depuis ton poste, une fois) :
   ```bash
   DATABASE_URL="postgres://neondb_owner:...@...neon.tech/neondb?sslmode=require" npm run migrate
   ```
   Le script crée le rôle applicatif `nova_app` (voir migration 0007) et applique tout le schéma. Il suit les migrations déjà appliquées (table `_migrations`), donc il est rejouable sans risque.
4. **Sécurise le rôle applicatif** (mot de passe de prod) via le SQL Editor Neon :
   ```sql
   alter role nova_app password 'UN_MOT_DE_PASSE_FORT';
   ```
   > Si Neon refuse la création de rôle via `migrate`, crée `nova_app` dans la console Neon (Roles) puis relance `npm run migrate`.

L'URL que l'**application** utilisera est celle du rôle **`nova_app`** (pas le propriétaire) — c'est ce qui active l'isolation RLS :
`postgres://nova_app:UN_MOT_DE_PASSE_FORT@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`

## 2. Application — Railway

1. Crée un compte **railway.app** → **New Project** → **Deploy from GitHub repo** → `Ikaff2024/nova-comptabilite`.
2. Railway détecte le **Dockerfile** et build automatiquement (front + API).
3. **Variables d'environnement** (onglet Variables) :
   | Variable | Valeur |
   |---|---|
   | `DATABASE_URL` | URL Neon du rôle **nova_app** (avec `?sslmode=require`) |
   | `MIGRATION_DATABASE_URL` | URL Neon du rôle **propriétaire** — voir encadré ci-dessous |
   | `JWT_SECRET` | une longue chaîne aléatoire (≥ 24 caractères) |
   | `AI_PROVIDER` | `claude`, `gemini` ou `openrouter` |
   | `ANTHROPIC_API_KEY` *ou* `GEMINI_API_KEY` | ta clé |
   | (optionnel) `CLAUDE_MODEL` / `GEMINI_MODEL` | sinon défauts |
   | (optionnel) `OPENROUTER_API_KEY` | active le **fallback automatique** si le fournisseur principal tombe (quota/panne) |
   | (optionnel) `OPENROUTER_MODEL` | défaut `google/gemini-2.0-flash-001` (modèle vision) |

   > **Fallback IA** : si `OPENROUTER_API_KEY` est présent et que le fournisseur principal échoue, la Capture bascule automatiquement sur OpenRouter. ⚠️ OpenRouter est un intermédiaire — activer « no logging / no training » côté OpenRouter pour les pièces sensibles.

   `PORT` est fourni par Railway. `NODE_ENV=production` et `SERVE_STATIC=true` sont déjà dans le Dockerfile.

   > ### Démarrage : `migrate → verify → start`, fail-closed
   >
   > Le conteneur exécute `npm run migrate && npm run start`. Le `&&` est
   > délibéré : **si les migrations échouent, l'API ne démarre pas**. Auparavant
   > elles étaient appliquées en « best-effort » (chaque erreur ignorée) et
   > l'API servait un schéma potentiellement incomplet — défaut NOVA-P1-08 de la
   > revue CTO 001. Sur une comptabilité, un service arrêté se voit et se
   > répare ; un verrou d'intégrité absent, non.
   >
   > Puis, **avant d'ouvrir son port**, l'API vérifie quatre choses et refuse de
   > démarrer si l'une échoue : connexion, schéma attendu (toutes les migrations
   > livrées par le code sont en base), invariants de sécurité (verrous du
   > ledger, `security_invoker` sur les vues, `FORCE ROW LEVEL SECURITY`), et
   > rôle PostgreSQL du runtime (ni superutilisateur, ni `BYPASSRLS`, ni
   > propriétaire des tables).
   >
   > **`MIGRATION_DATABASE_URL`** : le DDL exige des droits que `nova_app` n'a
   > pas — et ne doit pas avoir, c'est ce qui fait tenir l'isolation RLS. Posez
   > donc cette variable sur le rôle **propriétaire** Neon. Elle ne sert qu'aux
   > migrations ; l'API, elle, se connecte toujours via `DATABASE_URL`.
   >
   > Si vous appliquez les migrations à la main depuis votre poste (étape 1.3),
   > `MIGRATION_DATABASE_URL` reste facultative : quand le schéma est déjà à
   > jour, `npm run migrate` le constate en lecture seule et rend la main sans
   > tenter le moindre DDL. Elle devient indispensable dès qu'une migration est
   > en attente.
4. **Deploy** → Railway expose une URL publique (`https://…up.railway.app`). Ouvre-la : login → onboarding → dashboard.

## 3. Vérification

- `GET https://<ton-url>/api/health` doit répondre `{"ok":true,"db":true,...}`.
- L'app se charge (front servi par le même service, `/api` en même origine).

## Checklist de mise en production

- [ ] Projet Neon créé (région EU/Frankfurt), migrations appliquées (`npm run migrate`) — inclut immobilisations (0014), piste d'audit (0015).
- [ ] Rôle `nova_app` sécurisé (mot de passe fort) ; `DATABASE_URL` de l'app = rôle `nova_app` (RLS active).
- [ ] Variables Railway posées (`DATABASE_URL` = rôle `nova_app`, `MIGRATION_DATABASE_URL` = rôle propriétaire,
      `JWT_SECRET` long et aléatoire, `AI_PROVIDER` + clé).
- [ ] Au démarrage, les journaux portent `[startup] MIGRATIONS_OK SCHEMA_VERSION_OK SECURITY_INVARIANTS_OK DATABASE_RUNTIME_ROLE_OK`.
- [ ] Déploiement effectué ; `GET /api/health` → `{"ok":true,"db":true}`.
- [ ] Login → onboarding → dashboard OK ; `/guide.html` accessible (servi par le même service).
- [ ] Vérifier la piste d'audit (onglet **Audit** d'un dossier) après une première écriture.

> **Artefact validé en local** : en mode `SERVE_STATIC=true`, un seul process sert `/api`, le front (SPA + fallback) et `/guide.html`. C'est l'image déployée sur Railway.

## Notes

- **CI** : chaque push sur `main` rejoue migrations + tests (`.github/workflows/ci.yml`).
- **Migrations futures** : ajoute un fichier dans `supabase/migrations/`. `scripts/migrate.mjs` est
  l'**autorité unique** d'application (CI, conteneur, poste). Les deux voies parallèles d'avant —
  `scripts/migrate-boot.mjs` et la migration in-process de `server/migrate-runtime.ts`, toutes deux
  best-effort — ont été supprimées.
- **Secrets** : ne jamais commiter `.env.local` (déjà ignoré). En prod, tout passe par les variables Railway.
- **Coûts** : Neon et Railway ont des paliers gratuits/à faible coût adaptés à un pilote.
