import type { Client } from '../db.js';

// ============================================================================
// Export FEC (Fichier des Écritures Comptables) — format tabulé standard, 18
// colonnes. Utile pour l'interopérabilité et les contrôles (audit, reprise).
// ============================================================================

const FEC_HEADER = [
  'JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate', 'CompteNum', 'CompteLib',
  'CompAuxNum', 'CompAuxLib', 'PieceRef', 'PieceDate', 'EcritureLib', 'Debit', 'Credit',
  'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise',
];

const ymd = (s: string) => (s ? s.replace(/-/g, '').slice(0, 8) : '');
const amt = (n: number) => (n ? n.toFixed(2).replace('.', ',') : '0,00');
const clean = (s: any) => String(s ?? '').replace(/[\t\r\n]/g, ' ').trim();

export async function fecExport(c: Client, dossierId: string, fiscalYearId?: string): Promise<string> {
  const params: any[] = [dossierId];
  let where = "e.dossier_id = $1 and e.status = 'posted'";
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }

  const { rows } = await c.query(
    `select j.code as jcode, j.label as jlabel, e.piece_ref, to_char(e.entry_date,'YYYY-MM-DD') as edate,
            to_char(e.created_at,'YYYY-MM-DD') as vdate, coalesce(l.label, e.description) as elib,
            a.account_code, a.label as alabel, cp.aux_code, cp.name as cpname,
            l.amount_debit as debit, l.amount_credit as credit,
            (select le.code from lettrage_lines ll join lettrages le on le.id=ll.lettrage_id where ll.entry_line_id=l.id) as lettre
       from entry_lines l
       join entries e on e.id = l.entry_id
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id
       left join counterparties cp on cp.id = l.counterparty_id
      where ${where}
      order by e.entry_date, j.code, e.created_at, l.line_no`,
    params,
  );

  const lines = [FEC_HEADER.join('\t')];
  for (const r of rows) {
    lines.push([
      clean(r.jcode), clean(r.jlabel), clean(r.piece_ref || r.edate), ymd(r.edate),
      clean(r.account_code), clean(r.alabel), clean(r.aux_code), clean(r.cpname),
      clean(r.piece_ref), ymd(r.edate), clean(r.elib), amt(Number(r.debit)), amt(Number(r.credit)),
      clean(r.lettre), '', ymd(r.vdate), '', '',
    ].join('\t'));
  }
  return lines.join('\r\n');
}
