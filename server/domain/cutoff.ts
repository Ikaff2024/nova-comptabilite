import type { Client } from '../db.js';
import { postEntry, createJournal, listFiscalYears } from './accounting.js';

// ============================================================================
// Régularisations de cut-off (rattachement à l'exercice) : CCA, PCA, FNP, FAE.
// Poste l'écriture de régularisation, et (optionnel) son extourne à l'ouverture
// de l'exercice suivant.
// ============================================================================

export type CutoffType = 'CCA' | 'PCA' | 'FNP' | 'FAE';

// Pour chaque type : compte de régularisation + sens de l'écriture initiale.
// debit/credit désignent quel compte est débité/crédité (l'autre est le compte 6x/7x).
const DEF: Record<CutoffType, { label: string; debit: (a: string) => string; credit: (a: string) => string }> = {
  CCA: { label: "Charge constatée d'avance", debit: () => '476', credit: (a) => a },        // 476 D / 6x C
  PCA: { label: "Produit constaté d'avance", debit: (a) => a, credit: () => '477' },         // 7x D / 477 C
  FNP: { label: 'Facture non parvenue', debit: (a) => a, credit: () => '408' },              // 6x D / 408 C
  FAE: { label: 'Facture à établir', debit: () => '418', credit: (a) => a },                 // 418 D / 7x C
};

async function odJournal(c: Client, dossierId: string): Promise<string> {
  const { rows } = await c.query("select id from journals where dossier_id=$1 and type='operations_diverses' limit 1", [dossierId]);
  return rows[0]?.id ?? await createJournal(c, dossierId, 'OD', 'Opérations diverses', 'operations_diverses');
}

async function fyForDate(c: Client, dossierId: string, date: string): Promise<any | null> {
  const { rows } = await c.query('select * from fiscal_years where dossier_id=$1 and $2 between start_date and end_date order by start_date limit 1', [dossierId, date]);
  return rows[0] ?? null;
}

export interface CutoffInput {
  type: CutoffType;
  date: string;
  accountCode: string;   // compte de charge (6x) ou produit (7x) concerné
  amount: number;
  label: string;
  autoReverse?: boolean; // extourne à l'ouverture de l'exercice suivant
}

export async function postCutoff(c: Client, dossierId: string, input: CutoffInput): Promise<{ entryId: string; reversalId: string | null }> {
  const def = DEF[input.type];
  if (!def) throw new Error('Type de régularisation inconnu.');
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!(amount > 0)) throw new Error('Montant invalide.');
  if (!input.label?.trim()) throw new Error('Libellé requis.');
  const debitAcc = def.debit(input.accountCode), creditAcc = def.credit(input.accountCode);
  for (const code of [debitAcc, creditAcc]) {
    const { rows } = await c.query('select 1 from accounts where dossier_id=$1 and account_code=$2', [dossierId, code]);
    if (!rows[0]) throw new Error(`Compte ${code} introuvable dans le plan.`);
  }

  const fy = await fyForDate(c, dossierId, input.date);
  if (!fy) throw new Error(`Aucun exercice ne couvre le ${input.date}.`);
  const journalId = await odJournal(c, dossierId);
  const desc = `${def.label} — ${input.label.trim()}`;

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy.id, journalId, entryDate: input.date, description: desc, source: 'manual',
    lines: [
      { accountCode: debitAcc, debit: amount, label: input.label.trim() },
      { accountCode: creditAcc, credit: amount, label: input.label.trim() },
    ],
  });

  let reversalId: string | null = null;
  if (input.autoReverse) {
    const fys = await listFiscalYears(c, dossierId);
    const nextYear = new Date(fy.start_date).getUTCFullYear() + 1;
    const next = fys.find((f: any) => new Date(f.start_date).getUTCFullYear() === nextYear && f.status !== 'closed');
    if (next) {
      const nextStart = new Date(next.start_date).toISOString().slice(0, 10);
      const r = await postEntry(c, {
        dossierId, fiscalYearId: next.id, journalId, entryDate: nextStart, description: `Extourne — ${desc}`, source: 'manual',
        lines: [
          { accountCode: creditAcc, debit: amount, label: `Extourne ${input.label.trim()}` },
          { accountCode: debitAcc, credit: amount, label: `Extourne ${input.label.trim()}` },
        ],
      });
      reversalId = r.id;
    }
  }
  return { entryId, reversalId };
}
