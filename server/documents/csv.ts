import type { Client } from '../db.js';
import * as acc from '../domain/accounting.js';

// ============================================================================
// Exports tableur (CSV ouvrable dans Excel/LibreOffice). Séparateur « ; » et
// BOM UTF-8 pour un rendu correct des accents et des colonnes sous Excel FR.
// Montants en entiers (XOF sans décimales) pour rester numériques quelle que
// soit la locale.
// ============================================================================

function cell(v: string | number): string {
  const s = typeof v === 'number' ? String(Math.round(v)) : String(v ?? '');
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number)[][]): Buffer {
  const body = rows.map((r) => r.map(cell).join(';')).join('\r\n');
  return Buffer.from('﻿' + body, 'utf8'); // BOM UTF-8 pour Excel
}

export async function balanceCsv(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const rows = await acc.trialBalance(c, dossierId, fyId);
  const sD = (r: any) => Math.max(r.balance, 0), sC = (r: any) => Math.max(-r.balance, 0);
  const out: (string | number)[][] = [['Compte', 'Intitulé', 'Débit', 'Crédit', 'Solde débiteur', 'Solde créditeur']];
  for (const r of rows) out.push([r.account_code, r.account_label ?? '', r.total_debit, r.total_credit, sD(r), sC(r)]);
  out.push(['', 'TOTAUX',
    rows.reduce((s: number, r: any) => s + r.total_debit, 0),
    rows.reduce((s: number, r: any) => s + r.total_credit, 0),
    rows.reduce((s: number, r: any) => s + sD(r), 0),
    rows.reduce((s: number, r: any) => s + sC(r), 0)]);
  return { filename: 'balance-generale.csv', buffer: toCsv(out), count: rows.length };
}

export async function grandLivreCsv(c: Client, dossierId: string, accountCode: string, fyId?: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const lines = await acc.generalLedger(c, dossierId, { fiscalYearId: fyId, accountCode });
  const out: (string | number)[][] = [['Date', 'Journal', 'Pièce', 'Libellé', 'Débit', 'Crédit', 'Solde']];
  let solde = 0;
  for (const l of lines) { solde += l.debit - l.credit; out.push([l.entry_date, l.journal_code ?? '', l.piece_ref ?? '', l.line_label || l.description || '', l.debit, l.credit, solde]); }
  return { filename: `grand-livre-${accountCode}.csv`, buffer: toCsv(out), count: lines.length };
}
