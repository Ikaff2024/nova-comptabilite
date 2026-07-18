import type { Client } from '../db.js';
import { postEntry, createJournal, resolveCounterparty, type EntryLineInput } from './accounting.js';

// ============================================================================
// Import / reprise d'une balance existante (migration depuis un autre logiciel).
// Un cabinet colle sa balance (CSV) : Nova la contrôle (comptes, équilibre) puis
// génère UNE écriture d'à-nouveaux (source 'opening_balance') dans le journal AN.
// La comptabilité reste inaltérable — la reprise est une écriture comme une autre.
// ============================================================================

export interface ImportLineInput {
  accountCode: string;
  label?: string;
  debit?: number;
  credit?: number;
}

export interface AnalyzedLine {
  accountCode: string;
  label: string | null;      // libellé fourni dans le fichier
  debit: number;
  credit: number;
  status: 'ok' | 'missing';  // le compte existe-t-il déjà dans le dossier ?
  existingLabel?: string;    // intitulé du compte dans le plan (si trouvé)
}

export interface ImportAnalysis {
  lines: AnalyzedLine[];
  totalDebit: number;
  totalCredit: number;
  diff: number;              // débit - crédit
  balanced: boolean;
  okCount: number;
  missingCount: number;
  alreadyImported: boolean;  // une balance d'ouverture existe déjà pour cet exercice
}

// --- Parsing CSV tolérant --------------------------------------------------

function num(s: string): number {
  if (!s) return 0;
  // enlève espaces (séparateur de milliers), remplace virgule décimale par point
  const cleaned = String(s).replace(/[\s ']/g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function splitDelim(line: string): string[] {
  // détecte ; \t ou , (le ; prime, format Excel FR)
  const delim = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
  return line.split(delim).map((s) => s.trim().replace(/^"|"$/g, ''));
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Parse une balance collée en CSV. Reconnaît un en-tête (compte/code, libellé,
 * débit, crédit, solde). Sans en-tête : colonnes = code, libellé, débit, crédit.
 * Accepte aussi une colonne "solde" signée (débit si positif, crédit si négatif).
 */
export function parseBalanceCsv(text: string): ImportLineInput[] {
  const rows = String(text).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows.length === 0) return [];

  // Détection d'en-tête
  let map = { code: 0, label: 1, debit: 2, credit: 3, solde: -1 } as Record<string, number>;
  let start = 0;
  const first = splitDelim(rows[0]).map(norm);
  // Tolérant aux accents CORROMPUS : un fichier Latin-1 lu en UTF-8 transforme
  // « Débit »/« Crédit » en « D�bit »/« Cr�dit ». On matche donc sur des motifs
  // qui acceptent n'importe quel caractère à la place de l'accent (d.?bit, cr.?dit).
  const reDebit = /d.?bit/, reCredit = /cr.?dit/, reSolde = /sold/;
  const looksHeader = first.some((h) => /compte|code|libell|intitul|sold/.test(h) || reDebit.test(h) || reCredit.test(h));
  if (looksHeader) {
    start = 1;
    const find = (...keys: string[]) => first.findIndex((h) => keys.some((k) => h.includes(k)));
    const findRe = (re: RegExp) => first.findIndex((h) => re.test(h));
    map = {
      code: Math.max(find('compte', 'code', 'numero'), 0),
      label: find('libell', 'intitul', 'nom', 'desig'),
      debit: findRe(reDebit),
      credit: findRe(reCredit),
      solde: findRe(reSolde),
    };
  }

  const out: ImportLineInput[] = [];
  for (let i = start; i < rows.length; i++) {
    const cells = splitDelim(rows[i]);
    const rawCode = (cells[map.code] ?? '').replace(/[^0-9A-Za-z]/g, '');
    if (!rawCode || !/^\d/.test(rawCode)) continue; // ignore lignes de totaux / vides
    const label = map.label >= 0 ? (cells[map.label] ?? '').trim() : '';
    let debit = map.debit >= 0 ? num(cells[map.debit]) : 0;
    let credit = map.credit >= 0 ? num(cells[map.credit]) : 0;
    if (map.solde >= 0 && debit === 0 && credit === 0) {
      const s = num(cells[map.solde]);
      if (s >= 0) debit = s; else credit = -s;
    }
    if (debit === 0 && credit === 0) continue;
    out.push({ accountCode: rawCode, label: label || undefined, debit, credit });
  }
  return out;
}

// --- Reprise détaillée des en-cours tiers ----------------------------------
// Chaque facture ouverte (client/fournisseur) devient une ligne d'à-nouveaux sur
// le compte collectif, avec tiers rattaché, date d'origine (pour l'ancienneté)
// et référence de pièce (pour le lettrage futur). Le total par compte doit
// coïncider avec la balance.

export interface TiersOpenItem {
  accountCode: string;   // compte collectif (41x client / 40x fournisseur)
  tiersName: string;
  pieceRef?: string;
  invoiceDate?: string;  // date d'origine (ISO) -> ancienneté
  dueDate?: string;
  debit: number;         // créance client
  credit: number;        // dette fournisseur
}

// Normalise une date (dd/mm/yyyy, dd-mm-yyyy ou ISO) en 'YYYY-MM-DD' ; sinon null.
function normDate(s?: string): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/**
 * Parse un CSV d'en-cours tiers. Colonnes reconnues (en-tête) : compte, tiers,
 * pièce, date, échéance, débit, crédit (ou montant signé). Sans débit/crédit,
 * le sens est déduit de la classe : 41x = créance (débit), 40x = dette (crédit).
 */
export function parseTiersCsv(text: string): TiersOpenItem[] {
  const rows = String(text).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows.length === 0) return [];
  const first = splitDelim(rows[0]).map(norm);
  const looksHeader = first.some((h) => /compte|code|tiers|client|fournisseur|nom|piece|pièce|facture|date|echeance|échéance|debit|credit|montant|solde/.test(h));
  let start = 0;
  let map = { code: 0, tiers: 1, piece: 2, date: 3, due: 4, debit: 5, credit: 6, montant: -1 } as Record<string, number>;
  if (looksHeader) {
    start = 1;
    const find = (...keys: string[]) => first.findIndex((h) => keys.some((k) => h.includes(k)));
    map = {
      code: Math.max(find('compte', 'code', 'numero'), 0),
      tiers: Math.max(find('tiers', 'client', 'fournisseur', 'nom', 'raison'), 1),
      piece: find('piece', 'pièce', 'facture', 'ref'),
      date: find('date'),
      due: find('echeance', 'échéance', 'due'),
      debit: find('debit'),
      credit: find('credit'),
      montant: find('montant', 'solde'),
    };
  }
  const out: TiersOpenItem[] = [];
  for (let i = start; i < rows.length; i++) {
    const cells = splitDelim(rows[i]);
    const code = (cells[map.code] ?? '').replace(/[^0-9A-Za-z]/g, '');
    if (!code || !/^\d/.test(code)) continue;
    const tiersName = (cells[map.tiers] ?? '').trim();
    if (!tiersName) continue;
    let debit = map.debit >= 0 ? num(cells[map.debit]) : 0;
    let credit = map.credit >= 0 ? num(cells[map.credit]) : 0;
    if (debit === 0 && credit === 0) {
      const amt = map.montant >= 0 ? num(cells[map.montant]) : 0;
      if (amt !== 0) {
        const isClient = code.startsWith('41');
        // Créance client au débit, dette fournisseur au crédit ; montant négatif = avoir.
        if (isClient) { if (amt >= 0) debit = amt; else credit = -amt; }
        else { if (amt >= 0) credit = amt; else debit = -amt; }
      }
    }
    if (debit === 0 && credit === 0) continue;
    out.push({
      accountCode: code, tiersName,
      pieceRef: map.piece >= 0 ? (cells[map.piece] ?? '').trim() || undefined : undefined,
      invoiceDate: map.date >= 0 ? normDate(cells[map.date]) ?? undefined : undefined,
      dueDate: map.due >= 0 ? normDate(cells[map.due]) ?? undefined : undefined,
      debit, credit,
    });
  }
  return out;
}

// Fusionne les doublons de code et nette débit/crédit -> une ligne par compte.
function netByAccount(lines: ImportLineInput[]): ImportLineInput[] {
  const m = new Map<string, { label?: string; net: number }>();
  for (const l of lines) {
    const cur = m.get(l.accountCode) ?? { label: l.label, net: 0 };
    cur.net += (l.debit ?? 0) - (l.credit ?? 0);
    if (!cur.label && l.label) cur.label = l.label;
    m.set(l.accountCode, cur);
  }
  const out: ImportLineInput[] = [];
  for (const [code, v] of m) {
    const net = Math.round(v.net * 100) / 100;
    if (net === 0) continue;
    out.push({ accountCode: code, label: v.label, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  return out.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

// --- Analyse (aucune écriture) ---------------------------------------------

export async function analyzeBalanceImport(
  c: Client, dossierId: string, lines: ImportLineInput[], fiscalYearId?: string,
): Promise<ImportAnalysis> {
  const netted = netByAccount(lines);
  const codes = netted.map((l) => l.accountCode);
  const { rows: accs } = codes.length
    ? await c.query('select account_code, label from accounts where dossier_id=$1 and account_code = any($2)', [dossierId, codes])
    : { rows: [] as any[] };
  const known = new Map<string, string>(accs.map((a: any) => [a.account_code, a.label]));

  let totalDebit = 0, totalCredit = 0, okCount = 0, missingCount = 0;
  const analyzed: AnalyzedLine[] = netted.map((l) => {
    const debit = l.debit ?? 0, credit = l.credit ?? 0;
    totalDebit += debit; totalCredit += credit;
    const found = known.has(l.accountCode);
    if (found) okCount++; else missingCount++;
    return {
      accountCode: l.accountCode, label: l.label ?? null, debit, credit,
      status: found ? 'ok' : 'missing', existingLabel: found ? known.get(l.accountCode) : undefined,
    };
  });

  const diff = Math.round((totalDebit - totalCredit) * 100) / 100;
  let alreadyImported = false;
  if (fiscalYearId) {
    const { rows } = await c.query(
      "select 1 from entries where dossier_id=$1 and fiscal_year_id=$2 and source='opening_balance' limit 1",
      [dossierId, fiscalYearId],
    );
    alreadyImported = rows.length > 0;
  }

  return {
    lines: analyzed,
    totalDebit: Math.round(totalDebit * 100) / 100,
    totalCredit: Math.round(totalCredit * 100) / 100,
    diff, balanced: Math.abs(diff) < 0.01,
    okCount, missingCount, alreadyImported,
  };
}

// --- Création des comptes manquants (filet de sécurité de reprise) ----------

// Dérive type/sens d'un compte manquant à partir de sa classe et du sens du solde.
function deriveAccount(code: string, isDebit: boolean): { classNo: number; type: string; side: string } {
  const classNo = Number(code[0]);
  const sign = isDebit ? 'debit' : 'credit';
  switch (classNo) {
    case 1: return { classNo, type: 'equity', side: 'credit' };
    case 2: return { classNo, type: 'asset', side: 'debit' };
    case 3: return { classNo, type: 'asset', side: 'debit' };
    case 4: return { classNo, type: isDebit ? 'asset' : 'liability', side: sign };
    case 5: return { classNo, type: 'asset', side: 'debit' };
    case 6: return { classNo, type: 'expense', side: 'debit' };
    case 7: return { classNo, type: 'income', side: 'credit' };
    case 8: return { classNo, type: isDebit ? 'expense' : 'income', side: sign };
    default: return { classNo: classNo || 9, type: 'analytic', side: 'debit' };
  }
}

async function createMissingAccounts(c: Client, dossierId: string, lines: AnalyzedLine[]): Promise<number> {
  let n = 0;
  for (const l of lines) {
    if (l.status !== 'missing') continue;
    const d = deriveAccount(l.accountCode, l.debit >= l.credit);
    await c.query(
      `insert into accounts(dossier_id, account_code, label, class_no, account_type, normal_side, is_postable)
       values ($1,$2,$3,$4,$5::account_type,$6::account_nature,true)
       on conflict (dossier_id, account_code) do nothing`,
      [dossierId, l.accountCode, l.label || `Compte ${l.accountCode} (repris)`, d.classNo, d.type, d.side],
    );
    n++;
  }
  return n;
}

// Auto-réparation des libellés corrompus (mojibake « � » = U+FFFD, ex. un ancien
// import lu en UTF-8 forcé alors que le fichier était en Windows-1252). Au
// ré-import avec le fichier propre, on remplace le libellé stocké s'il contient
// « � » ET que le fichier apporte un libellé sain. Ne touche jamais un libellé correct.
async function repairCorruptedLabels(c: Client, dossierId: string, lines: AnalyzedLine[]): Promise<number> {
  const BAD = '�';
  let n = 0;
  for (const l of lines) {
    if (l.status !== 'ok') continue;
    const cur = l.existingLabel ?? '';
    const fresh = (l.label ?? '').trim();
    if (cur.includes(BAD) && fresh && !fresh.includes(BAD)) {
      await c.query('update accounts set label=$3 where dossier_id=$1 and account_code=$2', [dossierId, l.accountCode, fresh]);
      n++;
    }
  }
  return n;
}

// --- Validation / écriture d'à-nouveaux -------------------------------------

export interface CommitOptions {
  fiscalYearId: string;
  date: string;              // date de l'à-nouveau (ex. '2026-01-01')
  description?: string;
  createMissing?: boolean;   // créer les comptes absents du plan
  tiersItems?: TiersOpenItem[]; // en-cours tiers détaillés (reprise d'antériorité)
}

// Éclate les comptes tiers en lignes détaillées (une par facture ouverte), en
// contrôlant que le total par compte coïncide avec la balance. Résout les tiers
// et pose la date d'origine (operation_date) pour préserver l'ancienneté.
async function expandTiers(
  c: Client, dossierId: string, netLines: AnalyzedLine[], items: TiersOpenItem[], fallbackDate: string,
): Promise<EntryLineInput[]> {
  const byAccount = new Map<string, TiersOpenItem[]>();
  for (const it of items) {
    if (!byAccount.has(it.accountCode)) byAccount.set(it.accountCode, []);
    byAccount.get(it.accountCode)!.push(it);
  }
  // Contrôle de cohérence : Σ(items) == net balance, compte par compte.
  const netByCode = new Map(netLines.map((l) => [l.accountCode, Math.round(((l.debit || 0) - (l.credit || 0)) * 100) / 100]));
  for (const [code, its] of byAccount) {
    const sum = Math.round(its.reduce((s, i) => s + (i.debit || 0) - (i.credit || 0), 0) * 100) / 100;
    const net = netByCode.get(code);
    if (net === undefined) throw new Error(`Compte ${code} présent dans les en-cours tiers mais absent de la balance.`);
    if (Math.abs(sum - net) > 0.01) throw new Error(`En-cours tiers du compte ${code} (${sum}) ≠ solde de balance (${net}). Corrigez le détail.`);
  }

  const out: EntryLineInput[] = [];
  for (const l of netLines) {
    const its = byAccount.get(l.accountCode);
    if (!its || its.length === 0) {
      out.push({ accountCode: l.accountCode, debit: l.debit || 0, credit: l.credit || 0, label: l.label ?? undefined });
      continue;
    }
    // Compte tiers : une ligne par facture ouverte (tiers + date d'origine + pièce).
    const type = l.accountCode.startsWith('41') ? 'client' : l.accountCode.startsWith('40') ? 'fournisseur' : 'autre';
    for (const it of its) {
      const cpId = await resolveCounterparty(c, dossierId, it.tiersName, type as any);
      out.push({
        accountCode: it.accountCode, debit: it.debit || 0, credit: it.credit || 0,
        label: [it.pieceRef, it.tiersName].filter(Boolean).join(' — ') || it.tiersName,
        counterpartyId: cpId, operationDate: it.invoiceDate || fallbackDate,
      });
    }
  }
  return out;
}

export async function commitBalanceImport(
  c: Client, dossierId: string, lines: ImportLineInput[], opts: CommitOptions,
): Promise<{ entryId: string; accountsCreated: number; lines: number; totalDebit: number; tiersItems: number }> {
  const analysis = await analyzeBalanceImport(c, dossierId, lines, opts.fiscalYearId);

  if (analysis.lines.length < 2) throw new Error('Balance vide ou insuffisante (au moins 2 comptes attendus).');
  if (!analysis.balanced) throw new Error(`Balance déséquilibrée : débit ${analysis.totalDebit} ≠ crédit ${analysis.totalCredit} (écart ${analysis.diff}).`);
  if (analysis.alreadyImported) throw new Error("Une balance d'ouverture existe déjà pour cet exercice. Contre-passez-la avant de réimporter.");
  if (analysis.missingCount > 0 && !opts.createMissing) {
    const sample = analysis.lines.filter((l) => l.status === 'missing').slice(0, 8).map((l) => l.accountCode).join(', ');
    throw new Error(`${analysis.missingCount} compte(s) absent(s) du plan (${sample}${analysis.missingCount > 8 ? '…' : ''}). Activez la création automatique ou ajoutez-les au plan.`);
  }

  const accountsCreated = opts.createMissing ? await createMissingAccounts(c, dossierId, analysis.lines) : 0;
  await repairCorruptedLabels(c, dossierId, analysis.lines); // auto-répare les « � » hérités d'un ancien import mal encodé

  // Journal des à-nouveaux (créé si absent)
  const { rows: jn } = await c.query("select id from journals where dossier_id=$1 and type='a_nouveaux' limit 1", [dossierId]);
  const anJournal = jn[0]?.id ?? await createJournal(c, dossierId, 'AN', 'À-nouveaux', 'a_nouveaux');

  const items = opts.tiersItems ?? [];
  const entryLines: EntryLineInput[] = items.length > 0
    ? await expandTiers(c, dossierId, analysis.lines, items, opts.date)
    : analysis.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit || 0, credit: l.credit || 0, label: l.label ?? undefined }));

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: opts.fiscalYearId, journalId: anJournal, entryDate: opts.date,
    description: opts.description || `Reprise de balance (à-nouveaux au ${opts.date})`,
    source: 'opening_balance', lines: entryLines,
  });

  return { entryId, accountsCreated, lines: entryLines.length, totalDebit: analysis.totalDebit, tiersItems: items.length };
}
