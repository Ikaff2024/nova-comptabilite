import type { Client } from '../db.js';
import { postEntry, createJournal } from './accounting.js';
import { creditScore } from './scoring.js';

// ============================================================================
// Finance embarquée : demandes d'avance de trésorerie.
// demande -> décision (accord/refus) -> décaissement (521/561) -> remboursement
// (561 + intérêts 671 / 521). Écritures réelles via postEntry.
// ============================================================================

const round2 = (n: number) => Math.round(n * 100) / 100;

async function odJournal(c: Client, dossierId: string): Promise<string> {
  const { rows } = await c.query("select id from journals where dossier_id=$1 and (type='banque' or code='BQ') limit 1", [dossierId]);
  return rows[0]?.id ?? await createJournal(c, dossierId, 'BQ', 'Banque', 'banque');
}
async function fyForDate(c: Client, dossierId: string, date: string): Promise<string | null> {
  const { rows } = await c.query("select id from fiscal_years where dossier_id=$1 and $2 between start_date and end_date order by start_date limit 1", [dossierId, date]);
  return rows[0]?.id ?? null;
}

export async function listRequests(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select id, amount, score, rating, status, note,
            disbursed_amount, repaid_amount,
            to_char(requested_at,'YYYY-MM-DD') as requested_at,
            to_char(disbursed_at,'YYYY-MM-DD') as disbursed_at
       from financing_requests where dossier_id=$1 order by requested_at desc`, [dossierId]);
  return rows.map((r: any) => ({
    id: r.id, amount: Number(r.amount), score: r.score, rating: r.rating, status: r.status, note: r.note,
    disbursedAmount: Number(r.disbursed_amount), repaidAmount: Number(r.repaid_amount),
    outstanding: round2(Number(r.disbursed_amount) - Number(r.repaid_amount)),
    requestedAt: r.requested_at, disbursedAt: r.disbursed_at,
  }));
}

export async function requestAdvance(c: Client, dossierId: string, amount: number): Promise<{ id: string }> {
  const sc = await creditScore(c, dossierId);
  if (!sc.financing.eligible) throw new Error(sc.financing.note);
  const amt = round2(Number(amount) || 0);
  if (amt <= 0) throw new Error('Montant invalide.');
  if (amt > sc.financing.amount) throw new Error(`Montant supérieur au plafond indicatif (${sc.financing.amount.toLocaleString('fr-FR')}).`);
  const { rows: pend } = await c.query("select 1 from financing_requests where dossier_id=$1 and status in ('requested','approved','disbursed') limit 1", [dossierId]);
  if (pend[0]) throw new Error('Une demande est déjà en cours (ou une avance non remboursée).');
  const { rows } = await c.query(
    `insert into financing_requests(dossier_id, amount, score, rating, status, requested_by)
     values ($1,$2,$3,$4,'requested', app_current_user_id()) returning id`,
    [dossierId, amt, sc.score, sc.rating]);
  return { id: rows[0].id };
}

export async function decideRequest(c: Client, dossierId: string, id: string, approve: boolean, note?: string): Promise<void> {
  const { rows } = await c.query('select status from financing_requests where dossier_id=$1 and id=$2', [dossierId, id]);
  if (!rows[0]) throw new Error('Demande introuvable.');
  if (rows[0].status !== 'requested') throw new Error('Seule une demande en attente peut être décidée.');
  await c.query("update financing_requests set status=$3, note=$4, decided_at=now() where dossier_id=$1 and id=$2",
    [dossierId, id, approve ? 'approved' : 'rejected', note ?? null]);
}

// Décaissement : Débit banque / Crédit 561 (crédit de trésorerie).
export async function disburse(c: Client, dossierId: string, id: string, date: string, bankAccount = '521'): Promise<{ entryId: string }> {
  const { rows } = await c.query('select amount, status from financing_requests where dossier_id=$1 and id=$2', [dossierId, id]);
  const r = rows[0];
  if (!r) throw new Error('Demande introuvable.');
  if (r.status !== 'approved') throw new Error("La demande doit être approuvée avant décaissement.");
  const fyId = await fyForDate(c, dossierId, date);
  if (!fyId) throw new Error(`Aucun exercice ne couvre le ${date}.`);
  const amount = Number(r.amount);
  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fyId, journalId: await odJournal(c, dossierId), entryDate: date,
    description: `Avance de trésorerie reçue`, source: 'manual',
    lines: [
      { accountCode: bankAccount, debit: amount, paymentChannel: 'bank', label: 'Avance de trésorerie' },
      { accountCode: '561', credit: amount, label: 'Crédit de trésorerie' },
    ],
  });
  await c.query("update financing_requests set status='disbursed', disbursement_entry_id=$3, disbursed_amount=$4, disbursed_at=now() where dossier_id=$1 and id=$2",
    [dossierId, id, entryId, amount]);
  return { entryId };
}

// Remboursement : Débit 561 (principal) + Débit 671 (intérêts) / Crédit banque.
export async function repay(c: Client, dossierId: string, id: string, date: string, amount: number, interest = 0, bankAccount = '521'): Promise<{ entryId: string; fullyRepaid: boolean }> {
  const { rows } = await c.query('select status, disbursed_amount, repaid_amount from financing_requests where dossier_id=$1 and id=$2', [dossierId, id]);
  const r = rows[0];
  if (!r) throw new Error('Demande introuvable.');
  if (r.status !== 'disbursed') throw new Error('Seule une avance décaissée se rembourse.');
  const principal = round2(Number(amount) || 0);
  const intr = round2(Number(interest) || 0);
  if (principal <= 0) throw new Error('Montant de remboursement invalide.');
  const outstanding = round2(Number(r.disbursed_amount) - Number(r.repaid_amount));
  if (principal > outstanding + 0.005) throw new Error(`Le principal dépasse le restant dû (${outstanding.toLocaleString('fr-FR')}).`);
  const fyId = await fyForDate(c, dossierId, date);
  if (!fyId) throw new Error(`Aucun exercice ne couvre le ${date}.`);

  const lines: any[] = [{ accountCode: '561', debit: principal, label: 'Remboursement avance' }];
  if (intr > 0) lines.push({ accountCode: '671', debit: intr, label: 'Intérêts sur avance' });
  lines.push({ accountCode: bankAccount, credit: round2(principal + intr), paymentChannel: 'bank', label: 'Remboursement avance' });

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fyId, journalId: await odJournal(c, dossierId), entryDate: date,
    description: `Remboursement avance de trésorerie${intr > 0 ? ' (avec intérêts)' : ''}`, source: 'manual', lines,
  });
  const newRepaid = round2(Number(r.repaid_amount) + principal);
  const fullyRepaid = newRepaid >= round2(Number(r.disbursed_amount)) - 0.005;
  await c.query("update financing_requests set repaid_amount=$3, status=$4 where dossier_id=$1 and id=$2",
    [dossierId, id, newRepaid, fullyRepaid ? 'repaid' : 'disbursed']);
  return { entryId, fullyRepaid };
}
