import type { Client } from '../db.js';

// ============================================================================
// Comptabilité analytique — PLUSIEURS AXES.
//
// Un dossier a un axe PRINCIPAL, créé d'office, plus autant d'axes secondaires
// qu'il en déclare : « Agence », « Activité », « Chantier ». La plupart n'en
// utiliseront qu'un et ne verront aucune différence.
//
// Où vit la valeur d'une ligne :
//   · axe principal   → entry_lines.analytic_axis (code de section, historique) ;
//   · axes suivants   → entry_line_analytics (jointure ligne × axe → section).
//
// Ce n'est pas une hésitation. Dix-sept chemins d'écriture alimentent déjà
// analytic_axis. Faire de cette colonne un miroir dénormalisé obligerait chacun
// d'eux à écrire aussi la ligne de jointure — et le jour où l'un l'oublie, l'axe
// disparaît des états en silence. En laissant la colonne faire foi pour l'axe
// principal, ces chemins restent justes sans être touchés, et la jointure ne
// porte que ce qui est nouveau.
//
// Conséquence assumée : les états lisent l'axe principal dans la colonne et les
// autres dans la jointure. Le branchement est ici, dans `sourceAxe()`, et nulle
// part ailleurs — les trois états le partagent.
// ============================================================================

export interface Axe { id: string; code: string; label: string; isPrimary: boolean; position: number; sections: number }

export async function listAxes(c: Client, dossierId: string): Promise<Axe[]> {
  const { rows } = await c.query(
    `select a.id, a.code, a.label, a.is_primary, a.position,
            (select count(*)::int from analytic_sections s where s.axis_id = a.id) as sections
       from analytic_axes a where a.dossier_id=$1
      order by a.is_primary desc, a.position, a.code`, [dossierId]);
  return rows.map((r: any) => ({
    id: r.id, code: r.code, label: r.label, isPrimary: r.is_primary, position: r.position, sections: r.sections,
  }));
}

async function axePrincipal(c: Client, dossierId: string): Promise<Axe> {
  const axes = await listAxes(c, dossierId);
  const p = axes.find((a) => a.isPrimary);
  if (!p) throw new Error("Ce dossier n'a pas d'axe analytique principal.");
  return p;
}

/** Résout l'axe demandé (id ou code) ; à défaut, l'axe principal. */
export async function resolveAxe(c: Client, dossierId: string, axis?: string): Promise<Axe> {
  if (!axis) return axePrincipal(c, dossierId);
  const axes = await listAxes(c, dossierId);
  const a = axes.find((x) => x.id === axis || x.code === axis);
  if (!a) throw new Error(`Axe analytique « ${axis} » introuvable.`);
  return a;
}

export async function createAxe(c: Client, dossierId: string, code: string, label: string): Promise<{ id: string }> {
  const cd = String(code ?? '').trim().toUpperCase();
  if (!cd) throw new Error("Code d'axe requis.");
  if (!label?.trim()) throw new Error('Intitulé requis.');
  const { rows: ex } = await c.query('select 1 from analytic_axes where dossier_id=$1 and code=$2', [dossierId, cd]);
  if (ex[0]) throw new Error(`L'axe ${cd} existe déjà.`);
  const { rows: n } = await c.query('select coalesce(max(position),0)+1 as p from analytic_axes where dossier_id=$1', [dossierId]);
  const { rows } = await c.query(
    'insert into analytic_axes(dossier_id, code, label, is_primary, position) values ($1,$2,$3,false,$4) returning id',
    [dossierId, cd, label.trim(), n[0].p]);
  return { id: rows[0].id };
}

export async function renameAxe(c: Client, dossierId: string, id: string, label: string): Promise<void> {
  if (!label?.trim()) throw new Error('Intitulé requis.');
  await c.query('update analytic_axes set label=$3 where dossier_id=$1 and id=$2', [dossierId, id, label.trim()]);
}

export async function deleteAxe(c: Client, dossierId: string, id: string): Promise<void> {
  const { rows } = await c.query('select is_primary from analytic_axes where dossier_id=$1 and id=$2', [dossierId, id]);
  if (!rows[0]) throw new Error('Axe introuvable.');
  // L'axe principal adosse entry_lines.analytic_axis : le supprimer laisserait
  // des codes de section orphelins dans le grand livre.
  if (rows[0].is_primary) throw new Error("L'axe principal ne se supprime pas : il porte la ventilation historique du grand livre.");
  const { rows: used } = await c.query(
    'select count(*)::int as n from entry_line_analytics where dossier_id=$1 and axis_id=$2', [dossierId, id]);
  if (used[0].n > 0) throw new Error(`${used[0].n} ligne(s) d'écriture sont ventilées sur cet axe. Retirez-les avant de le supprimer.`);
  await c.query('delete from analytic_axes where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Sections ----------------------------------------------------------------

/**
 * Sections d'un axe. Par défaut : celles de l'axe PRINCIPAL uniquement.
 *
 * Ce défaut n'est pas anodin. Six écrans (facturation, achats, banque, mobile
 * money, abonnements, production interne) appellent cette liste pour remplir un
 * champ qui alimente `analytic_axis`, c'est-à-dire l'axe principal. Leur rendre
 * les sections de TOUS les axes les ferait écrire, sans le savoir, une section
 * d'agence dans le champ activité. Le défaut restreint donc au principal, et
 * `axis='all'` demande explicitement tout.
 */
export async function listSections(c: Client, dossierId: string, axis?: string): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 's.dossier_id=$1';
  if (axis !== 'all') {
    const a = await resolveAxe(c, dossierId, axis);
    params.push(a.id); where += ` and s.axis_id=$${params.length}`;
  }
  const { rows } = await c.query(
    `select s.id, s.code, s.label, s.axis_id, a.code as axis_code, a.label as axis_label, a.is_primary as axis_is_primary
       from analytic_sections s join analytic_axes a on a.id = s.axis_id
      where ${where} order by a.is_primary desc, a.position, s.code`, params);
  return rows.map((r: any) => ({
    id: r.id, code: r.code, label: r.label,
    axisId: r.axis_id, axisCode: r.axis_code, axisLabel: r.axis_label, axisIsPrimary: r.axis_is_primary,
  }));
}

export async function createSection(c: Client, dossierId: string, code: string, label: string, axis?: string): Promise<{ id: string }> {
  const cd = String(code ?? '').trim();
  if (!cd) throw new Error('Code de section requis.');
  if (!label?.trim()) throw new Error('Intitulé requis.');
  const a = await resolveAxe(c, dossierId, axis);
  // Codes uniques par DOSSIER, pas par axe : entry_lines.analytic_axis stocke un
  // code nu, deux axes partageant un code rendraient la colonne ambiguë.
  const { rows: ex } = await c.query('select 1 from analytic_sections where dossier_id=$1 and code=$2', [dossierId, cd]);
  if (ex[0]) throw new Error(`La section ${cd} existe déjà dans ce dossier.`);
  const { rows } = await c.query(
    'insert into analytic_sections(dossier_id, code, label, axis_id) values ($1,$2,$3,$4) returning id',
    [dossierId, cd, label.trim(), a.id]);
  return { id: rows[0].id };
}

export async function deleteSection(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from analytic_sections where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Ventilation d'une ligne sur les axes secondaires -------------------------

/**
 * Pose (ou retire) la valeur d'un axe SECONDAIRE sur une ligne d'écriture.
 * sectionCode vide = on retire la ventilation sur cet axe.
 */
export async function setLineAxis(
  c: Client, dossierId: string, entryLineId: string, axis: string, sectionCode: string | null,
): Promise<void> {
  const a = await resolveAxe(c, dossierId, axis);
  if (a.isPrimary) throw new Error("L'axe principal se renseigne sur la ligne elle-même (analytic_axis), pas ici.");
  const { rows: ln } = await c.query('select 1 from entry_lines where id=$1 and dossier_id=$2', [entryLineId, dossierId]);
  if (!ln[0]) throw new Error("Ligne d'écriture introuvable.");

  if (!sectionCode) {
    await c.query('delete from entry_line_analytics where entry_line_id=$1 and axis_id=$2', [entryLineId, a.id]);
    return;
  }
  const { rows: s } = await c.query(
    'select id from analytic_sections where dossier_id=$1 and axis_id=$2 and code=$3', [dossierId, a.id, sectionCode]);
  if (!s[0]) throw new Error(`La section ${sectionCode} n'appartient pas à l'axe ${a.code}.`);
  await c.query(
    `insert into entry_line_analytics(entry_line_id, dossier_id, axis_id, section_id) values ($1,$2,$3,$4)
     on conflict (entry_line_id, axis_id) do update set section_id = excluded.section_id`,
    [entryLineId, dossierId, a.id, s[0].id]);
}

/** Ventilations secondaires d'une écriture, ligne par ligne. */
export async function entryAxes(c: Client, dossierId: string, entryId: string): Promise<Record<string, Record<string, string>>> {
  const { rows } = await c.query(
    `select ela.entry_line_id, a.code as axis_code, s.code as section_code
       from entry_line_analytics ela
       join entry_lines l on l.id = ela.entry_line_id
       join analytic_axes a on a.id = ela.axis_id
       join analytic_sections s on s.id = ela.section_id
      where ela.dossier_id=$1 and l.entry_id=$2`, [dossierId, entryId]);
  const out: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    (out[r.entry_line_id] ??= {})[r.axis_code] = r.section_code;
  }
  return out;
}

// --- Source SQL d'un axe : le seul endroit où le stockage se voit -------------

function sourceAxe(a: Axe, paramIndex: number): { select: string; joins: string; filtre: (p: number) => string } {
  if (a.isPrimary) {
    return {
      select: `coalesce(nullif(l.analytic_axis,''),'—')`,
      joins: '',
      filtre: (p) => `coalesce(nullif(l.analytic_axis,''),'—')=$${p}`,
    };
  }
  return {
    select: `coalesce(sx.code,'—')`,
    joins: `left join entry_line_analytics ela on ela.entry_line_id = l.id and ela.axis_id = $${paramIndex}
            left join analytic_sections sx on sx.id = ela.section_id`,
    filtre: (p) => `coalesce(sx.code,'—')=$${p}`,
  };
}

// --- États -------------------------------------------------------------------

// Résultat analytique : charges (cl.6) et produits (cl.7) par section, + non ventilé.
export async function analyticReport(c: Client, dossierId: string, fiscalYearId?: string, axis?: string) {
  const a = await resolveAxe(c, dossierId, axis);
  const params: any[] = [dossierId];
  if (!a.isPrimary) params.push(a.id);
  const src = sourceAxe(a, params.length);
  let where = "l.dossier_id=$1 and e.status='posted'";
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id=$${params.length}`; }

  const { rows } = await c.query(
    `select ${src.select} as section,
            coalesce(sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges,
            coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no=7),0) as produits
       from entry_lines l
       join entries e on e.id = l.entry_id
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
       ${src.joins}
      where ${where}
      group by section`,
    params,
  );
  const { rows: secs } = await c.query(
    'select code, label from analytic_sections where dossier_id=$1 and axis_id=$2', [dossierId, a.id]);
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
  return { axe: { id: a.id, code: a.code, label: a.label, isPrimary: a.isPrimary }, sections, totals };
}

// Grand livre analytique d'une section : les lignes de charges/produits (cl. 6/7)
// portant ce code, avec sous-totaux par compte. sectionCode = '—' pour le non ventilé.
export async function analyticDetail(c: Client, dossierId: string, sectionCode: string, fiscalYearId?: string, axis?: string) {
  const ax = await resolveAxe(c, dossierId, axis);
  const params: any[] = [dossierId];
  if (!ax.isPrimary) params.push(ax.id);
  const src = sourceAxe(ax, params.length);
  params.push(sectionCode);
  let where = `l.dossier_id=$1 and ${src.filtre(params.length)} and e.status='posted'`;
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
       ${src.joins}
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

  const { rows: sec } = await c.query(
    'select label from analytic_sections where dossier_id=$1 and axis_id=$2 and code=$3', [dossierId, ax.id, sectionCode]);
  const label = sectionCode === '—' ? 'Non ventilé' : (sec[0]?.label ?? sectionCode);
  return { axe: { id: ax.id, code: ax.code, label: ax.label, isPrimary: ax.isPrimary }, code: sectionCode, label, lines, byAccount, totals: { produits, charges, resultat: Math.round((produits - charges) * 100) / 100 } };
}

// Croisement section × mois : résultat analytique mensuel de chaque section
// sur l'exercice (ou toutes périodes). Utile pour repérer saisonnalité et dérives.
export async function analyticMonthly(c: Client, dossierId: string, fiscalYearId?: string, axis?: string) {
  const ax = await resolveAxe(c, dossierId, axis);
  const params: any[] = [dossierId];
  if (!ax.isPrimary) params.push(ax.id);
  const src = sourceAxe(ax, params.length);
  let where = "l.dossier_id=$1 and e.status='posted'";
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id=$${params.length}`; }

  // Regroupement par ANNÉE-MOIS, pas par numéro de mois. Deux raisons :
  //  · un exercice ne suit pas forcément l'année civile (avril → mars) ;
  //  · si des écritures d'années différentes sont rattachées au même exercice
  //    — exercice mal borné, écriture mal rattachée — juillet 2025 et juillet
  //    2026 se seraient additionnés dans la même case, sans que rien ne le dise.
  const { rows } = await c.query(
    `select ${src.select} as section,
            to_char(e.entry_date,'YYYY-MM') as mois,
            coalesce(sum(l.amount_credit - l.amount_debit) filter (where a.class_no=7),0) as produits,
            coalesce(sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges
       from entry_lines l
       join entries e on e.id = l.entry_id
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
       ${src.joins}
      where ${where}
      group by section, mois`,
    params,
  );

  const { rows: secs } = await c.query(
    'select code, label from analytic_sections where dossier_id=$1 and axis_id=$2', [dossierId, ax.id]);
  const labelOf = new Map(secs.map((s: any) => [s.code, s.label]));

  // Colonnes = les mois de l'EXERCICE, dans son ordre à lui. À défaut
  // d'exercice (lecture toutes périodes), on prend les mois réellement
  // rencontrés — un mois hors bornes apparaît alors en clair, au lieu de se
  // fondre dans une colonne homonyme.
  const ABR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const cles = new Set<string>(rows.map((r: any) => r.mois as string));
  if (fiscalYearId) {
    const { rows: fy } = await c.query(
      "select to_char(start_date,'YYYY-MM') as d1, to_char(end_date,'YYYY-MM') as d2 from fiscal_years where dossier_id=$1 and id=$2",
      [dossierId, fiscalYearId]);
    if (fy[0]) {
      let [y, mo] = fy[0].d1.split('-').map(Number);
      for (let i = 0; i < 24; i++) {
        const k = `${y}-${String(mo).padStart(2, '0')}`;
        cles.add(k);
        if (k === fy[0].d2) break;
        mo += 1; if (mo > 12) { mo = 1; y += 1; }
      }
    }
  }
  const mois = [...cles].sort();
  const index = new Map(mois.map((k, i) => [k, i]));
  const libelle = (k: string) => {
    const [y, mo] = k.split('-');
    return `${ABR[Number(mo) - 1]} ${y.slice(2)}`;
  };

  const bySection = new Map<string, number[]>();
  for (const r of rows) {
    const code = r.section as string;
    if (!bySection.has(code)) bySection.set(code, Array(mois.length).fill(0));
    const i = index.get(r.mois as string);
    if (i == null) continue;
    bySection.get(code)![i] = Math.round((Number(r.produits) - Number(r.charges)) * 100) / 100;
  }

  const sections = [...bySection.entries()].map(([code, monthly]) => ({
    code, label: code === '—' ? 'Non ventilé' : (labelOf.get(code) ?? code),
    monthly, total: Math.round(monthly.reduce((s, v) => s + v, 0) * 100) / 100,
  })).filter((s) => s.monthly.some((v) => v !== 0))
    .sort((a, b) => (a.code === '—' ? 1 : b.code === '—' ? -1 : a.code.localeCompare(b.code)));

  const monthTotals = mois.map((_, i) => Math.round(sections.reduce((s, sec) => s + sec.monthly[i], 0) * 100) / 100);
  return { axe: { id: ax.id, code: ax.code, label: ax.label, isPrimary: ax.isPrimary }, months: mois.map(libelle), sections, monthTotals };
}

// Croisement de DEUX axes : le tableau que le mono-axe interdisait. Résultat par
// (valeur axe A) × (valeur axe B) — « le chantier Riviera, mais sur l'agence de
// Cocody ». C'est la raison d'être de la structure ; sans lui, deux axes ne sont
// que deux lectures séparées.
export async function analyticCross(c: Client, dossierId: string, axisA: string, axisB: string, fiscalYearId?: string) {
  const a = await resolveAxe(c, dossierId, axisA);
  const b = await resolveAxe(c, dossierId, axisB);
  if (a.id === b.id) throw new Error('Croiser un axe avec lui-même ne dit rien de plus que sa propre lecture.');

  const params: any[] = [dossierId];
  if (!a.isPrimary) params.push(a.id);
  const srcA = sourceAxe(a, params.length);
  if (!b.isPrimary) params.push(b.id);
  // Le deuxième axe a besoin de ses propres alias de jointure.
  const srcB = b.isPrimary
    ? { select: `coalesce(nullif(l.analytic_axis,''),'—')`, joins: '' }
    : {
      select: `coalesce(sy.code,'—')`,
      joins: `left join entry_line_analytics elb on elb.entry_line_id = l.id and elb.axis_id = $${params.length}
              left join analytic_sections sy on sy.id = elb.section_id`,
    };

  let where = "l.dossier_id=$1 and e.status='posted'";
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id=$${params.length}`; }

  const { rows } = await c.query(
    `select ${srcA.select} as sa, ${srcB.select} as sb,
            coalesce(sum(l.amount_credit - l.amount_debit) filter (where a.class_no=7),0) as produits,
            coalesce(sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges
       from entry_lines l
       join entries e on e.id = l.entry_id
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
       ${srcA.joins}
       ${srcB.joins}
      where ${where}
      group by sa, sb`,
    params,
  );

  const { rows: secs } = await c.query(
    'select code, label, axis_id from analytic_sections where dossier_id=$1 and axis_id in ($2,$3)',
    [dossierId, a.id, b.id]);
  const labelOf = new Map(secs.map((s: any) => [`${s.axis_id}|${s.code}`, s.label]));
  const nom = (axeId: string, code: string) => (code === '—' ? 'Non ventilé' : (labelOf.get(`${axeId}|${code}`) ?? code));

  const codesA = [...new Set(rows.map((r: any) => r.sa as string))].sort((x, y) => (x === '—' ? 1 : y === '—' ? -1 : x.localeCompare(y)));
  const codesB = [...new Set(rows.map((r: any) => r.sb as string))].sort((x, y) => (x === '—' ? 1 : y === '—' ? -1 : x.localeCompare(y)));
  const iB = new Map(codesB.map((k, i) => [k, i]));

  const grille = codesA.map((ca) => ({
    code: ca, label: nom(a.id, ca),
    cells: Array(codesB.length).fill(0) as number[],
    total: 0,
  }));
  const iA = new Map(codesA.map((k, i) => [k, i]));
  for (const r of rows) {
    const li = iA.get(r.sa as string)!, ci = iB.get(r.sb as string)!;
    const v = Math.round((Number(r.produits) - Number(r.charges)) * 100) / 100;
    grille[li].cells[ci] += v;
    grille[li].total += v;
  }
  for (const g of grille) {
    g.cells = g.cells.map((v) => Math.round(v * 100) / 100);
    g.total = Math.round(g.total * 100) / 100;
  }
  const colonnes = codesB.map((cb) => ({ code: cb, label: nom(b.id, cb) }));
  const totauxColonnes = colonnes.map((_, i) => Math.round(grille.reduce((s, g) => s + g.cells[i], 0) * 100) / 100);

  return {
    axeA: { id: a.id, code: a.code, label: a.label },
    axeB: { id: b.id, code: b.code, label: b.label },
    colonnes, lignes: grille, totauxColonnes,
    total: Math.round(grille.reduce((s, g) => s + g.total, 0) * 100) / 100,
  };
}
