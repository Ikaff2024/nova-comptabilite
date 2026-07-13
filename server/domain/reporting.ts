import type { Client } from '../db.js';
import { sectionsPdf } from '../documents/pdf.js';

// ============================================================================
// Reporting mensuel : analyse comparée (mois vs mois précédent, cumul annuel),
// ratios clés et principales charges — pour un commentaire de pilotage et un
// rapport PDF. S'appuie sur les écritures comptabilisées (classes 6/7 pour le
// résultat, 5/41/40 pour la situation).
// ============================================================================

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const grp = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pct = (cur: number, prev: number): number | null => (prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10);

interface PL { produits: number; charges: number; ca: number; resultat: number }

async function plRange(c: Client, dossierId: string, from: string, to: string): Promise<PL> {
  const { rows } = await c.query(
    `select
        coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no=7),0) as produits,
        coalesce( sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges,
        coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.account_code like '70%'),0) as ca
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where l.dossier_id=$1 and e.entry_date >= $2 and e.entry_date <= $3`, [dossierId, from, to]);
  const produits = Number(rows[0].produits), charges = Number(rows[0].charges), ca = Number(rows[0].ca);
  return { produits, charges, ca, resultat: produits - charges };
}

const ymd = (y: number, m0: number, d: number) => `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();

export async function monthlyReport(c: Client, dossierId: string, year: number, month0: number): Promise<any> {
  const from = ymd(year, month0, 1);
  const to = ymd(year, month0, lastDay(year, month0));
  const py = month0 === 0 ? year - 1 : year; const pm = month0 === 0 ? 11 : month0 - 1;
  const pFrom = ymd(py, pm, 1); const pTo = ymd(py, pm, lastDay(py, pm));

  const courant = await plRange(c, dossierId, from, to);
  const precedent = await plRange(c, dossierId, pFrom, pTo);
  const ytd = await plRange(c, dossierId, ymd(year, 0, 1), to);

  // Situation à fin de mois (cumul jusqu'à `to`).
  const { rows: sit } = await c.query(
    `select
        coalesce( sum(l.amount_debit - l.amount_credit) filter (where a.class_no=5),0) as tresorerie,
        coalesce( sum(l.amount_debit - l.amount_credit) filter (where a.account_code like '41%'),0) as creances,
        coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.account_code like '40%'),0) as dettes
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where l.dossier_id=$1 and e.entry_date <= $2`, [dossierId, to]);
  const situation = { tresorerie: Number(sit[0].tresorerie), creances: Number(sit[0].creances), dettes: Number(sit[0].dettes) };

  // Principales charges du mois (comptes de classe 6).
  const { rows: tc } = await c.query(
    `select a.account_code as code, a.label, sum(l.amount_debit - l.amount_credit) as montant
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where l.dossier_id=$1 and a.class_no=6 and e.entry_date >= $2 and e.entry_date <= $3
      group by a.account_code, a.label having sum(l.amount_debit - l.amount_credit) <> 0
      order by montant desc limit 5`, [dossierId, from, to]);
  const topCharges = tc.map((r: any) => ({ code: r.code, label: r.label, montant: Number(r.montant) }));

  return {
    periode: { annee: year, mois: month0 + 1, label: `${MOIS[month0]} ${year}` },
    courant, precedent, ytd, situation, topCharges,
    variations: {
      ca: { abs: courant.ca - precedent.ca, pct: pct(courant.ca, precedent.ca) },
      charges: { abs: courant.charges - precedent.charges, pct: pct(courant.charges, precedent.charges) },
      resultat: { abs: courant.resultat - precedent.resultat, pct: pct(courant.resultat, precedent.resultat) },
    },
    ratios: {
      marge_nette_pct: courant.ca ? Math.round((courant.resultat / courant.ca) * 1000) / 10 : null,
      taux_charges_pct: courant.produits ? Math.round((courant.charges / courant.produits) * 1000) / 10 : null,
    },
  };
}

export async function rapportMensuelPdf(c: Client, dossierId: string, year: number, month0: number): Promise<{ filename: string; buffer: Buffer }> {
  const { rows: dr } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = dr[0]?.j ?? {};
  const cur = d.base_currency ?? 'XOF';
  const money = (n: number) => `${grp(n)} ${cur}`;
  const withVar = (n: number, v: { pct: number | null }) => `${money(n)}${v.pct != null ? ` (${v.pct >= 0 ? '+' : ''}${v.pct}% vs M-1)` : ''}`;
  const r = await monthlyReport(c, dossierId, year, month0);

  const meta = [`${d.raison_sociale ?? ''} · ${r.periode.label}`];
  if (d.tax_id || d.rccm) meta.push([d.tax_id ? `NCC/IFU : ${d.tax_id}` : '', d.rccm ? `RCCM : ${d.rccm}` : ''].filter(Boolean).join(' · '));

  const buffer = await sectionsPdf({
    title: 'Rapport mensuel de gestion',
    subtitle: `${d.raison_sociale ?? ''} · ${r.periode.label}`,
    meta,
    sections: [
      { heading: `Résultat du mois — ${r.periode.label}`, rows: [
        ["Chiffre d'affaires", withVar(r.courant.ca, r.variations.ca)],
        ['Produits', money(r.courant.produits)],
        ['Charges', withVar(r.courant.charges, r.variations.charges)],
      ], total: ['Résultat du mois', withVar(r.courant.resultat, r.variations.resultat)] },
      { heading: 'Cumul annuel (depuis janvier)', rows: [
        ["Chiffre d'affaires cumulé", money(r.ytd.ca)],
        ['Charges cumulées', money(r.ytd.charges)],
      ], total: ['Résultat cumulé', money(r.ytd.resultat)] },
      { heading: 'Ratios clés', rows: [
        ['Marge nette', r.ratios.marge_nette_pct != null ? `${r.ratios.marge_nette_pct}%` : 'n/a'],
        ['Taux de charges (charges/produits)', r.ratios.taux_charges_pct != null ? `${r.ratios.taux_charges_pct}%` : 'n/a'],
      ] },
      { heading: 'Situation à fin de mois', rows: [
        ['Trésorerie', money(r.situation.tresorerie)],
        ['Créances clients', money(r.situation.creances)],
        ['Dettes fournisseurs', money(r.situation.dettes)],
      ] },
      { heading: 'Principales charges du mois', rows: r.topCharges.length ? r.topCharges.map((t: any) => [`${t.code} ${t.label}`, money(t.montant)]) : [['—', '—']] as [string, string][] },
    ],
    footNote: 'Rapport généré par Lexa (Nova Comptabilité) à partir des écritures comptabilisées.',
  });
  return { filename: `rapport-mensuel-${year}-${String(month0 + 1).padStart(2, '0')}.pdf`, buffer };
}
