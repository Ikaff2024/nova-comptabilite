import type { Client } from '../db.js';
import { postEntry, createJournal, type EntryLineInput } from './accounting.js';
import { deriveAccount } from './importbalance.js';

// ============================================================================
// Import / reprise du GRAND LIVRE (migration depuis un autre logiciel). Au-delà
// de la balance d'ouverture, on peut reprendre les MOUVEMENTS détaillés : chaque
// ligne (date, journal, pièce, compte, libellé, débit, crédit) est regroupée en
// écritures (par date+journal+pièce), contrôlées (équilibre), puis comptabilisées.
// Idempotence : refuse de réimporter si des écritures d'import existent déjà.
// ============================================================================

export interface LedgerLineInput {
  date: string; journal?: string; piece?: string;
  accountCode: string; label?: string; debit: number; credit: number;
}

const num = (s: any): number => {
  if (typeof s === 'number') return s;
  const cleaned = String(s ?? '').replace(/[\s ']/g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned); return Number.isFinite(n) ? n : 0;
};
const splitDelim = (line: string): string[] => {
  const delim = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
  return line.split(delim).map((s) => s.trim().replace(/^"|"$/g, ''));
};
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Normalise une date vers 'YYYY-MM-DD' (accepte JJ/MM/AAAA, AAAA-MM-JJ, JJ-MM-AAAA).
function isoDate(raw: string): string | null {
  const s = String(raw ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return null;
}

export function parseLedgerCsv(text: string): LedgerLineInput[] {
  const rows = String(text).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (!rows.length) return [];

  // En-tête attendu : date, journal, pièce, compte, libellé, débit, crédit.
  let map: Record<string, number> = { date: 0, journal: 1, piece: 2, code: 3, label: 4, debit: 5, credit: 6 };
  let start = 0;
  const first = splitDelim(rows[0]).map(norm);
  const reDebit = /d.?bit/, reCredit = /cr.?dit/;
  const looksHeader = first.some((h) => /date|journal|compte|code|pi.?ce|libell/.test(h) || reDebit.test(h) || reCredit.test(h));
  if (looksHeader) {
    start = 1;
    const find = (...keys: string[]) => first.findIndex((h) => keys.some((k) => h.includes(k)));
    const findRe = (re: RegExp) => first.findIndex((h) => re.test(h));
    map = {
      date: Math.max(find('date'), 0),
      journal: find('journal', 'jrnl', 'jal'),
      piece: find('piece', 'pi', 'ref', 'num'),
      code: Math.max(find('compte', 'code'), 0),
      label: find('libell', 'intitul', 'desig', 'nom'),
      debit: findRe(reDebit), credit: findRe(reCredit),
    };
  }

  const out: LedgerLineInput[] = [];
  for (let i = start; i < rows.length; i++) {
    const c = splitDelim(rows[i]);
    const rawCode = (c[map.code] ?? '').replace(/[^0-9A-Za-z]/g, '');
    if (!rawCode || !/^\d/.test(rawCode)) continue;
    const debit = map.debit >= 0 ? num(c[map.debit]) : 0;
    const credit = map.credit >= 0 ? num(c[map.credit]) : 0;
    if (debit === 0 && credit === 0) continue;
    out.push({
      date: (c[map.date] ?? '').trim(),
      journal: map.journal >= 0 ? (c[map.journal] ?? '').trim() : undefined,
      piece: map.piece >= 0 ? (c[map.piece] ?? '').trim() : undefined,
      accountCode: rawCode, label: map.label >= 0 ? (c[map.label] ?? '').trim() : undefined,
      debit, credit,
    });
  }
  return out;
}

interface GroupedEntry { key: string; date: string; journal: string; piece: string; lines: LedgerLineInput[]; debit: number; credit: number; balanced: boolean }

function group(lines: LedgerLineInput[]): { entries: GroupedEntry[]; invalidDates: number } {
  const map = new Map<string, GroupedEntry>();
  let invalidDates = 0;
  for (const l of lines) {
    const iso = isoDate(l.date);
    if (!iso) { invalidDates++; continue; }
    const journal = (l.journal || 'OD').toUpperCase().slice(0, 6);
    const piece = l.piece || '';
    const key = `${iso}|${journal}|${piece}`;
    let e = map.get(key);
    if (!e) { e = { key, date: iso, journal, piece, lines: [], debit: 0, credit: 0, balanced: false }; map.set(key, e); }
    e.lines.push({ ...l, date: iso }); e.debit += l.debit; e.credit += l.credit;
  }
  const entries = [...map.values()];
  for (const e of entries) e.balanced = Math.abs(e.debit - e.credit) < 0.5;
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.journal.localeCompare(b.journal));
  return { entries, invalidDates };
}

export async function analyzeLedgerImport(c: Client, dossierId: string, lines: LedgerLineInput[], fyId?: string): Promise<{
  entries: number; movements: number; totalDebit: number; totalCredit: number; balanced: boolean;
  unbalanced: { date: string; journal: string; piece: string; ecart: number }[];
  missingAccounts: string[]; invalidDates: number; outOfRange: number; alreadyImported: boolean;
}> {
  const { entries, invalidDates } = group(lines);
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

  // Comptes absents du plan.
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const { rows: ex } = codes.length
    ? await c.query('select account_code from accounts where dossier_id=$1 and account_code = any($2)', [dossierId, codes])
    : { rows: [] as any[] };
  const known = new Set(ex.map((r: any) => r.account_code));
  const missingAccounts = codes.filter((code) => !known.has(code));

  // Dates hors exercice (si un exercice est fourni).
  let outOfRange = 0;
  if (fyId) {
    const { rows: fy } = await c.query("select to_char(start_date,'YYYY-MM-DD') s, to_char(end_date,'YYYY-MM-DD') e from fiscal_years where dossier_id=$1 and id=$2", [dossierId, fyId]);
    if (fy[0]) outOfRange = entries.filter((en) => en.date < fy[0].s || en.date > fy[0].e).length;
  }

  const { rows: imp } = await c.query("select 1 from entries where dossier_id=$1 and source='api' and piece_ref like 'IMP-%' limit 1", [dossierId]);

  return {
    entries: entries.length, movements: lines.length,
    totalDebit: Math.round(totalDebit), totalCredit: Math.round(totalCredit),
    balanced: Math.abs(totalDebit - totalCredit) < 0.5,
    unbalanced: entries.filter((e) => !e.balanced).slice(0, 20).map((e) => ({ date: e.date, journal: e.journal, piece: e.piece, ecart: Math.round(e.debit - e.credit) })),
    missingAccounts, invalidDates, outOfRange, alreadyImported: !!imp[0],
  };
}

const JOURNAL_TYPE: Record<string, string> = { AC: 'achats', VE: 'ventes', BQ: 'banque', CA: 'caisse', OD: 'operations_diverses', AN: 'a_nouveaux' };

export async function commitLedgerImport(
  c: Client, dossierId: string, lines: LedgerLineInput[],
  opts: { fiscalYearId: string; createMissing?: boolean; userId?: string },
): Promise<{ entriesCreated: number; movements: number; accountsCreated: number; totalDebit: number }> {
  const { entries, invalidDates } = group(lines);
  if (entries.length === 0) throw new Error(invalidDates > 0 ? `Aucune écriture exploitable : ${invalidDates} ligne(s) avec une date invalide.` : 'Aucune écriture à importer.');

  const unbalanced = entries.filter((e) => !e.balanced);
  if (unbalanced.length > 0) {
    const s = unbalanced.slice(0, 5).map((e) => `${e.date}/${e.journal}${e.piece ? '/' + e.piece : ''} (écart ${Math.round(e.debit - e.credit)})`).join(', ');
    throw new Error(`${unbalanced.length} écriture(s) déséquilibrée(s), import refusé : ${s}${unbalanced.length > 5 ? '…' : ''}. Vérifiez le regroupement par pièce.`);
  }

  const analysis = await analyzeLedgerImport(c, dossierId, lines, opts.fiscalYearId);
  if (analysis.alreadyImported) throw new Error("Un grand livre a déjà été importé pour ce dossier (écritures IMP-). Contre-passez-les avant de réimporter.");
  if (analysis.missingAccounts.length > 0 && !opts.createMissing) {
    const sample = analysis.missingAccounts.slice(0, 8).join(', ');
    throw new Error(`${analysis.missingAccounts.length} compte(s) absent(s) du plan (${sample}${analysis.missingAccounts.length > 8 ? '…' : ''}). Activez la création automatique.`);
  }

  // Création des comptes manquants (à partir d'un mouvement représentatif).
  let accountsCreated = 0;
  if (opts.createMissing && analysis.missingAccounts.length > 0) {
    for (const code of analysis.missingAccounts) {
      const sample = lines.find((l) => l.accountCode === code)!;
      const d = deriveAccount(code, sample.debit >= sample.credit);
      await c.query(
        `insert into accounts(dossier_id, account_code, label, class_no, account_type, normal_side, is_postable)
         values ($1,$2,$3,$4,$5::account_type,$6::account_nature,true)
         on conflict (dossier_id, account_code) do nothing`,
        [dossierId, code, sample.label || `Compte ${code}`, d.classNo, d.type, d.side]);
      accountsCreated++;
    }
  }

  // Résolution / création des journaux référencés.
  const { rows: jrows } = await c.query('select id, code from journals where dossier_id=$1', [dossierId]);
  const jmap = new Map<string, string>(jrows.map((r: any) => [String(r.code).toUpperCase(), r.id]));
  const journalId = async (code: string): Promise<string> => {
    const cu = code.toUpperCase();
    if (jmap.has(cu)) return jmap.get(cu)!;
    const type = JOURNAL_TYPE[cu] ?? 'operations_diverses';
    const id = await createJournal(c, dossierId, cu.slice(0, 6), cu, type as any);
    jmap.set(cu, id); return id;
  };

  let entriesCreated = 0, totalDebit = 0, seq = 0;
  for (const e of entries) {
    const jid = await journalId(e.journal);
    const entryLines: EntryLineInput[] = e.lines.map((l) => ({
      accountCode: l.accountCode,
      debit: l.debit || undefined, credit: l.credit || undefined,
      label: l.label || undefined,
    }));
    seq += 1;
    await postEntry(c, {
      dossierId, fiscalYearId: opts.fiscalYearId, journalId: jid, entryDate: e.date,
      description: e.lines[0]?.label || `Reprise ${e.journal}`,
      source: 'api', pieceRef: `IMP-${e.piece || String(seq).padStart(5, '0')}`,
      createdBy: opts.userId, lines: entryLines,
    });
    entriesCreated += 1; totalDebit += e.debit;
  }

  return { entriesCreated, movements: lines.length, accountsCreated, totalDebit: Math.round(totalDebit) };
}
