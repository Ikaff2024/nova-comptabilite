import { SavedPayslip } from './types';
import { PayrollRuleSet, resolveRuleSet } from './rules';

// =============================================================================
// Solde de tout compte (STC) — droits selon le type de rupture de contrat
// =============================================================================
// Chaque type de rupture ouvre des droits différents (préavis, indemnité de
// licenciement, indemnité de fin de CDD, congés non pris…). Les barèmes viennent
// du jeu de règles versionné (rules.ts, bloc `stc`) → traçabilité + veille.
// ⚠️ Les montants dépendent de valeurs légales/conventionnelles À ATTESTER.
// =============================================================================

export type RuptureType =
  | 'licenciement'
  | 'demission'
  | 'fin_cdd'
  | 'rupture_conventionnelle'
  | 'retraite'
  | 'faute_lourde';

export const RUPTURE_LABELS: Record<RuptureType, string> = {
  licenciement: 'Licenciement (hors faute grave/lourde)',
  demission: 'Démission',
  fin_cdd: 'Fin de CDD (terme normal)',
  rupture_conventionnelle: 'Rupture conventionnelle',
  retraite: 'Départ / mise à la retraite',
  faute_lourde: 'Faute grave ou lourde',
};

export interface STCInput {
  ruptureType: RuptureType;
  ruptureDate: string; // YYYY-MM-DD
  tenureYears: number; // ancienneté à la date de rupture
  referenceSalary: number; // salaire mensuel moyen de référence
  monthlySalary: number; // salaire mensuel courant (préavis, congés)
  joursCongesNonPris: number;
  preavisEffectue: boolean;
  categorie: string;
  cddTotalGross?: number; // total brut perçu sur le CDD (fin de CDD)
  salaireMoisDu?: number; // salaire du mois en cours restant dû
}

export interface STCLine {
  key: string;
  label: string;
  amount: number;
  note?: string;
}

export interface STCResult {
  lines: STCLine[];
  total: number;
  ruleSetVersion: string;
  ruleSetLabel: string;
}

// Coefficient d'indemnité de licenciement : somme, par tranche d'ancienneté, du
// taux × nombre d'années dans la tranche (ancienneté fractionnaire).
function licenciementCoefficient(tenure: number, bands: { uptoYear: number; rate: number }[]): number {
  let coeff = 0;
  let lower = 0;
  for (const b of bands) {
    const yearsInBand = Math.max(0, Math.min(tenure, b.uptoYear) - lower);
    coeff += yearsInBand * b.rate;
    lower = b.uptoYear;
    if (tenure <= b.uptoYear) break;
  }
  return coeff;
}

/**
 * Salaire mensuel de référence : moyenne des N derniers bulletins (brut total)
 * du salarié, à la date de rupture. À défaut d'historique, retourne 0 (l'appelant
 * peut retomber sur le salaire contractuel).
 */
export function referenceSalaryFromPayslips(
  payslips: SavedPayslip[],
  employeeId: string,
  months: number,
): number {
  const list = payslips
    .filter((p) => p.employeeId === employeeId)
    .sort((a, b) => b.year - a.year || b.month - a.month)
    .slice(0, months);
  if (list.length === 0) return 0;
  const sum = list.reduce((s, p) => s + p.calculation.salaireBrutTotal, 0);
  return Math.round(sum / list.length);
}

/**
 * Calcule le solde de tout compte selon le type de rupture. Applique la matrice
 * des droits ivoirienne (barèmes issus du RuleSet daté).
 */
export function computeSTC(input: STCInput, ruleSet?: PayrollRuleSet): STCResult {
  const [y, m] = input.ruptureDate.split('-').map(Number);
  const rules = ruleSet ?? resolveRuleSet(y || 2026, (m || 1) - 1);
  const s = rules.stc;
  const t = input.ruptureType;

  const lines: STCLine[] = [];
  const add = (key: string, label: string, amount: number, note?: string) => {
    if (amount > 0) lines.push({ key, label, amount: Math.round(amount), note });
  };

  // 1. Salaire du mois restant dû (toujours) — saisi.
  add('salaire', 'Salaire du mois (restant dû)', input.salaireMoisDu ?? 0);

  // 2. Indemnité compensatrice de congés payés (toujours, y compris faute lourde).
  const dailyConge = input.referenceSalary > 0 ? input.referenceSalary / s.congesDivisor : input.monthlySalary / s.congesDivisor;
  add('conges', 'Indemnité compensatrice de congés payés', input.joursCongesNonPris * dailyConge,
    `${input.joursCongesNonPris} j × (salaire de réf. ÷ ${s.congesDivisor})`);

  // 3. Indemnité compensatrice de préavis (si non effectué et rupture non imputable au salarié).
  const preavisMonths = s.preavisMonthsByCategory[input.categorie] ?? 1;
  const preavisApplicable = (t === 'licenciement' || t === 'retraite' || t === 'rupture_conventionnelle') && !input.preavisEffectue;
  if (preavisApplicable) {
    add('preavis', 'Indemnité compensatrice de préavis', preavisMonths * input.monthlySalary, `${preavisMonths} mois`);
  }

  // 4. Indemnité de licenciement / fin de carrière (par tranches d'ancienneté).
  const licenciementApplicable =
    (t === 'licenciement' || t === 'rupture_conventionnelle' || t === 'retraite') &&
    input.tenureYears >= s.licenciementMinTenureYears;
  if (licenciementApplicable) {
    const coeff = licenciementCoefficient(input.tenureYears, s.licenciementBands);
    const label = t === 'retraite' ? 'Indemnité de départ à la retraite' : 'Indemnité de licenciement';
    add('licenciement', label, input.referenceSalary * coeff,
      `${input.tenureYears.toFixed(1)} ans d'ancienneté`);
  }

  // 5. Indemnité de fin de CDD (6 % du brut total perçu).
  if (t === 'fin_cdd' && input.cddTotalGross) {
    add('fin_cdd', 'Indemnité de fin de CDD', input.cddTotalGross * s.cddEndRate,
      `${(s.cddEndRate * 100).toFixed(0)} % du brut total du CDD`);
  }

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return { lines, total, ruleSetVersion: rules.version, ruleSetLabel: rules.label };
}
