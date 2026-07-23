# Nova Comptabilité

**Le copilote comptable et financier des PME et cabinets d'Afrique francophone (OHADA).**

Comptabilité SYSCOHADA en automatique, réconciliation Mobile Money native, et états financiers prêts à l'emploi — pensé pour les cabinets d'expertise comptable et leurs clients.

## Différenciateurs

- **IA-native** — capture d'une ou **plusieurs pièces** (photo/PDF) en lot → écriture SYSCOHADA proposée, ancrée sur le plan comptable réel du dossier, calibrée par les règles du cabinet et l'apprentissage des validations. L'humain valide, ne saisit pas.
- **Mobile Money first** — import de relevés Wave / Orange Money / MTN / Moov → écritures pré-catégorisées, réconciliées, dédupliquées. Scan de relevés bancaires (PDF/photo) inclus.
- **Conformité SYSCOHADA** — plan comptable révisé (codes jusqu'à 8 chiffres), balance, compte de résultat, Soldes Intermédiaires de Gestion, bilan, révision, export PDF/CSV.
- **Fiscalité branchée (Côte d'Ivoire)** — facture normalisée électronique (FNE), calendrier et obligations fiscales.
- **Vue cabinet** — tableau de bord portefeuille (dossiers, résultats, alertes, % d'écritures auto-codées), coûts IA par client, console éditeur plateforme.
- **Lexa** — assistant IA conversationnel par entreprise, en lecture des données du dossier.

## Modules

| Domaine | Couverture |
|---|---|
| **Saisie** | Capture IA par lot · Mobile Money · saisie manuelle (typeahead code **ou** libellé) · import balance / grand livre |
| **Facturation** | Factures / devis / avoirs · certification FNE · **modèles de document** (vente de biens / prestation / standard) · récurrences & abonnements · catalogue |
| **Achats** | Factures fournisseurs · tiers & relances |
| **États** | Grand livre · journaux · balance · compte de résultat · SIG · bilan · révision · analytique · budget / prévisionnel · immobilisations |
| **Paie & RH** | Moteur ivoirien **CI-2024.2** (barème ITS officiel DGI) · bulletins · déclarations CNPS/DGI · **exports aux modèles officiels** (CNPS nominatif, État 301, FUDP) · solde de tout compte · congés · pointage · absences · avances |
| **Financement** | Score de santé financière · dossier de financement bancaire · finance embarquée (avance de trésorerie) |
| **Pièces** | Conservation des justificatifs (base ou Cloudflare R2), rattachés aux écritures — **sans durée de rétention** (conformité OHADA : 10 ans) |
| **Plateforme** | Multi-tenant (cabinet **ou** entreprise directe) · isolation RLS · clôtures · fiche entreprise · suppression de dossier |

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
  domain/          ledger, facturation, achats, paie, score, clôtures…
  ai/              extraction IA (Claude/Gemini + mode démo)
  payroll/         moteur de paie (portage IvoirePaie) + pont comptable + exports officiels
  mobilemoney/     parseur de relevés
  storage/         conservation des pièces (base ou Cloudflare R2)
src/               front React
supabase/migrations/  schéma versionné (tenancy, ledger, intégrité, RLS, seed SYSCOHADA)
docs/              plan stratégique, guide dev, déploiement
```

Les migrations SQL s'appliquent **au démarrage** du conteneur (via `MIGRATION_DATABASE_URL`) : tout changement de schéma passe par une nouvelle migration `supabase/migrations/`.

## Conservation des pièces justificatives

Chaque justificatif capturé est stocké et rattaché à son écriture. Deux modes selon l'environnement (variables `R2_*`) : **base** (octets en base, défaut) ou **Cloudflare R2** (recommandé en production). **Aucune purge ni durée de rétention** côté application — les pièces sont conservées indéfiniment, ce qui correspond à l'obligation OHADA (10 ans). Une pièce n'est supprimée qu'en cascade, avec son dossier.

## Statut

Fonctionnel de bout en bout, en phase de test. Voir [docs/PLAN-MISE-EN-OEUVRE.md](docs/PLAN-MISE-EN-OEUVRE.md) pour la vision et la roadmap.
