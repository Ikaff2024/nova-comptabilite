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
   | `JWT_SECRET` | une longue chaîne aléatoire |
   | `AI_PROVIDER` | `claude` ou `gemini` |
   | `ANTHROPIC_API_KEY` *ou* `GEMINI_API_KEY` | ta clé |
   | (optionnel) `CLAUDE_MODEL` / `GEMINI_MODEL` | sinon défauts |

   `PORT` est fourni par Railway. `NODE_ENV=production` et `SERVE_STATIC=true` sont déjà dans le Dockerfile.
4. **Deploy** → Railway expose une URL publique (`https://…up.railway.app`). Ouvre-la : login → onboarding → dashboard.

## 3. Vérification

- `GET https://<ton-url>/api/health` doit répondre `{"ok":true,"db":true,...}`.
- L'app se charge (front servi par le même service, `/api` en même origine).

## Notes

- **CI** : chaque push sur `main` rejoue migrations + tests (`.github/workflows/ci.yml`).
- **Migrations futures** : ajoute un fichier dans `supabase/migrations/`, puis `npm run migrate` sur Neon (ou étape de release).
- **Secrets** : ne jamais commiter `.env.local` (déjà ignoré). En prod, tout passe par les variables Railway.
- **Coûts** : Neon et Railway ont des paliers gratuits/à faible coût adaptés à un pilote.
