# Nova Comptabilité

**Le copilote comptable et financier des PME et cabinets d'Afrique francophone (OHADA).**

Comptabilité SYSCOHADA en automatique, réconciliation Mobile Money native, et états financiers prêts à l'emploi — pensé pour les cabinets d'expertise comptable et leurs clients.

## Différenciateurs

- **IA-native** — capture d'une pièce (photo/PDF) → écriture SYSCOHADA proposée, ancrée sur le plan comptable réel du dossier, calibrée par les règles du cabinet et l'apprentissage des validations.
- **Mobile Money first** — import de relevés Wave / Orange Money / MTN / Moov → écritures pré-catégorisées, réconciliées, dédupliquées.
- **Conformité SYSCOHADA** — plan comptable révisé (1330 comptes), balance, compte de résultat, Soldes Intermédiaires de Gestion, bilan, export PDF.
- **Vue cabinet** — tableau de bord portefeuille (dossiers, résultats, alertes, % d'écritures auto-codées).

## Architecture

| Couche | Techno |
|---|---|
| Frontend | React 19 + Vite + Tailwind (PWA-ready) |
| API | Express + TypeScript (`server/`) |
| Base | PostgreSQL — **ledger double-entrée immuable**, RLS multi-tenant, host-agnostique (Railway / Neon / Supabase / local) |
| IA | Fournisseur abstrait : Claude ou Gemini (sélection par env), sans intermédiaire |

Principes : *l'IA propose, le ledger déterministe valide* · compliance-as-data · isolation par cabinet/dossier.

## Démarrage local

Voir [docs/DEV-LOCAL.md](docs/DEV-LOCAL.md).

```bash
# 1. Base Postgres (Docker) + migrations
docker run -d --name nova-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nova postgres:16-alpine
for f in supabase/migrations/2026*.sql; do docker exec -i nova-pg psql -U postgres -d nova -v ON_ERROR_STOP=1 -q < "$f"; done

# 2. Config
cp .env.example .env.local   # renseigner DATABASE_URL, JWT_SECRET, clé IA

# 3. Lancer
npm install
npm run api    # API   http://localhost:4000
npm run dev    # Front http://localhost:3000
```

## Structure

```
server/            API Express + domaine comptable
  domain/          ledger, mobile money, utilisateurs
  ai/              extraction IA (Claude/Gemini + mode démo)
  mobilemoney/     parseur de relevés
src/               front React
supabase/migrations/  schéma versionné (tenancy, ledger, intégrité, RLS, seed SYSCOHADA)
docs/              plan stratégique, guide dev
```

## Statut

MVP fonctionnel de bout en bout. Voir [docs/PLAN-MISE-EN-OEUVRE.md](docs/PLAN-MISE-EN-OEUVRE.md) pour la vision et la roadmap.
