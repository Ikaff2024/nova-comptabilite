import type { Client } from '../db.js';

// ============================================================================
// Budgets : montant budgété par compte et par exercice, comparé au réalisé
// (classes 6 = charges, 7 = produits). Écart et taux de réalisation à la volée.
// ============================================================================

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
  return {
    rows,
    totals: {
      chargesBudget: sum(6, 'budget'), chargesRealise: sum(6, 'realise'),
      produitsBudget: sum(7, 'budget'), produitsRealise: sum(7, 'realise'),
    },
  };
}
