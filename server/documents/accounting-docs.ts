import type { Client } from '../db.js';
import * as acc from '../domain/accounting.js';
import { vatDeclaration } from '../domain/tax.js';
import { agedBalance } from '../domain/forecast.js';
import { auxiliaryBalance, allTiersLedger } from '../domain/tiers.js';
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

// Balance âgée des tiers — antériorité des créances clients et dettes fournisseurs
// par tranches (à échoir, 1-30, 31-60, 61-90, > 90 j de retard). Outil de relance
// et de pilotage du besoin en fonds de roulement.
export async function balanceAgeePdf(c: Client, dossierId: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, md, money, meta } = await ctx(c, dossierId);
  const ab: any = await agedBalance(c, dossierId);

  const rows: string[][] = [];
  const rowStyles: (RowStyle | undefined)[] = [];
  const push = (r: string[], s?: RowStyle) => { rows.push(r); rowStyles.push(s); };
  const section = (title: string, part: { rows: any[]; totals: any }) => {
    push([title, '', '', '', '', ''], { bold: true, fill: '#f0f0f0' });
    if (!part.rows.length) { push(['(aucun solde ouvert)', '', '', '', '', '']); return; }
    for (const r of part.rows) push([r.tiers, md(r.aEchoir), md(r.b30), md(r.b60), md(r.b90), md(r.b90p), money(r.total)] as any);
    const t = part.totals;
    push(['Sous-total', money(t.aEchoir), money(t.b30), money(t.b60), money(t.b90), money(t.b90p), money(t.total)] as any, { bold: true, line: 'top' });
  };
  section('CLIENTS — créances à encaisser', ab.clients);
  section('FOURNISSEURS — dettes à payer', ab.fournisseurs);

  const nb = ab.clients.rows.length + ab.fournisseurs.rows.length;
  const buffer = await tablePdf({
    title: 'Balance âgée des tiers', subtitle: `${d.raison_sociale ?? ''} · antériorité des soldes au ${new Date().toISOString().slice(0, 10)}`, meta,
    columns: [
      { label: 'Tiers', width: 150 }, { label: 'À échoir', width: 64, align: 'right' }, { label: '1-30 j', width: 60, align: 'right' },
      { label: '31-60 j', width: 60, align: 'right' }, { label: '61-90 j', width: 60, align: 'right' }, { label: '> 90 j', width: 60, align: 'right' }, { label: 'Total', width: 72, align: 'right' },
    ],
    rows, rowStyles,
    footNote: `${nb} tiers avec solde ouvert. Les tranches « j » indiquent le retard au-delà de l'échéance. Généré par Nova.`,
  });
  return { filename: 'balance-agee-tiers.pdf', buffer, count: nb };
}

// Journal centralisateur — récapitulatif mensuel par journal (livre de synthèse
// OHADA) : chaque journal en en-tête, ses totaux mensuels débit/crédit, un
// sous-total par journal, puis le total général.
export async function journalCentralisateurPdf(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, money, meta } = await ctx(c, dossierId);
  const data = await acc.journalCentralisateur(c, dossierId, fyId);
  const moisFr = (ym: string) => { const [y, m] = ym.split('-'); return `${MOIS[Number(m) - 1] ?? m} ${y}`; };

  const rows: string[][] = [];
  const rowStyles: (RowStyle | undefined)[] = [];
  const push = (r: string[], s?: RowStyle) => { rows.push(r); rowStyles.push(s); };

  let curr: string | null = null, jD = 0, jC = 0, gD = 0, gC = 0, nbJ = 0;
  const flush = () => { if (curr !== null) push(['', 'Sous-total journal', money(jD), money(jC)], { bold: true, line: 'top' }); };
  for (const l of data) {
    if (l.journal_code !== curr) {
      flush();
      curr = l.journal_code; jD = 0; jC = 0; nbJ++;
      push([l.journal_code, l.journal_label ?? '', '', ''], { bold: true, fill: '#f0f0f0' });
    }
    jD += l.debit; jC += l.credit; gD += l.debit; gC += l.credit;
    push(['', moisFr(l.mois), money(l.debit), money(l.credit)]);
  }
  flush();

  const buffer = await tablePdf({
    title: 'Journal centralisateur', subtitle: `${d.raison_sociale ?? ''} · récapitulatif mensuel par journal`, meta,
    columns: [
      { label: 'Jrnl', width: 44 }, { label: 'Libellé / mois', width: 200 },
      { label: 'Débit', width: 100, align: 'right' }, { label: 'Crédit', width: 100, align: 'right' },
    ],
    rows, rowStyles,
    totals: ['', 'TOTAL GÉNÉRAL', money(gD), money(gC)],
    footNote: `${nbJ} journal(aux). Les totaux débit et crédit doivent être égaux (partie double). Généré par Nova.`,
  });
  return { filename: 'journal-centralisateur.pdf', buffer, count: data.length };
}

// Balance auxiliaire des tiers — justifie les comptes collectifs (411 clients,
// 401 fournisseurs) : chaque tiers avec ses totaux débit/crédit et son solde.
// Le sous-total par nature doit égaler le solde du compte collectif à la balance.
const TIERS_LABELS: Record<string, string> = { client: 'CLIENTS (411)', fournisseur: 'FOURNISSEURS (401)', salarie: 'PERSONNEL (42)', etat: 'ÉTAT (44)', autre: 'AUTRES TIERS' };
export async function balanceAuxiliairePdf(c: Client, dossierId: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, md, money, meta } = await ctx(c, dossierId);
  const all: any[] = await auxiliaryBalance(c, dossierId);
  const mouv = all.filter((r) => r.debit !== 0 || r.credit !== 0);

  const rows: string[][] = [];
  const rowStyles: (RowStyle | undefined)[] = [];
  const push = (r: string[], s?: RowStyle) => { rows.push(r); rowStyles.push(s); };
  const sD = (b: number) => Math.max(b, 0), sC = (b: number) => Math.max(-b, 0);
  let totDeb = 0, totCred = 0;

  for (const type of ['client', 'fournisseur', 'salarie', 'etat', 'autre']) {
    const grpRows = mouv.filter((r) => r.type === type);
    if (!grpRows.length) continue;
    push([TIERS_LABELS[type] ?? type.toUpperCase(), '', '', '', ''], { bold: true, fill: '#f0f0f0' });
    let net = 0;
    for (const r of grpRows) {
      net += r.balance;
      push([r.aux_code || '—', r.name, r.collective || '', md(sD(r.balance)), md(sC(r.balance))]);
    }
    totDeb += sD(net); totCred += sC(net);
    push(['', `Sous-total ${TIERS_LABELS[type] ?? type}`, '', money(sD(net)), money(sC(net))], { bold: true, line: 'top' });
  }

  const buffer = await tablePdf({
    title: 'Balance auxiliaire des tiers', subtitle: `${d.raison_sociale ?? ''} · justification des comptes collectifs`, meta,
    columns: [
      { label: 'Code', width: 54 }, { label: 'Tiers', width: 190 }, { label: 'Collectif', width: 56 },
      { label: 'Solde débiteur', width: 92, align: 'right' }, { label: 'Solde créditeur', width: 92, align: 'right' },
    ],
    rows, rowStyles,
    totals: ['', 'TOTAUX', '', money(totDeb), money(totCred)],
    footNote: `${mouv.length} tiers mouvementé(s). Le sous-total de chaque nature doit égaler le solde du compte collectif à la balance générale. Généré par Nova.`,
  });
  return { filename: 'balance-auxiliaire-tiers.pdf', buffer, count: mouv.length };
}

// Grand livre auxiliaire — tous les tiers, chacun avec ses mouvements et son solde
// progressif, un sous-total par tiers. Justifie ligne à ligne les comptes 411/401.
export async function grandLivreAuxiliairePdf(c: Client, dossierId: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, md, money, meta } = await ctx(c, dossierId);
  const lines: any[] = await allTiersLedger(c, dossierId);

  const rows: string[][] = [];
  const rowStyles: (RowStyle | undefined)[] = [];
  const push = (r: string[], s?: RowStyle) => { rows.push(r); rowStyles.push(s); };

  let curr: string | null = null, solde = 0, sD = 0, sC = 0, nbTiers = 0;
  const flush = () => { if (curr !== null) push(['', '', '', 'Solde du tiers', md(sD), md(sC), money(solde)], { bold: true, line: 'top' }); };
  for (const l of lines) {
    const key = `${l.tiers_type}|${l.tiers_name}`;
    if (key !== curr) {
      flush();
      curr = key; solde = 0; sD = 0; sC = 0; nbTiers++;
      push([`${l.aux_code || ''}`, `${l.tiers_name}`, '', '', '', '', ''], { bold: true, fill: '#f0f0f0' });
    }
    sD += l.debit; sC += l.credit; solde += l.debit - l.credit;
    push([l.entry_date, l.journal_code ?? '', l.piece_ref ?? '', (l.label || '').slice(0, 40), md(l.debit), md(l.credit), money(solde)]);
  }
  flush();

  const buffer = await tablePdf({
    title: 'Grand livre auxiliaire des tiers', subtitle: `${d.raison_sociale ?? ''} · détail des comptes clients & fournisseurs`, meta,
    columns: [
      { label: 'Date', width: 58 }, { label: 'Jrnl', width: 32 }, { label: 'Pièce', width: 56 }, { label: 'Libellé', width: 138 },
      { label: 'Débit', width: 70, align: 'right' }, { label: 'Crédit', width: 70, align: 'right' }, { label: 'Solde', width: 76, align: 'right' },
    ],
    rows, rowStyles,
    footNote: `${nbTiers} tiers, ${lines.length} mouvement(s). Justifie les comptes collectifs 411 / 401. Généré par Nova.`,
  });
  return { filename: 'grand-livre-auxiliaire.pdf', buffer, count: lines.length };
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

// Récapitulatif annuel de TVA — les 12 mois de l'année : TVA collectée, déductible,
// nette à payer ou crédit reporté, avec cumuls. Outil de rapprochement de la TVA
// déclarée sur l'exercice.
export async function recapTvaAnnuelPdf(c: Client, dossierId: string, year: number): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, md, money, meta } = await ctx(c, dossierId);
  const rows: string[][] = [];
  let tCol = 0, tDed = 0, tNet = 0, tCred = 0, nb = 0;
  for (let m = 0; m < 12; m++) {
    const from = `${year}-${String(m + 1).padStart(2, '0')}-01`;
    const to = `${year}-${String(m + 1).padStart(2, '0')}-${String(new Date(year, m + 1, 0).getDate()).padStart(2, '0')}`;
    const v: any = await vatDeclaration(c, dossierId, from, to);
    const active = v.collectee !== 0 || v.deductible !== 0;
    if (active) nb++;
    tCol += v.collectee; tDed += v.deductible; tNet += v.netDue; tCred += v.creditReportable;
    rows.push([MOIS[m].charAt(0).toUpperCase() + MOIS[m].slice(1), md(v.collectee), md(v.deductible), md(v.netDue), md(v.creditReportable)]);
  }
  const buffer = await tablePdf({
    title: 'Récapitulatif annuel de TVA', subtitle: `${d.raison_sociale ?? ''} · exercice ${year}`, meta,
    columns: [
      { label: 'Mois', width: 96 }, { label: 'TVA collectée', width: 104, align: 'right' }, { label: 'TVA déductible', width: 104, align: 'right' },
      { label: 'Net à payer', width: 100, align: 'right' }, { label: 'Crédit reporté', width: 104, align: 'right' },
    ],
    rows,
    totals: ['TOTAL', money(tCol), money(tDed), money(tNet), money(tCred)],
    footNote: `${nb} mois avec activité TVA. Net cumulé à payer : ${money(tNet)}. Récapitulatif reconstitué à partir des écritures comptabilisées (comptes 443 / 445). À rapprocher des déclarations déposées. Généré par Nova.`,
  });
  return { filename: `recap-tva-${year}.pdf`, buffer, count: nb };
}

// États financiers comparatifs N / N-1 — SIG et grandes masses du bilan, avec la
// variation en valeur et en %. Support de la revue analytique et du commentaire
// de gestion (« pourquoi le résultat a bougé »).
export async function etatsComparatifsPdf(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer; hasPrevious: boolean }> {
  const { d, md, money, meta } = await ctx(c, dossierId);
  const cmp: any = await acc.financialStatementsComparative(c, dossierId, fyId);
  const cur = cmp.current, prv = cmp.previous;
  const lblN = cmp.currentLabel ?? 'N', lblN1 = cmp.previousLabel ?? 'N-1';

  const rows: string[][] = [];
  const rowStyles: (RowStyle | undefined)[] = [];
  const push = (r: string[], s?: RowStyle) => { rows.push(r); rowStyles.push(s); };
  const varTxt = (n: number, p: number) => (!p ? (n ? 'n.s.' : '') : `${n - p >= 0 ? '+' : ''}${Math.round((n - p) / Math.abs(p) * 100)} %`);
  const line = (label: string, n: number, p: number, strong = false) => push([label, md(n), md(p), md(n - p), varTxt(n, p)], strong ? { bold: true } : undefined);
  const header = (label: string) => push([label, '', '', '', ''], { bold: true, fill: '#f0f0f0' });

  // SIG comparatif (mêmes libellés dans les deux exercices)
  header('SOLDES INTERMÉDIAIRES DE GESTION');
  const sigN: any[] = cur?.incomeStatement?.sig ?? [];
  const sigP: any[] = prv?.incomeStatement?.sig ?? [];
  for (const s of sigN) {
    const p = sigP.find((x) => x.label === s.label);
    line(s.label, s.amount, p?.amount ?? 0, !!s.strong);
  }
  // Résultat
  header('COMPTE DE RÉSULTAT');
  line('Total des produits', cur?.incomeStatement?.totalProduits ?? 0, prv?.incomeStatement?.totalProduits ?? 0);
  line('Total des charges', cur?.incomeStatement?.totalCharges ?? 0, prv?.incomeStatement?.totalCharges ?? 0);
  line('Résultat net', cur?.incomeStatement?.resultatNet ?? 0, prv?.incomeStatement?.resultatNet ?? 0, true);
  // Bilan — grandes masses
  header('BILAN — GRANDES MASSES');
  const masse = (arr: any[], label: string) => arr?.find((x) => x.label === label)?.amount ?? 0;
  const aN = cur?.balanceSheet?.actif ?? [], aP = prv?.balanceSheet?.actif ?? [];
  const pN = cur?.balanceSheet?.passif ?? [], pP = prv?.balanceSheet?.passif ?? [];
  for (const lbl of ['Actif immobilisé (net)', 'Stocks', 'Créances et emplois assimilés', 'Trésorerie-Actif']) line(lbl, masse(aN, lbl), masse(aP, lbl));
  for (const lbl of ['Capitaux propres', 'Dettes financières et ressources assimilées', 'Passif circulant', 'Trésorerie-Passif']) line(lbl, masse(pN, lbl), masse(pP, lbl));

  const buffer = await tablePdf({
    title: 'États financiers comparatifs', subtitle: `${d.raison_sociale ?? ''} · ${lblN} vs ${lblN1}`, meta,
    columns: [
      { label: 'Poste', width: 178 }, { label: `Exercice ${lblN}`, width: 92, align: 'right' }, { label: `Exercice ${lblN1}`, width: 92, align: 'right' },
      { label: 'Variation', width: 84, align: 'right' }, { label: '%', width: 52, align: 'right' },
    ],
    rows, rowStyles,
    footNote: prv ? `Variation N vs N-1 en valeur et en %. « n.s. » = non significatif (base nulle). Généré par Nova, référentiel SYSCOHADA révisé.` : `Aucun exercice précédent disponible : la colonne ${lblN1} est à zéro. Généré par Nova.`,
  });
  return { filename: 'etats-comparatifs.pdf', buffer, hasPrevious: !!prv };
}

// Tableau de flux de trésorerie (TFT, SYSCOHADA révisé) — méthode indirecte,
// SIMPLIFIÉ. Trois flux (opérationnel, investissement, financement) + écart de
// réconciliation explicite avec la variation constatée de trésorerie.
export async function tftPdf(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer; hasPrevious: boolean }> {
  const { d, money, meta } = await ctx(c, dossierId);
  const t: any = await acc.cashFlowStatement(c, dossierId, fyId);
  if (!t.hasPrevious) {
    const buffer = await sectionsPdf({
      title: 'Tableau de flux de trésorerie', subtitle: `${d.raison_sociale ?? ''}`, meta,
      sections: [{ heading: 'Exercice précédent indisponible', rows: [['Le TFT (méthode indirecte) compare deux exercices.', ''], ['Aucun exercice N-1 avec des mouvements n\'a été trouvé.', '']] }],
      footNote: 'Généré par Nova.',
    });
    return { filename: 'tft.pdf', buffer, hasPrevious: false };
  }
  const s = (n: number): [string, string] => ['', money(n)];
  const R = (label: string, n: number): [string, string] => [label, money(n)];

  const buffer = await sectionsPdf({
    title: 'Tableau de flux de trésorerie', subtitle: `${d.raison_sociale ?? ''} · ${t.currentLabel ?? 'N'} · méthode indirecte (simplifié)`, meta,
    sections: [
      { heading: 'Flux de trésorerie liés à l\'activité opérationnelle', rows: [
        R('Résultat net de l\'exercice', t.resultatNet),
        R('+ Dotations aux amortissements et provisions', t.dotations),
        R('− Variation des créances', t.dCreances),
        R('− Variation des stocks', t.dStocks),
        R('+ Variation des dettes circulantes', t.dDettesCirc),
      ], total: ['= Flux opérationnels (A)', money(t.fluxOperationnels)] },
      { heading: 'Flux de trésorerie liés à l\'investissement', rows: [
        R('Acquisitions nettes d\'immobilisations (estimées)', -t.acquisitions),
      ], total: ['= Flux d\'investissement (B)', money(t.fluxInvestissement)] },
      { heading: 'Flux de trésorerie liés au financement', rows: [
        R('Variation des capitaux propres', t.dCapitaux),
        R('Variation des dettes financières', t.dDettesFin),
      ], total: ['= Flux de financement (C)', money(t.fluxFinancement)] },
      { heading: 'Réconciliation', rows: [
        R('Variation de trésorerie calculée (A + B + C)', t.variationCalculee),
        R('Écart de réconciliation (dividendes, capital, affectation du résultat…)', t.ecartReconciliation),
        R('Variation de trésorerie constatée au bilan', t.variationConstatee),
        R(`Trésorerie d'ouverture (${t.previousLabel ?? 'N-1'})`, t.tresorerieN1),
        R(`Trésorerie de clôture (${t.currentLabel ?? 'N'})`, t.tresorerieN),
      ] },
    ],
    grandTotal: ['Variation de trésorerie de l\'exercice', money(t.variationConstatee)],
    footNote: "TFT simplifié (méthode indirecte) reconstitué à partir des grandes masses N et N-1. Il ne capte pas finement les dividendes, mouvements de capital ni l'affectation du résultat : l'ÉCART DE RÉCONCILIATION mesure ces éléments non détaillés. Document indicatif, à valider par un expert-comptable. Généré par Nova.",
  });
  return { filename: 'tft.pdf', buffer, hasPrevious: true };
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
