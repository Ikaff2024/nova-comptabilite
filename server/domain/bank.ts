import type { Client } from '../db.js';

// ============================================================================
// Rapprochement bancaire : pointage des écritures d'un compte de trésorerie
// (classe 5) contre le relevé. État de rapprochement = solde pointé vs relevé.
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
