import type { Client } from '../db.js';
import { financialRatios } from './ratios.js';

// ============================================================================
// Copilote budgétaire — moteurs DÉTERMINISTES (aucun montant inventé). À partir
// de l'historique comptable et d'hypothèses paramétriques, ces fonctions
// PROPOSENT un budget, comparent des scénarios et projettent les états. Lexa se
// contente de piloter ces moteurs et d'expliquer leurs résultats. Tout est
// calculé ici, en TypeScript, avec la provenance de chaque montant.
// Choix assumé : pas de nouvelles tables — tout est dérivé à la volée (les
// montants retenus se rangent dans la table `budgets` existante via l'UI).
// ============================================================================

const r0 = (n: number) => Math.round(n);
const pct = (n: number) => Math.round(n * 1000) / 10; // 0.05 -> 5.0

// Réalisé par compte (classes 6 et 7) pour un exercice donné. Produits (classe 7)
// et charges (classe 6) sont renvoyés en valeur positive.
async function realisedByAccount(c: Client, dossierId: string, fiscalYearId: string): Promise<Map<string, { label: string; classNo: number; realise: number }>> {
  const { rows } = await c.query(
    `select a.account_code, a.label, a.class_no, sum(l.amount_debit - l.amount_credit) as net
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted' and e.fiscal_year_id=$2
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
      where l.dossier_id = $1
      group by a.account_code, a.label, a.class_no`, [dossierId, fiscalYearId]);
  const map = new Map<string, { label: string; classNo: number; realise: number }>();
  for (const r of rows) {
    const realise = r.class_no === 7 ? -Number(r.net) : Number(r.net);
    map.set(r.account_code, { label: r.label, classNo: r.class_no, realise: Math.round(realise * 100) / 100 });
  }
  return map;
}

// Exercice précédant l'exercice cible (par date de début). Null si aucun.
async function priorFiscalYear(c: Client, dossierId: string, fiscalYearId: string): Promise<{ id: string; label: string } | null> {
  const { rows } = await c.query(
    `select id, label from fiscal_years
      where dossier_id=$1 and start_date < (select start_date from fiscal_years where id=$2)
      order by start_date desc limit 1`, [dossierId, fiscalYearId]);
  return rows[0] ?? null;
}

export interface BudgetAssumptions {
  growthProduits?: number;   // croissance du CA (ex. 0.05)
  inflationCharges?: number; // inflation des charges (ex. 0.03)
}

export interface GeneratedLine {
  account_code: string; label: string; classNo: number;
  base: number; taux: number; montant: number;
  provenance: { base_realise: number; annee_base: string; taux_applique: number; confiance: 'haute' | 'moyenne' | 'faible' };
}

// PHASE 2 — Génère un budget proposé à partir du réalisé de l'exercice précédent.
export async function generateBudgetFromHistory(
  c: Client, dossierId: string, fiscalYearId: string, a: BudgetAssumptions = {},
): Promise<{ priorYear: string | null; assumptions: Required<BudgetAssumptions>; lines: GeneratedLine[]; totals: { produits: number; charges: number; resultat: number }; questions: string[] }> {
  const growthProduits = Number(a.growthProduits ?? 0.05);
  const inflationCharges = Number(a.inflationCharges ?? 0.03);
  const prior = await priorFiscalYear(c, dossierId, fiscalYearId);
  const hist = prior ? await realisedByAccount(c, dossierId, prior.id) : new Map();

  const lines: GeneratedLine[] = [];
  for (const [code, r] of hist) {
    const taux = r.classNo === 7 ? growthProduits : inflationCharges;
    const montant = r0(r.realise * (1 + taux));
    if (montant === 0 && r.realise === 0) continue;
    lines.push({
      account_code: code, label: r.label, classNo: r.classNo,
      base: r0(r.realise), taux, montant,
      provenance: { base_realise: r0(r.realise), annee_base: prior?.label ?? '—', taux_applique: taux, confiance: r.realise ? 'moyenne' : 'faible' },
    });
  }
  lines.sort((x, y) => x.account_code.localeCompare(y.account_code));
  const produits = lines.filter((l) => l.classNo === 7).reduce((s, l) => s + l.montant, 0);
  const charges = lines.filter((l) => l.classNo === 6).reduce((s, l) => s + l.montant, 0);

  const questions = [
    `Prévoyez-vous une variation des prix de vente au-delà des ${pct(growthProduits)} % retenus ?`,
    'Des recrutements ou départs sont-ils prévus (impact sur les charges de personnel) ?',
    'Un investissement notable est-il envisagé (immobilisations, financement) ?',
    'Une charge exceptionnelle du dernier exercice est-elle à ne PAS reconduire ?',
  ];
  return { priorYear: prior?.label ?? null, assumptions: { growthProduits, inflationCharges }, lines, totals: { produits, charges, resultat: produits - charges }, questions };
}

// --- PHASE 3 — Scénarios -----------------------------------------------------
export interface Scenario { key: string; label: string; hypotheses: string; growthProduits: number; inflationCharges: number; }
export const SCENARIOS: Scenario[] = [
  { key: 'prudent', label: 'Prudent', hypotheses: 'Croissance faible, charges sous tension', growthProduits: 0.00, inflationCharges: 0.05 },
  { key: 'central', label: 'Central', hypotheses: 'Hypothèses les plus probables', growthProduits: 0.05, inflationCharges: 0.03 },
  { key: 'ambitieux', label: 'Ambitieux', hypotheses: 'Croissance forte, investissements accélérés', growthProduits: 0.12, inflationCharges: 0.06 },
];

// Projette produits/charges/résultat pour chaque scénario, à partir du réalisé N-1.
export async function compareScenarios(c: Client, dossierId: string, fiscalYearId: string) {
  const prior = await priorFiscalYear(c, dossierId, fiscalYearId);
  const hist = prior ? await realisedByAccount(c, dossierId, prior.id) : new Map();
  const baseProduits = [...hist.values()].filter((r) => r.classNo === 7).reduce((s, r) => s + r.realise, 0);
  const baseCharges = [...hist.values()].filter((r) => r.classNo === 6).reduce((s, r) => s + r.realise, 0);

  const scenarios = SCENARIOS.map((s) => {
    const produits = r0(baseProduits * (1 + s.growthProduits));
    const charges = r0(baseCharges * (1 + s.inflationCharges));
    const resultat = produits - charges;
    return {
      key: s.key, label: s.label, hypotheses: s.hypotheses,
      growthProduits: s.growthProduits, inflationCharges: s.inflationCharges,
      produits, charges, resultat,
      margeNette: produits ? Math.round((resultat / produits) * 1000) / 10 : null, // %
    };
  });
  return { priorYear: prior?.label ?? null, base: { produits: r0(baseProduits), charges: r0(baseCharges) }, scenarios };
}

// --- PHASE 4 — États prévisionnels + trésorerie mensuelle + stress test -------
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

// Trésorerie actuelle (classe 5) et capitaux propres (classe 1) du dossier.
async function currentPosition(c: Client, dossierId: string): Promise<{ cash: number; equity: number }> {
  const { rows } = await c.query(
    `select
       coalesce(sum(l.amount_debit - l.amount_credit) filter (where a.class_no=5),0) as cash,
       coalesce(sum(l.amount_credit - l.amount_debit) filter (where a.class_no=1),0) as equity
       from entry_lines l
       join entries e on e.id=l.entry_id and e.status='posted'
       join accounts a on a.id=l.account_id and a.class_no in (1,5)
      where l.dossier_id=$1`, [dossierId]);
  return { cash: r0(Number(rows[0]?.cash ?? 0)), equity: r0(Number(rows[0]?.equity ?? 0)) };
}

export async function provisionalStatements(
  c: Client, dossierId: string, fiscalYearId: string, scenarioKey = 'central', stress = 0,
) {
  const sc = SCENARIOS.find((s) => s.key === scenarioKey) ?? SCENARIOS[1];
  const prior = await priorFiscalYear(c, dossierId, fiscalYearId);
  const hist = prior ? await realisedByAccount(c, dossierId, prior.id) : new Map();
  const baseProduits = [...hist.values()].filter((r) => r.classNo === 7).reduce((s, r) => s + r.realise, 0);
  const baseCharges = [...hist.values()].filter((r) => r.classNo === 6).reduce((s, r) => s + r.realise, 0);

  // Choc de stress : baisse des produits et hausse des charges (ex. 0.15 = ±15 %).
  const shock = Math.min(Math.max(Number(stress) || 0, 0), 0.9);
  const produits = r0(baseProduits * (1 + sc.growthProduits) * (1 - shock));
  const charges = r0(baseCharges * (1 + sc.inflationCharges) * (1 + shock));
  const resultat = produits - charges;

  const { cash, equity } = await currentPosition(c, dossierId);

  // Compte de résultat prévisionnel (structure minimale).
  const compteResultat = { produits, charges, resultat, margeNette: produits ? Math.round((resultat / produits) * 1000) / 10 : null };

  // Budget de trésorerie mensuel : étalement linéaire (MVP), position de départ = cash actuel.
  const netMensuel = Math.round((produits - charges) / 12);
  const treso = MOIS.map((label, i) => {
    const encaiss = Math.round(produits / 12);
    const decaiss = Math.round(charges / 12);
    const fin = cash + netMensuel * (i + 1);
    return { mois: label, encaissements: encaiss, decaissements: decaiss, solde_fin: fin };
  });
  const tresorerieMini = Math.min(cash, ...treso.map((t) => t.solde_fin));

  // Indicateurs (BFR/FR/tréso nette) sur l'existant + projection du résultat sur les capitaux propres.
  let bfr: number | null = null;
  try { const fr: any = await financialRatios(c, dossierId, fiscalYearId); bfr = fr?.soldes?.bfr ?? null; } catch { /* best-effort */ }
  const bilanSimplifie = {
    capitaux_propres_actuels: equity,
    resultat_projete: resultat,
    capitaux_propres_projetes: equity + resultat,
    bfr_actuel: bfr,
    tresorerie_actuelle: cash,
    tresorerie_projetee_fin: treso[treso.length - 1]?.solde_fin ?? cash,
  };

  return {
    scenario: { key: sc.key, label: sc.label }, stress: shock, priorYear: prior?.label ?? null,
    compteResultat,
    tresorerie: { position_actuelle: cash, net_mensuel: netMensuel, mensuel: treso, tresorerie_mini: r0(tresorerieMini) },
    indicateurs: {
      marge_nette_pct: compteResultat.margeNette,
      resultat_projete: resultat,
      bfr: bfr,
      tresorerie_mini: r0(tresorerieMini),
      alerte_tresorerie: tresorerieMini < 0,
    },
    bilanSimplifie,
  };
}
