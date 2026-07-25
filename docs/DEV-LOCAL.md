# Lancer Nova Comptabilité en local

Stack : **Postgres** (ledger) + **API Express/TypeScript** (`server/`) + **front React/Vite** (`src/`).
Tout est host-agnostique : n'importe quel Postgres (Docker, Railway, Neon, Supabase…) convient.

## 1. Base de données

Postgres jetable via Docker :

```bash
docker run -d --name nova-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nova postgres:16-alpine
```

Appliquer les migrations (dans l'ordre) :

```bash
for f in supabase/migrations/2026*.sql; do
  docker exec -i nova-pg psql -U postgres -d nova -v ON_ERROR_STOP=1 -q < "$f"
done
```

Le rôle applicatif `nova_app` (non-superuser, RLS active) est créé par la migration 0007.

## 2. API (port 4000)

```bash
export DATABASE_URL="postgres://nova_app:nova_app@localhost:5432/nova"
export JWT_SECRET="dev-nova-secret"   # secret de signature des JWT (changer en prod)
npm run api          # ou npm run api:dev (watch)
```

## 3. Front (port 3000, proxy /api -> 4000)

```bash
npm run dev
```

Ouvrir http://localhost:3000 → **inscription / connexion** → onboarding cabinet → portefeuille de dossiers → dossier (Saisie / Balance / Plan comptable).

## Tests

```bash
npm run test:domain      # parcours domaine + RLS (10 checks)
npm run test:exercices   # deux exercices + clôture : balances, tiers, encours (39 checks)
# smoke-test SQL pur :
docker exec -i nova-pg psql -U postgres -d nova < supabase/tests/smoke_test.sql
```

`test:exercices` verrouille la règle centrale des états : lecture **par exercice**
(filtre `fiscal_year_id`, à-nouveaux compris) vs lecture **cumulée** (encours non
lettré, position à date), qui doit écarter les à-nouveaux de report — sinon tout
ce qui touche au bilan double après la première clôture. Voir
`server/domain/carryforward.ts`.

## Notes

- **Auth** : email + mot de passe, **JWT HS256** (`Authorization: Bearer`). Hachage `scrypt` (natif Node), comptes en table `app_users`, login via fonctions `SECURITY DEFINER`. Code : `server/auth.ts`, `server/domain/users.ts`, migration 0008. Token stocké côté front en localStorage. Durcissement futur : rotation/refresh tokens, FK `cabinet_members.user_id → app_users.id`, vérif email.
- **Capture IA** : onglet « Capture IA » d'un dossier → photo/PDF → proposition d'écriture SYSCOHADA → vérifier → valider (passe par `postEntry`). Code : `server/ai/provider.ts` (Gemini REST, sans SDK), endpoint `POST /api/dossiers/:id/capture`. Sans `GEMINI_API_KEY`, un **mode démo** renvoie une proposition fictive pour tester le flux. Avec clé : `export GEMINI_API_KEY=...` (et option `GEMINI_MODEL`). Fournisseur abstrait → swappable vers Claude.
- **Régénérer le plan SYSCOHADA** : `node scripts/gen_seed.mjs` (lit `plan_comptable_OHADA_valide.txt`).
- Le serveur lit `DATABASE_URL` ; en prod, pointer vers le Postgres managé choisi.
