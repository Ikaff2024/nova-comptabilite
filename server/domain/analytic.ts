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
