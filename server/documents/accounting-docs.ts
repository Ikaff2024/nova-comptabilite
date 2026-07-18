import type { Client } from '../db.js';
import * as acc from '../domain/accounting.js';
import { vatDeclaration } from '../domain/tax.js';
import { tablePdf, sectionsPdf, type RowStyle } from './pdf.js';

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// ============================================================================
// Restitutions comptables en PDF (balance, grand livre, états financiers),
// joignables par Lexa. S'appuie sur les fonctions du domaine comptable.
// ============================================================================

const grp = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

async function ctx(c: Client, dossierId: string): Promise<{ d: any; cur: string; money: (n: number) => string; md: (n: number) => string; meta: string[] }> {
  const { rows } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = rows[0]?.j ?? {};
  const cur = d.base_currency ?? 'XOF';
  const money = (n: number) => `${grp(n)} ${cur}`;
  const md = (n: number) => (n ? money(n) : '');
  const meta = [`${d.raison_sociale ?? '—'}`];
  if (d.tax_id || d.rccm) meta.push([d.tax_id ? `NCC/IFU : ${d.tax_id}` : '', d.rccm ? `RCCM : ${d.rccm}` : ''].filter(Boolean).join(' · '));
  return { d, cur, money, md, meta };
}

export async function balancePdf(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer }> {
  const { d, money, md, meta } = await ctx(c, dossierId);
  const rows = await acc.trialBalance(c, dossierId, fyId);
  const sD = (r: any) => Math.max(r.balance, 0), sC = (r: any) => Math.max(-r.balance, 0);
  const totDeb = rows.reduce((s: number, r: any) => s + r.total_debit, 0);
  const totCre = rows.reduce((s: number, r: any) => s + r.total_credit, 0);
  const totSD = rows.reduce((s: number, r: any) => s + sD(r), 0);
  const totSC = rows.reduce((s: number, r: any) => s + sC(r), 0);

  const buffer = await tablePdf({
    title: 'Balance générale', subtitle: `${d.raison_sociale ?? ''}`, meta,
    columns: [
      { label: 'Compte', width: 55 }, { label: 'Intitulé', width: 165 },
      { label: 'Débit', width: 78, align: 'right' }, { label: 'Crédit', width: 78, align: 'right' },
      { label: 'Solde déb.', width: 78, align: 'right' }, { label: 'Solde créd.', width: 78, align: 'right' },
    ],
    rows: rows.map((r: any) => [r.account_code, r.account_label ?? '', md(r.total_debit), md(r.total_credit), md(sD(r)), md(sC(r))]),
    totals: ['', 'TOTAUX', money(totDeb), money(totCre), money(totSD), money(totSC)],
    footNote: `${rows.length} compte(s) mouvementé(s). Généré par Nova.`,
  });
  return { filename: 'balance-generale.pdf', buffer };
}

export async function grandLivrePdf(c: Client, dossierId: string, accountCode: string, fyId?: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, money, md, meta } = await ctx(c, dossierId);
  const lines = await acc.generalLedger(c, dossierId, { fiscalYearId: fyId, accountCode });
  let solde = 0;
  const rows = lines.map((l: any) => { solde += l.debit - l.credit; return [l.entry_date, l.journal_code ?? '', l.piece_ref ?? '', (l.line_label || l.description || '').slice(0, 40), md(l.debit), md(l.credit), money(solde)]; });
  const label = lines[0]?.account_label ?? '';

  const buffer = await tablePdf({
    title: `Grand livre — compte ${accountCode}`, subtitle: `${d.raison_sociale ?? ''}${label ? ` · ${label}` : ''}`, meta,
    columns: [
      { label: 'Date', width: 60 }, { label: 'Jrnl', width: 34 }, { label: 'Pièce', width: 62 }, { label: 'Libellé', width: 150 },
      { label: 'Débit', width: 70, align: 'right' }, { label: 'Crédit', width: 70, align: 'right' }, { label: 'Solde', width: 78, align: 'right' },
    ],
    rows,
    totals: ['', '', '', 'Solde final', '', '', money(solde)],
    footNote: `${lines.length} écriture(s). Généré par Nova.`,
  });
  return { filename: `grand-livre-${accountCode}.pdf`, buffer, count: lines.length };
}

// Livre-journal (journal général chronologique) — livre légal OHADA : toutes les
// écritures validées de l'exercice, ligne à ligne, dans l'ordre chronologique.
export async function livreJournalPdf(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, md, money, meta } = await ctx(c, dossierId);
  const lines = await acc.journalEntries(c, dossierId, { fiscalYearId: fyId });
  let td = 0, tc = 0;
  const rows = lines.map((l: any) => {
    td += l.debit; tc += l.credit;
    return [l.entry_date, l.journal_code ?? '', l.piece_ref ?? '', l.account_code, (l.label || l.entry_description || '').slice(0, 44), md(l.debit), md(l.credit)];
  });
  const buffer = await tablePdf({
    title: 'Livre-journal', subtitle: `${d.raison_sociale ?? ''} · journal général chronologique`, meta,
    columns: [
      { label: 'Date', width: 58 }, { label: 'Jrnl', width: 32 }, { label: 'Pièce', width: 60 }, { label: 'Compte', width: 48 },
      { label: 'Libellé', width: 150 }, { label: 'Débit', width: 72, align: 'right' }, { label: 'Crédit', width: 72, align: 'right' },
    ],
    rows,
    totals: ['', '', '', '', 'Totaux', money(td), money(tc)],
    footNote: `${lines.length} ligne(s) d'écriture. Livre-journal (art. 19 AUDCIF) — document légal à conserver. Généré par Nova.`,
  });
  return { filename: `livre-journal.pdf`, buffer, count: lines.length };
}

// Grand livre général — livre légal OHADA : TOUS les comptes mouvementés, chacun
// avec le détail de ses écritures et son solde. Comptes en en-tête (gras), lignes
// d'écriture puis sous-total par compte.
export async function grandLivreGeneralPdf(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, md, money, meta } = await ctx(c, dossierId);
  const lines = await acc.generalLedger(c, dossierId, { fiscalYearId: fyId });

  const rows: string[][] = [];
  const rowStyles: (RowStyle | undefined)[] = [];
  const push = (r: string[], s?: RowStyle) => { rows.push(r); rowStyles.push(s); };

  let curr: string | null = null;
  let sD = 0, sC = 0, solde = 0, gD = 0, gC = 0, nbComptes = 0;
  const flush = () => {
    if (curr === null) return;
    push(['', '', '', 'Solde du compte', md(sD), md(sC), money(solde)], { bold: true, line: 'top' });
  };
  for (const l of lines) {
    if (l.account_code !== curr) {
      flush();
      curr = l.account_code; sD = 0; sC = 0; solde = 0; nbComptes++;
      push([`${l.account_code}`, `${l.account_label ?? ''}`, '', '', '', '', ''], { bold: true, fill: '#f0f0f0' });
    }
    sD += l.debit; sC += l.credit; solde += l.debit - l.credit; gD += l.debit; gC += l.credit;
    push([l.entry_date, l.journal_code ?? '', l.piece_ref ?? '', (l.line_label || l.description || '').slice(0, 42), md(l.debit), md(l.credit), money(solde)]);
  }
  flush();

  const buffer = await tablePdf({
    title: 'Grand livre général', subtitle: `${d.raison_sociale ?? ''} · tous les comptes mouvementés`, meta,
    columns: [
      { label: 'Date', width: 58 }, { label: 'Jrnl', width: 32 }, { label: 'Pièce', width: 58 }, { label: 'Libellé', width: 140 },
      { label: 'Débit', width: 70, align: 'right' }, { label: 'Crédit', width: 70, align: 'right' }, { label: 'Solde', width: 76, align: 'right' },
    ],
    rows, rowStyles,
    totals: ['', '', '', 'TOTAUX', money(gD), money(gC), ''],
    footNote: `${nbComptes} compte(s), ${lines.length} écriture(s). Grand livre général (art. 19 AUDCIF) — document légal à conserver. Généré par Nova.`,
  });
  return { filename: `grand-livre-general.pdf`, buffer, count: lines.length };
}

export async function declarationTvaPdf(c: Client, dossierId: string, year: number, month0: number): Promise<{ filename: string; buffer: Buffer }> {
  const { d, money, meta } = await ctx(c, dossierId);
  const from = `${year}-${String(month0 + 1).padStart(2, '0')}-01`;
  const to = `${year}-${String(month0 + 1).padStart(2, '0')}-${String(new Date(year, month0 + 1, 0).getDate()).padStart(2, '0')}`;
  const vat: any = await vatDeclaration(c, dossierId, from, to);
  const collectee = vat.breakdown.filter((b: any) => b.account_code.startsWith('443'));
  const deductible = vat.breakdown.filter((b: any) => b.account_code.startsWith('445'));

  const buffer = await sectionsPdf({
    title: 'Déclaration de TVA', subtitle: `${d.raison_sociale ?? ''} · ${MOIS[month0]} ${year}`, meta,
    sections: [
      { heading: 'TVA collectée (comptes 443)', rows: collectee.length ? collectee.map((b: any) => [`${b.account_code} ${b.label}`, money(b.credit - b.debit)] as [string, string]) : [['—', money(0)]] as [string, string][], total: ['Total TVA collectée', money(vat.collectee)] },
      { heading: 'TVA déductible (comptes 445)', rows: deductible.length ? deductible.map((b: any) => [`${b.account_code} ${b.label}`, money(b.debit - b.credit)] as [string, string]) : [['—', money(0)]] as [string, string][], total: ['Total TVA déductible', money(vat.deductible)] },
      { heading: 'Résultat de la période', rows: [['TVA nette à payer', money(vat.netDue)], ['Crédit de TVA reportable', money(vat.creditReportable)]] },
    ],
    grandTotal: vat.netDue > 0 ? ['À PAYER À LA DGI', money(vat.netDue)] : ['CRÉDIT DE TVA REPORTABLE', money(vat.creditReportable)],
    footNote: 'Déclaration pré-remplie par Nova à partir des écritures comptabilisées. À vérifier et déposer auprès de la DGI.',
  });
  return { filename: `declaration-tva-${year}-${String(month0 + 1).padStart(2, '0')}.pdf`, buffer };
}

export async function etatsFinanciersPdf(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer }> {
  const { d, money, meta } = await ctx(c, dossierId);
  const fs: any = await acc.financialStatements(c, dossierId, fyId);
  const is = fs.incomeStatement, bs = fs.balanceSheet;

  const buffer = await sectionsPdf({
    title: 'États financiers', subtitle: `${d.raison_sociale ?? ''}`, meta,
    sections: [
      { heading: 'Soldes intermédiaires de gestion (SIG)', rows: (is.sig ?? []).map((s: any) => [s.label, money(s.amount)] as [string, string]) },
      { heading: 'Compte de résultat', rows: [['Total produits', money(is.totalProduits)], ['Total charges', money(is.totalCharges)]], total: ['Résultat net', money(is.resultatNet)] },
      { heading: 'Bilan — Actif', rows: (bs.actif ?? []).map((a: any) => [a.label, money(a.amount)] as [string, string]), total: ['Total actif', money(bs.totalActif)] },
      { heading: 'Bilan — Passif', rows: (bs.passif ?? []).map((p: any) => [p.label, money(p.amount)] as [string, string]), total: ['Total passif', money(bs.totalPassif)] },
    ],
    footNote: `Équilibre du bilan : ${bs.equilibre ? 'oui' : 'écart ' + money(Math.abs(bs.totalActif - bs.totalPassif))}. Généré par Nova, référentiel SYSCOHADA révisé.`,
  });
  return { filename: 'etats-financiers.pdf', buffer };
}
