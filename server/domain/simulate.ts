import type { Client } from '../db.js';

// ============================================================================
// Simulation AVANT validation : à partir des lignes d'un brouillon d'écriture,
// calcule l'impact sur le résultat, la TVA à payer, la trésorerie et l'IS
// estimé — sans rien comptabiliser. Déterministe (dérivé du plan SYSCOHADA :
// classe = 1er chiffre du compte). Permet de visualiser l'effet d'une saisie.
// ============================================================================

export interface DraftLine { accountCode?: string; debit?: number; credit?: number }
export interface SimulationResult {
  devise: string;
  equilibre: { debit: number; credit: number; ecart: number; equilibree: boolean };
  deltaResultat: number;    // + = améliore le résultat (produits - charges)
  deltaTva: number;         // + = TVA à payer en plus
  deltaTresorerie: number;  // + = trésorerie en hausse
  deltaIsEstime: number;    // impact IS indicatif (25 %)
  details: string[];
}

const num = (v: any) => Number(v) || 0;
const TAUX_IS = 0.25; // Côte d'Ivoire — taux de droit commun (indicatif).

export async function simulateEntry(c: Client, dossierId: string, lines: DraftLine[]): Promise<SimulationResult> {
  const { rows: dr } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
  const devise = dr[0]?.base_currency ?? 'XOF';

  let debit = 0, credit = 0;
  let deltaResultat = 0, deltaTva = 0, deltaTresorerie = 0;
  for (const l of lines) {
    const code = String(l.accountCode ?? '').trim();
    const d = num(l.debit), cr = num(l.credit);
    debit += d; credit += cr;
    if (!code) continue;
    const cls = code[0];
    // Résultat : produits (7) et charges (6) contribuent tous par (crédit - débit).
    if (cls === '6' || cls === '7') deltaResultat += cr - d;
    // Trésorerie : comptes financiers (5) — débit = entrée, crédit = sortie.
    if (cls === '5') deltaTresorerie += d - cr;
    // TVA à payer : collectée (443) au crédit augmente la dette ; déductible
    // (445) au débit la diminue → dans les deux cas contribution (crédit - débit).
    if (code.startsWith('443') || code.startsWith('445')) deltaTva += cr - d;
  }

  const round = (n: number) => Math.round(n);
  deltaResultat = round(deltaResultat);
  deltaTva = round(deltaTva);
  deltaTresorerie = round(deltaTresorerie);
  const deltaIsEstime = round(deltaResultat * TAUX_IS);

  const ecart = round(debit - credit);
  const details: string[] = [];
  if (ecart !== 0) details.push(`Écriture déséquilibrée : débit ${round(debit)} ≠ crédit ${round(credit)} (écart ${ecart}).`);
  if (deltaResultat !== 0) details.push(`${deltaResultat > 0 ? 'Améliore' : 'Dégrade'} le résultat de ${Math.abs(deltaResultat)} ${devise}.`);
  if (deltaTva !== 0) details.push(`${deltaTva > 0 ? 'Augmente' : 'Diminue'} la TVA à payer de ${Math.abs(deltaTva)} ${devise}.`);
  if (deltaTresorerie !== 0) details.push(`${deltaTresorerie > 0 ? 'Augmente' : 'Diminue'} la trésorerie de ${Math.abs(deltaTresorerie)} ${devise}.`);
  if (deltaIsEstime !== 0) details.push(`Impact IS estimé (${Math.round(TAUX_IS * 100)} %) : ${deltaIsEstime > 0 ? '+' : ''}${deltaIsEstime} ${devise} (indicatif).`);

  return {
    devise,
    equilibre: { debit: round(debit), credit: round(credit), ecart, equilibree: ecart === 0 },
    deltaResultat, deltaTva, deltaTresorerie, deltaIsEstime, details,
  };
}
