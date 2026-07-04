import type { Client } from '../db.js';
import { parseStatement, type StatementRow } from '../bank/statement.js';
import { postEntry } from './accounting.js';

// ============================================================================
// Rapprochement bancaire : pointage des écritures d'un compte de trésorerie
// (classe 5) contre le relevé. État de rapprochement = solde pointé vs relevé.
// Import de relevé + appariement assisté (montant exact, date la plus proche).
// ============================================================================

// Comptes de trésorerie (classe 5) ayant des mouvements.
export async function bankAccounts(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select a.account_code, a.label,
            count(*) as moves,
            count(*) filter (where not exists (select 1 from bank_pointings bp where bp.entry_line_id = l.id)) as unpointed
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id and a.class_no = 5
      where l.dossier_id = $1
      group by a.account_code, a.label
      order by a.account_code`,
    [dossierId],
  );
  return rows.map((r: any) => ({ account_code: r.account_code, label: r.label, moves: Number(r.moves), unpointed: Number(r.unpointed) }));
}

// Vue de rapprochement d'un compte : mouvements + flag pointé + soldes.
export async function reconciliationView(c: Client, dossierId: string, accountCode: string): Promise<any> {
  const { rows } = await c.query(
    `select l.id as entry_line_id, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date,
            j.code as journal_code, e.piece_ref, coalesce(l.label, e.description) as label,
            l.amount_debit as debit, l.amount_credit as credit,
            exists (select 1 from bank_pointings bp where bp.entry_line_id = l.id) as pointed
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id
      where l.dossier_id = $1 and a.account_code = $2
      order by e.entry_date, e.created_at`,
    [dossierId, accountCode],
  );
  const moves = rows.map((r: any) => ({
    entry_line_id: r.entry_line_id, entry_date: r.entry_date, journal_code: r.journal_code,
    piece_ref: r.piece_ref, label: r.label, debit: Number(r.debit), credit: Number(r.credit), pointed: r.pointed,
  }));
  const balance = moves.reduce((s: number, m: any) => s + m.debit - m.credit, 0);
  const pointedBalance = moves.filter((m: any) => m.pointed).reduce((s: number, m: any) => s + m.debit - m.credit, 0);
  return { balance, pointedBalance, moves };
}

// --- Import de relevé + rapprochement assisté -------------------------------

const dayDiff = (a: string, b: string) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

// Apparie les lignes du relevé aux écritures non pointées du compte (montant exact,
// date la plus proche à ±7 j). Retourne matches + reliquats des deux côtés.
export async function matchStatement(c: Client, dossierId: string, accountCode: string, csv: string) {
  const statement = parseStatement(csv);
  const { rows } = await c.query(
    `select l.id as entry_line_id, to_char(e.entry_date,'YYYY-MM-DD') as entry_date, e.piece_ref,
            coalesce(l.label, e.description) as label, l.amount_debit as debit, l.amount_credit as credit,
            exists (select 1 from bank_pointings bp where bp.entry_line_id = l.id) as pointed
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id and a.account_code = $2
      where l.dossier_id = $1
      order by e.entry_date`,
    [dossierId, accountCode],
  );
  const ledger = rows.map((r: any) => ({
    entryLineId: r.entry_line_id, date: r.entry_date, pieceRef: r.piece_ref, label: r.label, pointed: r.pointed,
    net: Math.round((Number(r.debit) - Number(r.credit)) * 100) / 100, // + entrée, − sortie (côté 521)
  }));

  const usedLedger = new Set<string>();
  const matched: any[] = [];
  const unmatchedStatement: StatementRow[] = [];
  let alreadyReconciled = 0;

  const nearestMatch = (s: StatementRow, pool: any[]) => {
    const cands = pool.filter((l) => !usedLedger.has(l.entryLineId) && Math.abs(l.net - s.amount) < 0.005);
    cands.sort((a, b) => dayDiff(a.date, s.date) - dayDiff(b.date, s.date));
    const best = cands[0];
    return best && dayDiff(best.date, s.date) <= 7 ? best : null;
  };

  for (const s of statement) {
    // 1) apparie d'abord à une écriture NON pointée -> propose le pointage
    const open = nearestMatch(s, ledger.filter((l: any) => !l.pointed));
    if (open) {
      usedLedger.add(open.entryLineId);
      matched.push({ statement: s, entryLineId: open.entryLineId, ledgerDate: open.date, pieceRef: open.pieceRef, label: open.label, amount: s.amount });
      continue;
    }
    // 2) sinon, si une écriture DÉJÀ pointée correspond -> déjà rapprochée (on ne recrée pas)
    const done = nearestMatch(s, ledger.filter((l: any) => l.pointed));
    if (done) { usedLedger.add(done.entryLineId); alreadyReconciled++; continue; }
    // 3) rien -> ligne du relevé à créer
    unmatchedStatement.push(s);
  }
  const unmatchedLedger = ledger.filter((l: any) => !l.pointed && !usedLedger.has(l.entryLineId));
  const statementBalance = statement.reduce((t, s) => t + s.amount, 0);
  return {
    matched, unmatchedStatement, unmatchedLedger,
    counts: { statement: statement.length, matched: matched.length, alreadyReconciled, unmatchedStatement: unmatchedStatement.length, unmatchedLedger: unmatchedLedger.length },
    statementFlow: Math.round(statementBalance * 100) / 100,
  };
}

// Pointe en lot une liste d'écritures (les rapprochements validés).
export async function applyPointings(c: Client, dossierId: string, entryLineIds: string[]): Promise<{ pointed: number }> {
  let n = 0;
  for (const id of entryLineIds) { await setPointing(c, dossierId, id, true); n++; }
  return { pointed: n };
}

// Crée l'écriture d'une ligne de relevé non rapprochée (banque ↔ compte de contrepartie),
// puis la pointe automatiquement.
export async function createFromStatement(
  c: Client, dossierId: string, accountCode: string, row: StatementRow, counterAccount: string,
): Promise<{ entryId: string }> {
  const { rows: fy } = await c.query(
    "select id from fiscal_years where dossier_id=$1 and status<>'closed' and $2 between start_date and end_date order by start_date limit 1",
    [dossierId, row.date]);
  if (!fy[0]) throw new Error(`Aucun exercice ouvert ne couvre le ${row.date}.`);
  const { rows: jb } = await c.query("select id from journals where dossier_id=$1 and (code='BQ' or type='banque') limit 1", [dossierId]);
  if (!jb[0]) throw new Error("Journal de banque (BQ) absent — initialisez le dossier.");

  const inflow = row.amount > 0;
  const amount = Math.abs(row.amount);
  const lines = inflow
    ? [{ accountCode, debit: amount, paymentChannel: 'bank' as const, label: row.label }, { accountCode: counterAccount, credit: amount, label: row.label }]
    : [{ accountCode: counterAccount, debit: amount, label: row.label }, { accountCode, credit: amount, paymentChannel: 'bank' as const, label: row.label }];

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy[0].id, journalId: jb[0].id, entryDate: row.date,
    description: row.label, source: 'bank_import', lines,
  });
  // pointe la ligne banque nouvellement créée
  await c.query(
    `insert into bank_pointings(dossier_id, account_id, entry_line_id)
       select l.dossier_id, l.account_id, l.id from entry_lines l
        join accounts a on a.id=l.account_id and a.account_code=$3
       where l.entry_id=$2 and l.dossier_id=$1
     on conflict (entry_line_id) do nothing`,
    [dossierId, entryId, accountCode]);
  return { entryId };
}

// Pointe / dépointe une écriture.
export async function setPointing(c: Client, dossierId: string, entryLineId: string, pointed: boolean): Promise<void> {
  if (pointed) {
    await c.query(
      `insert into bank_pointings(dossier_id, account_id, entry_line_id)
         select l.dossier_id, l.account_id, l.id from entry_lines l
          where l.id = $1 and l.dossier_id = $2
       on conflict (entry_line_id) do nothing`,
      [entryLineId, dossierId],
    );
  } else {
    await c.query('delete from bank_pointings where dossier_id = $1 and entry_line_id = $2', [dossierId, entryLineId]);
  }
}
