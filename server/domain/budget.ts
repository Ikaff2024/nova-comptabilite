import type { Client } from '../db.js';

// ============================================================================
// Budgets : montant budgété par compte et par exercice, comparé au réalisé
// (classes 6 = charges, 7 = produits). Écart et taux de réalisation à la volée.
// ============================================================================

// --- Import CSV du budget (Compte ; [Libellé] ; Montant) ---------------------

export interface BudgetLineInput { accountCode: string; amount: number }

function num(s: string): number {
  if (!s) return 0;
  const cleaned = String(s).replace(/[\s  ']/g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function splitDelim(line: string): string[] {
  const d = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
  return line.split(d).map((s) => s.trim().replace(/^"|"$/g, ''));
}
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function parseBudgetCsv(text: string): BudgetLineInput[] {
  const rows = String(text).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows.length === 0) return [];
  let map = { code: 0, amount: 1 };
  let start = 0;
  const first = splitDelim(rows[0]).map(norm);
  if (first.some((h) => /compte|code|montant|budget|libell/.test(h))) {
    start = 1;
    const find = (...keys: string[]) => first.findIndex((h) => keys.some((k) => h.includes(k)));
    const code = find('compte', 'code');
    const amount = find('montant', 'budget');
    map = { code: code >= 0 ? code : 0, amount: amount >= 0 ? amount : first.length - 1 };
  }
  const out: BudgetLineInput[] = [];
  for (let i = start; i < rows.length; i++) {
    const cells = splitDelim(rows[i]);
    const code = (cells[map.code] ?? '').replace(/[^0-9]/g, '');
    if (!code) continue;
    const amount = Math.round(num(cells[map.amount]) * 100) / 100;
    if (amount === 0) continue;
    out.push({ accountCode: code, amount });
  }
  return out;
}

// Importe (upsert) des lignes de budget. Renvoie le détail des lignes rejetées.
export async function importBudget(
  c: Client, dossierId: string, fiscalYearId: string, lines: BudgetLineInput[],
): Promise<{ imported: number; errors: { accountCode: string; reason: string }[] }> {
  const errors: { accountCode: string; reason: string }[] = [];
  let imported = 0;
  for (const l of lines) {
    const { rows } = await c.query('select class_no from accounts where dossier_id=$1 and account_code=$2', [dossierId, l.accountCode]);
    if (!rows[0]) { errors.push({ accountCode: l.accountCode, reason: 'compte absent du plan' }); continue; }
    if (![6, 7].includes(rows[0].class_no)) { errors.push({ accountCode: l.accountCode, reason: 'budget limité aux classes 6 et 7' }); continue; }
    await setBudget(c, dossierId, fiscalYearId, l.accountCode, l.amount);
    imported++;
  }
  return { imported, errors };
}

export async function setBudget(c: Client, dossierId: string, fiscalYearId: string, accountCode: string, amount: number): Promise<void> {
  const code = String(accountCode ?? '').trim();
  if (!/^\d{2,}$/.test(code)) throw new Error('Code de compte invalide.');
  const { rows: a } = await c.query('select 1 from accounts where dossier_id=$1 and account_code=$2', [dossierId, code]);
  if (!a[0]) throw new Error(`Compte ${code} introuvable dans le plan.`);
  await c.query(
    `insert into budgets(dossier_id, fiscal_year_id, account_code, amount)
     values ($1,$2,$3,$4)
     on conflict (dossier_id, fiscal_year_id, account_code)
     do update set amount = excluded.amount, updated_at = now()`,
    [dossierId, fiscalYearId, code, amount],
  );
}

export async function deleteBudget(c: Client, dossierId: string, fiscalYearId: string, accountCode: string): Promise<void> {
  await c.query('delete from budgets where dossier_id=$1 and fiscal_year_id=$2 and account_code=$3', [dossierId, fiscalYearId, accountCode]);
}

// Rapport budget / réalisé : lignes budgétées + comptes 6/7 mouvementés.
export async function budgetReport(c: Client, dossierId: string, fiscalYearId: string) {
  const { rows: bud } = await c.query(
    'select account_code, amount from budgets where dossier_id=$1 and fiscal_year_id=$2', [dossierId, fiscalYearId]);
  const budMap = new Map(bud.map((r: any) => [r.account_code, Number(r.amount)]));

  const { rows: real } = await c.query(
    `select a.account_code, a.label, a.class_no,
            sum(l.amount_debit - l.amount_credit) as net
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted' and e.fiscal_year_id=$2
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
      where l.dossier_id = $1
      group by a.account_code, a.label, a.class_no`,
    [dossierId, fiscalYearId]);
  const realMap = new Map(real.map((r: any) => [r.account_code, { label: r.label, classNo: r.class_no, realise: r.class_no === 7 ? -Number(r.net) : Number(r.net) }]));

  // libellés pour comptes budgétés sans mouvement
  const codes = [...new Set([...budMap.keys(), ...realMap.keys()])];
  const { rows: labs } = codes.length
    ? await c.query('select account_code, label, class_no from accounts where dossier_id=$1 and account_code = any($2)', [dossierId, codes])
    : { rows: [] as any[] };
  const labMap = new Map(labs.map((r: any) => [r.account_code, { label: r.label, classNo: r.class_no }]));

  const rows = codes.map((code) => {
    const r: any = realMap.get(code);
    const meta: any = labMap.get(code) ?? {};
    const classNo = r?.classNo ?? meta.classNo ?? Number(code[0]);
    const budget = budMap.get(code) ?? 0;
    const realise = Math.round((r?.realise ?? 0) * 100) / 100;
    return {
      account_code: code, label: r?.label ?? meta.label ?? code, classNo,
      budget, realise, ecart: Math.round((realise - budget) * 100) / 100,
      pct: budget ? Math.round((realise / budget) * 100) : null,
    };
  }).sort((a, b) => a.account_code.localeCompare(b.account_code));

  const sum = (cls: number, k: 'budget' | 'realise') => rows.filter((r) => r.classNo === cls).reduce((s, r) => s + r[k], 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const chargesBudget = r2(sum(6, 'budget')), chargesRealise = r2(sum(6, 'realise'));
  const produitsBudget = r2(sum(7, 'budget')), produitsRealise = r2(sum(7, 'realise'));
  return {
    rows,
    totals: {
      chargesBudget, chargesRealise, produitsBudget, produitsRealise,
      resultatBudget: r2(produitsBudget - chargesBudget),
      resultatRealise: r2(produitsRealise - chargesRealise),
    },
  };
}
