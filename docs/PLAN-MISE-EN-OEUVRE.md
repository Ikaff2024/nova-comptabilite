# Nova Comptabilité — Plan de mise en œuvre (vision CTO)

> Document stratégique & d'architecture. Cible : espace OHADA (17 États, SYSCOHADA révisé / AUDCIF).
> Statut du repo : prototype React/Vite/Tailwind + Gemini (mock). Aucun moteur comptable encore.

> ## ✅ Décisions actées (2026-06-29)
> - **Segment MVP : cabinets d'expertise comptable** → on construit le mode multi-dossiers en premier (wedge de distribution).
> - **Pays pilote : Côte d'Ivoire** (XOF, FNE opérationnel) pour conformité facture normalisée + DSF.
> - **Finance embarquée : pivot stratégique** → la donnée est structurée dès la Phase 0 pour le scoring/crédit ; le SaaS est l'aimant, la finance est la marge.

---

## 1. Thèse : où est la disruption ?

Le marché comptable OHADA est dominé par **Sage Saari / Sage 100** (desktop, licence, cher, mono-poste, peu mis à jour côté fiscalité locale) et par des tableurs Excel pour 80 % des PME/TPE. Les nouveaux entrants (Odoo, quelques SaaS locaux) restent des *clones de logiciels occidentaux* mal adaptés au terrain.

**La disruption ne vient PAS d'« un Sage en mieux ». Elle vient de 4 ruptures structurelles propres à l'Afrique francophone :**

1. **AI-native, pas AI-bolt-on.** La saisie comptable est le coût n°1 de la PME africaine (manque d'experts, informel). Nova *génère* l'écriture à partir de la pièce (reçu photo, relevé bancaire, SMS Mobile Money), mappée automatiquement au plan SYSCOHADA. L'humain valide, ne saisit pas.
2. **Mobile Money first.** 60-70 % des flux des PME passent par Orange Money / MTN MoMo / Wave / Moov — pas par la banque. Aucun incumbent ne réconcilie nativement le Mobile Money. C'est notre cheval de Troie.
3. **Conformité fiscale « branchée » par pays.** La **facture normalisée électronique** se déploie partout (FNE Côte d'Ivoire, MECeF/e-mcf Bénin, SEN au Sénégal, e-Tax Togo…). Nova s'y connecte nativement et génère la **DSF/liasse fiscale** par pays automatiquement. C'est le *moat* réglementaire.
4. **Embedded finance.** Une fois qu'on tient la donnée comptable temps réel et certifiée d'une PME, on devient la porte d'entrée du **crédit / scoring / BNPL** (le vrai business model, façon Brex/Ramp pour l'OHADA). Le logiciel est l'aimant ; la finance est la marge.

**Positionnement en une phrase :** *« Le copilote comptable et financier des PME et cabinets d'Afrique francophone : la conformité SYSCOHADA et fiscale en automatique, le Mobile Money réconcilié, et l'accès au financement en un clic. »*

---

## 2. Cibles (ICP) et séquencement

| Segment | Douleur | Pourquoi nous | Phase |
|---|---|---|---|
| **TPE / informel en formalisation** | Pas de comptable, SMT, peur du fisc | Saisie par photo + SMT auto + facture normalisée | V1 |
| **PME (système normal)** | Saisie lourde, DSF douloureuse, Sage cher | Automatisation IA + DSF + multi-utilisateurs | V1–V2 |
| **Cabinets d'expertise comptable** | 1 expert gère 80 dossiers à la main | Mode multi-dossiers, collaboration client↔cabinet, abattement de 80 % de la saisie | **Wedge GTM** (priorité) |
| **Filiales de groupes / ETI** | Consolidation multi-pays XOF/XAF | Multi-entités, multi-devises, conso | V3 |

> **Go-to-market = les cabinets d'abord.** Un cabinet apporte 50–200 PME. C'est le canal de distribution le moins cher et le plus crédible (l'expert-comptable est le prescripteur de confiance en OHADA).

---

## 3. Architecture fonctionnelle (modules)

```
┌─────────────────────────────────────────────────────────────┐
│  COUCHE IA / AGENT  (capture, catégorisation, copilote, anomalies) │
├─────────────────────────────────────────────────────────────┤
│  Capture     │  Comptabilité   │  Conformité     │  Finance   │
│  - OCR pièces│  - Ledger double│  - Facture norm.│  - Scoring │
│  - Import    │    entrée       │    e-invoicing  │  - Crédit  │
│    relevés   │  - Plan SYSCOHADA│  - DSF/liasse  │  - Paie-   │
│  - Connect.  │  - Journaux,    │    par pays     │    ments   │
│    Mobile $  │    GL, balance  │  - TVA/retenues │    sortants│
│  - Banques   │  - États fin.   │  - Déclarations │            │
│              │    (Bilan, CR,  │                 │            │
│              │    TFT, notes)  │                 │            │
├─────────────────────────────────────────────────────────────┤
│  NOYAU : Grand Livre double-entrée immuable (event-sourced)   │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Le noyau : le *ledger* (non négociable)
- **Comptabilité en partie double, immuable, en append-only** (event sourcing). Aucune écriture validée n'est modifiée → on contre-passe. Exigence d'audit AUDCIF + futur contrôle fiscal.
- Plan comptable **SYSCOHADA révisé** versionné (classes 1 à 8 + 9 analytique), personnalisable par entité, avec mapping vers le plan de chaque pays.
- Support **Système Normal** ET **Système Minimal de Trésorerie (SMT)** pour les petites entités.
- **Multi-devises XOF / XAF / GNF / CDF / KMF** + EUR/USD, taux et écarts de conversion.
- Multi-entités / multi-exercices / clôture & à-nouveaux automatiques.
- Génération native : **Journaux, Grand Livre, Balance, Bilan, Compte de résultat, Tableau des Flux de Trésorerie, Notes annexes** au format AUDCIF.

### 3.2 Capture (le différenciateur de volume)
- OCR + LLM multimodal : photo de reçu / facture → écriture proposée (fournisseur, TVA, compte de charge SYSCOHADA, axe analytique).
- Import relevés bancaires (PDF/CSV/OFX) + **connecteurs Mobile Money** (Orange Money, MTN MoMo, Wave, Moov) et agrégateurs (ex. type Julaya / paiements B2B).
- Parsing **SMS de transaction Mobile Money** (offline, sur device) → file d'écritures à valider.

### 3.3 Conformité (le *moat*)
- **Moteur de règles fiscales par pays** (TVA 18 %, retenues à la source, IS, patente, droit de timbre…), versionné, piloté par données (pas par code en dur).
- **Connecteurs e-invoicing** : abstraction unifiée au-dessus de FNE (CI), MECeF/e-mcf (Bénin), etc. → une seule API interne `IssueCertifiedInvoice(country)`.
- Génération **DSF / liasse fiscale** et télédéclarations par pays.

### 3.4 Finance embarquée (la marge, phase 2+)
- Scoring crédit basé sur la donnée comptable certifiée (cash-flow réel, ancienneté clients, régularité Mobile Money).
- Paiements sortants (fournisseurs, salaires, impôts) via Mobile Money / virements.
- Avances de trésorerie / BNPL B2B en partenariat avec banques & fintechs (on est l'originateur de données, pas le bilan au début).

---

## 4. Architecture technique

**Principe directeur : *offline-first*, *multi-tenant*, *AI-native*, *compliance-as-data*.**

| Couche | Choix | Justification |
|---|---|---|
| **Frontend** | Garder React 19 + Vite + Tailwind, mais en **PWA offline-first** | Connectivité intermittente = exigence #1 terrain. App installable, fonctionne sans réseau, sync différée. |
| **Sync/offline** | Moteur local (IndexedDB) + CRDT/queue de sync vers le serveur | La saisie ne doit jamais bloquer sur le réseau. |
| **Backend** | **Postgres** (Supabase pour démarrer : Auth, RLS multi-tenant, Edge Functions, Storage) → migrable vers service dédié | Postgres = transactions ACID indispensables au ledger. RLS = isolation tenant par défaut. MCP Supabase déjà dispo dans cet environnement. |
| **Ledger** | Tables append-only + contraintes d'équilibre débit=crédit en base, partitionnées par tenant/exercice | Intégrité comptable garantie au niveau base, pas applicatif. |
| **Multi-tenant** | 1 schéma/organisation logique via `org_id` + RLS strict ; isolation renforcée pour cabinets | Sécurité + simplicité opérationnelle au démarrage. |
| **Couche IA** | LLM multimodal (capture/copilote) + petits modèles spécialisés (catégorisation) ; **garde-fous : l'IA propose, le ledger valide** | Jamais d'écriture comptable sans contrôle déterministe (équilibre, compte existant, période ouverte). |
| **Compliance engine** | Règles **en données versionnées** (JSON/DSL), pas en `if/else` codés | 17 pays × règles qui changent chaque loi de finances → impossible à maintenir en dur. |
| **Résidence données** | Hébergement avec présence régionale + chiffrement ; conformité protection des données (ex. Loi 2013 CI, lois CDP/ARTCI locales) | Argument de vente public/grands comptes + exigence réglementaire montante. |
| **Sécurité** | Chiffrement au repos/transit, audit log immuable, MFA, RBAC fin (cabinet vs client vs collaborateur) | Donnée financière + futur produit crédit. |

> ⚠️ **Décision d'architecture à acter tôt :** le moteur comptable (ledger + conformité) doit être un **service/domaine isolé et testé en propre**, indépendant de l'UI Gemini actuelle. Le prototype actuel devient la *coquille UI*, pas le cœur.

---

## 5. Roadmap par phases

### Phase 0 — Fondations (semaines 1–6)
- Décider backend (recommandation : Supabase/Postgres) + modèle de données du ledger.
- Implémenter le **noyau double-entrée** : comptes, journaux, écritures équilibrées, balance, grand livre. Tests automatisés du domaine comptable (golden cases SYSCOHADA).
- Importer le **plan comptable SYSCOHADA révisé** complet + 1 pays pilote (**Côte d'Ivoire**, marché XOF le plus gros, FNE actif).
- Remplacer les mocks (`data.ts`) par données réelles persistées.

### Phase 1 — MVP « saisie augmentée » (mois 2–4) → pilote cabinets
- Capture par photo/OCR → écriture proposée → validation.
- Import relevés + 1 connecteur Mobile Money (Wave ou Orange Money CI).
- États financiers AUDCIF générés (Bilan, CR, balance, GL).
- Mode **cabinet multi-dossiers** (le wedge GTM). 
- **Objectif :** 5–10 cabinets pilotes en Côte d'Ivoire, mesurer le % de saisie automatisée.

### Phase 2 — Conformité & expansion (mois 4–8)
- Connecteur **facture normalisée FNE** + génération **DSF Côte d'Ivoire**.
- Moteur de règles fiscales (TVA, retenues) + déclarations.
- Ajout **2e pays** (Sénégal ou Bénin) pour prouver la scalabilité du compliance-as-data.
- SMT pour TPE.

### Phase 3 — Finance embarquée & échelle (mois 8–18)
- Scoring + premiers partenariats crédit/avance de trésorerie.
- Paiements sortants (fournisseurs/impôts/salaires).
- Consolidation multi-entités, multi-devises XOF/XAF.
- Couverture de 4–6 pays OHADA.

---

## 6. Business model & GTM
- **SaaS par abonnement** (par dossier/entité), tiering TPE / PME / Cabinet.
- **Revenu cabinet** = par dossier géré (le cabinet revend ou refacture).
- **Take-rate finance** (phase 3) : commission sur crédit/paiements — la vraie marge.
- **Distribution :** cabinets d'expertise comptable d'abord → effet de levier ; puis acquisition directe PME via Mobile Money & bouche-à-oreille.
- **Pricing en monnaie locale**, paiement par Mobile Money (un incumbent qui facture en EUR par CB se coupe 90 % du marché).

---

## 7. Risques & mitigations
| Risque | Mitigation |
|---|---|
| Fragmentation réglementaire 17 pays | Compliance-as-data + 1 pays à la fois, pas de big bang |
| APIs e-invoicing/Mobile Money instables ou fermées | Couche d'abstraction + fallback manuel ; partenariats officiels |
| Confiance (donnée financière sensible) | Caution des experts-comptables (prescripteurs) + résidence données locale |
| Connectivité | Offline-first dès le MVP, non rétrofité |
| Exactitude IA | L'IA propose, le ledger déterministe valide ; jamais d'auto-validation comptable |
| Concurrence Sage qui se réveille | Vitesse + Mobile Money + finance embarquée (terrains où Sage ne va pas) |

## 8. KPIs produit
- **% d'écritures auto-générées** (vs saisie manuelle) — métrique-reine.
- Temps de production d'une DSF (objectif : jours → minutes).
- Nb de dossiers par collaborateur de cabinet (objectif : ×3).
- Taux de réconciliation Mobile Money automatique.
- Volume de transactions certifiées → base du produit crédit.

## 9. Équipe minimale
- 1 CTO/lead + 1 ingénieur domaine (ledger/compliance) **avec expertise SYSCOHADA**, 1 fullstack PWA, 1 ingénieur IA/data, 1 expert-comptable OHADA *in-house* (garant de conformité), 1 GTM/partenariats cabinets.

---

## 10. Prochaines étapes concrètes (cette semaine)
1. **Acter le backend** (Supabase/Postgres recommandé) et figer le **schéma du ledger double-entrée**.
2. Sourcer le **plan comptable SYSCOHADA révisé** complet (données de référence).
3. Choisir le **pays pilote** (recommandation : Côte d'Ivoire).
4. Transformer le repo : isoler un module `domain/accounting` testé, brancher l'UI existante dessus, supprimer les mocks.
5. Recruter/identifier l'**expert-comptable OHADA** garant de conformité.
