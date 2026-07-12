import { SalaryAdvance } from './types';

// Échéancier d'avance/prêt sur salaire — DÉTERMINISTE (aucun état « restant dû »
// à maintenir). Partagé front (aperçu) et backend (calcul figé) : une seule règle.

// Nombre total d'échéances (les pleines + une dernière partielle éventuelle).
function installmentCount(a: SalaryAdvance): number {
  if (a.mensualite <= 0 || a.montantTotal <= 0) return 0;
  const full = Math.floor(a.montantTotal / a.mensualite);
  const partial = a.montantTotal - full * a.mensualite;
  return full + (partial > 1e-9 ? 1 : 0);
}

// Échéance due pour un mois de paie donné (0 si hors échéancier).
export function installmentDue(a: SalaryAdvance, year: number, month: number): number {
  const count = installmentCount(a);
  if (count === 0) return 0;
  const k = (year - a.startYear) * 12 + (month - a.startMonth);
  if (k < 0 || k >= count) return 0;
  const full = Math.floor(a.montantTotal / a.mensualite);
  if (k < full) return a.mensualite;
  return Math.round((a.montantTotal - full * a.mensualite) * 100) / 100; // dernière partielle
}

// Somme des échéances dues ce mois pour un ensemble d'avances (déjà filtrées par salarié).
export function advanceDeductionForMonth(advances: SalaryAdvance[], year: number, month: number): number {
  return advances.reduce((s, a) => s + installmentDue(a, year, month), 0);
}

// Montant déjà remboursé jusqu'au mois donné (inclus) — pour l'UI.
export function advancePaidThrough(a: SalaryAdvance, year: number, month: number): number {
  const count = installmentCount(a);
  if (count === 0) return 0;
  const k = (year - a.startYear) * 12 + (month - a.startMonth);
  if (k < 0) return 0;
  const done = Math.min(k + 1, count);
  const full = Math.floor(a.montantTotal / a.mensualite);
  const paid = Math.min(done, full) * a.mensualite + (done > full ? a.montantTotal - full * a.mensualite : 0);
  return Math.min(a.montantTotal, Math.round(paid * 100) / 100);
}

// Restant dû après le mois donné.
export function advanceRemaining(a: SalaryAdvance, year: number, month: number): number {
  return Math.max(0, Math.round((a.montantTotal - advancePaidThrough(a, year, month)) * 100) / 100);
}
