import type { Client } from '../db.js';

// ============================================================================
// Comptabilité analytique : sections de coût + résultat analytique (classes 6/7
// ventilées par entry_lines.analytic_axis = code de section).
// ============================================================================

export async function listSections(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    'select id, code, label from analytic_sections where dossier_id=$1 order by code', [dossierId]);
  return rows;
}

export async function createSection(c: Client, dossierId: string, code: string, label: string): Promise<{ id: string }> {
  const cd = String(code ?? '').trim();
  if (!cd) throw new Error('Code de section requis.');
  if (!label?.trim()) throw new Error('Intitulé requis.');
  const { rows: ex } = await c.query('select 1 from analytic_sections where dossier_id=$1 and code=$2', [dossierId, cd]);
  if (ex[0]) throw new Error(`La section ${cd} existe déjà.`);
  const { rows } = await c.query(
    'insert into analytic_sections(dossier_id, code, label) values ($1,$2,$3) returning id', [dossierId, cd, label.trim()]);
  return { id: rows[0].id };
}

export async function deleteSection(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from analytic_sections where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Résultat analytique : charges (cl.6) et produits (cl.7) par section, + non ventilé.
export async function analyticReport(c: Client, dossierId: string, fiscalYearId?: string) {
  const params: any[] = [dossierId];
  let where = "l.dossier_id=$1 and e.status='posted'";
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id=$${params.length}`; }

  const { rows } = await c.query(
    `select coalesce(nullif(l.analytic_axis,''),'—') as section,
            coalesce(sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges,
            coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no=7),0) as produits
       from entry_lines l
       join entries e on e.id = l.entry_id
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
      where ${where}
      group by section`,
    params,
  );
  const { rows: secs } = await c.query('select code, label from analytic_sections where dossier_id=$1', [dossierId]);
  const labelOf = new Map(secs.map((s: any) => [s.code, s.label]));

  const sections = rows.map((r: any) => {
    const charges = Number(r.charges), produits = Number(r.produits);
    return {
      code: r.section,
      label: r.section === '—' ? 'Non ventilé' : (labelOf.get(r.section) ?? r.section),
      produits, charges, resultat: Math.round((produits - charges) * 100) / 100,
    };
  }).filter((s: any) => s.produits !== 0 || s.charges !== 0)
    .sort((a: any, b: any) => (a.code === '—' ? 1 : b.code === '—' ? -1 : a.code.localeCompare(b.code)));

  const totals = sections.reduce((t: any, s: any) => ({ produits: t.produits + s.produits, charges: t.charges + s.charges, resultat: t.resultat + s.resultat }), { produits: 0, charges: 0, resultat: 0 });
  return { sections, totals };
}

// Grand livre analytique d'une section : les lignes de charges/produits (cl. 6/7)
// portant ce code, avec sous-totaux par compte. sectionCode = '—' pour le non ventilé.
export async function analyticDetail(c: Client, dossierId: string, sectionCode: string, fiscalYearId?: string) {
  const params: any[] = [dossierId, sectionCode];
  let where = "l.dossier_id=$1 and coalesce(nullif(l.analytic_axis,''),'—')=$2 and e.status='posted'";
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id=$${params.length}`; }

  const { rows } = await c.query(
    `select to_char(e.entry_date,'YYYY-MM-DD') as date, j.code as journal, e.piece_ref,
            a.account_code, a.label as account_label, a.class_no,
            coalesce(l.label, e.description) as label,
            l.amount_debit as debit, l.amount_credit as credit
       from entry_lines l
       join entries e on e.id = l.entry_id
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
      where ${where}
      order by a.account_code, e.entry_date, e.created_at`,
    params,
  );

  const lines = rows.map((r: any) => {
    const debit = Number(r.debit), credit = Number(r.credit);
    // Signe « métier » : produit (cl.7) positif au crédit, charge (cl.6) positive au débit.
    const montant = r.class_no === 7 ? credit - debit : debit - credit;
    return { date: r.date, journal: r.journal, pieceRef: r.piece_ref, accountCode: r.account_code, accountLabel: r.account_label, classNo: r.class_no, label: r.label, debit, credit, montant };
  });

  const byAccountMap = new Map<string, { accountCode: string; accountLabel: string; classNo: number; montant: number; count: number }>();
  for (const l of lines) {
    const cur = byAccountMap.get(l.accountCode) ?? { accountCode: l.accountCode, accountLabel: l.accountLabel, classNo: l.classNo, montant: 0, count: 0 };
    cur.montant += l.montant; cur.count += 1;
    byAccountMap.set(l.accountCode, cur);
  }
  const byAccount = [...byAccountMap.values()].map((a) => ({ ...a, montant: Math.round(a.montant * 100) / 100 }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const produits = Math.round(lines.filter((l) => l.classNo === 7).reduce((s, l) => s + l.montant, 0) * 100) / 100;
  const charges = Math.round(lines.filter((l) => l.classNo === 6).reduce((s, l) => s + l.montant, 0) * 100) / 100;

  const { rows: sec } = await c.query('select label from analytic_sections where dossier_id=$1 and code=$2', [dossierId, sectionCode]);
  const label = sectionCode === '—' ? 'Non ventilé' : (sec[0]?.label ?? sectionCode);
  return { code: sectionCode, label, lines, byAccount, totals: { produits, charges, resultat: Math.round((produits - charges) * 100) / 100 } };
}

// Croisement section × mois : résultat analytique mensuel de chaque section
// sur l'exercice (ou toutes périodes). Utile pour repérer saisonnalité et dérives.
export async function analyticMonthly(c: Client, dossierId: string, fiscalYearId?: string) {
  const params: any[] = [dossierId];
  let where = "l.dossier_id=$1 and e.status='posted'";
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id=$${params.length}`; }

  const { rows } = await c.query(
    `select coalesce(nullif(l.analytic_axis,''),'—') as section,
            extract(month from e.entry_date)::int as mois,
            coalesce(sum(l.amount_credit - l.amount_debit) filter (where a.class_no=7),0) as produits,
            coalesce(sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges
       from entry_lines l
       join entries e on e.id = l.entry_id
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
      where ${where}
      group by section, mois`,
    params,
  );

  const { rows: secs } = await c.query('select code, label from analytic_sections where dossier_id=$1', [dossierId]);
  const labelOf = new Map(secs.map((s: any) => [s.code, s.label]));

  const bySection = new Map<string, number[]>(); // code -> résultat[0..11]
  for (const r of rows) {
    const code = r.section as string;
    if (!bySection.has(code)) bySection.set(code, Array(12).fill(0));
    const arr = bySection.get(code)!;
    arr[Number(r.mois) - 1] = Math.round((Number(r.produits) - Number(r.charges)) * 100) / 100;
  }

  const sections = [...bySection.entries()].map(([code, monthly]) => ({
    code, label: code === '—' ? 'Non ventilé' : (labelOf.get(code) ?? code),
    monthly, total: Math.round(monthly.reduce((s, v) => s + v, 0) * 100) / 100,
  })).filter((s) => s.monthly.some((v) => v !== 0))
    .sort((a, b) => (a.code === '—' ? 1 : b.code === '—' ? -1 : a.code.localeCompare(b.code)));

  const monthTotals = Array(12).fill(0).map((_, i) => Math.round(sections.reduce((s, sec) => s + sec.monthly[i], 0) * 100) / 100);
  return { months: ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'], sections, monthTotals };
}
