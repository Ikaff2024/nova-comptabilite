import type { Client } from '../db.js';
import { postEntry, createJournal, type EntryLineInput } from '../domain/accounting.js';
import type { PayrollResult } from './core/index.js';

// ============================================================================
// Pont comptable de la paie : transforme les résultats de paie du moteur
// (PayrollResult, par salarié) en UNE écriture d'OD de paie SYSCOHADA, agrégée
// sur la période. C'est l'apport propre de Nova : la paie alimente la compta.
//
//   Débit  661  Rémunérations directes (brut total)
//   Débit  664  Charges sociales patronales (CNPS employeur)
//   Débit  6413 Taxes sur salaires patronales (apprentissage + formation)
//   Crédit 422  Personnel, rémunérations dues (net à payer)
//   Crédit 431  Sécurité sociale (CNPS salarial + patronal + CMU)
//   Crédit 447  État, impôts retenus (ITS + CN + IGR + taxes patronales)
//   Crédit 421  Personnel, avances et acomptes (acompte + remb. avance + retenues)
//
// Identité vérifiée : net = brut − retenues salariales et coût employeur =
// brut + charges patronales ⇒ Σdébit = Σcrédit (équilibre garanti).
// ============================================================================

const ACC = {
  salaires: '661', chargesSoc: '664', taxesSal: '6413',
  net: '422', cnps: '431', etat: '447', avances: '421',
};

const r2 = (n: number) => Math.round(n);

// Construit les lignes d'écriture agrégées d'une paie (plusieurs salariés).
export function buildPayrollEntryLines(results: PayrollResult[], periodLabel: string): EntryLineInput[] {
  const sum = (f: (r: PayrollResult) => number) => r2(results.reduce((s, r) => s + (f(r) || 0), 0));

  const brut = sum((r) => r.salaireBrutTotal);
  const cnpsPat = sum((r) => r.cnpsFamille + r.cnpsAccident + r.cnpsRetraitePatronal);
  const taxesPat = sum((r) => r.taxeApprentissage + r.formationContinue);
  const net = sum((r) => r.salaireNetPaye);
  const cnpsTotal = sum((r) => r.cnpsSalarial + r.cnpsFamille + r.cnpsAccident + r.cnpsRetraitePatronal + r.cmuSalarial);
  const etatTotal = sum((r) => r.itsSalarial + r.cnSalarial + r.igrSalarial + r.taxeApprentissage + r.formationContinue);
  const avances = sum((r) => r.acompte + r.remboursementAvance + r.retenuesDiverses);

  const lines: EntryLineInput[] = [];
  if (brut) lines.push({ accountCode: ACC.salaires, debit: brut, label: `Rémunérations ${periodLabel}` });
  if (cnpsPat) lines.push({ accountCode: ACC.chargesSoc, debit: cnpsPat, label: `Charges sociales patronales ${periodLabel}` });
  if (taxesPat) lines.push({ accountCode: ACC.taxesSal, debit: taxesPat, label: `Taxes sur salaires ${periodLabel}` });
  if (net) lines.push({ accountCode: ACC.net, credit: net, label: `Net à payer ${periodLabel}` });
  if (cnpsTotal) lines.push({ accountCode: ACC.cnps, credit: cnpsTotal, label: `CNPS + CMU ${periodLabel}` });
  if (etatTotal) lines.push({ accountCode: ACC.etat, credit: etatTotal, label: `Impôts sur salaires ${periodLabel}` });
  if (avances) lines.push({ accountCode: ACC.avances, credit: avances, label: `Avances/retenues ${periodLabel}` });
  return lines;
}

async function odJournalId(c: Client, dossierId: string): Promise<string> {
  const { rows } = await c.query("select id from journals where dossier_id=$1 and type='operations_diverses' limit 1", [dossierId]);
  return rows[0]?.id ?? await createJournal(c, dossierId, 'OD', 'Opérations diverses', 'operations_diverses');
}

// Comptabilise l'OD de paie de la période (journal OD, exercice couvrant la date).
export async function postPayrollEntry(
  c: Client, dossierId: string, opts: { entryDate: string; periodLabel: string; results: PayrollResult[] },
): Promise<{ entryId: string; totalBrut: number; totalNet: number; totalCoutEmployeur: number }> {
  if (!opts.results?.length) throw new Error('Aucun bulletin à comptabiliser.');
  const lines = buildPayrollEntryLines(opts.results, opts.periodLabel);
  const d = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(d - cr) > 1) throw new Error(`OD de paie déséquilibrée (débit ${d} ≠ crédit ${cr}).`);

  const { rows: fy } = await c.query(
    "select id from fiscal_years where dossier_id=$1 and status<>'closed' and $2 between start_date and end_date order by start_date limit 1",
    [dossierId, opts.entryDate]);
  if (!fy[0]) throw new Error(`Aucun exercice ouvert ne couvre le ${opts.entryDate}.`);

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy[0].id, journalId: await odJournalId(c, dossierId), entryDate: opts.entryDate,
    description: `Paie — ${opts.periodLabel}`, source: 'manual', lines,
  });
  return {
    entryId,
    totalBrut: r2(opts.results.reduce((s, r) => s + r.salaireBrutTotal, 0)),
    totalNet: r2(opts.results.reduce((s, r) => s + r.salaireNetPaye, 0)),
    totalCoutEmployeur: r2(opts.results.reduce((s, r) => s + r.totalCoutEmployeur, 0)),
  };
}
