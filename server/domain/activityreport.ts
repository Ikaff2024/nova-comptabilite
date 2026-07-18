import type { Client } from '../db.js';
import { sectionsPdf } from '../documents/pdf.js';
import { monthlyReport } from './reporting.js';
import { dossierAlerts } from './alerts.js';
import { tableExists } from '../schema-cache.js';

// ============================================================================
// Rapport d'activité mensuel — le « digest d'employée » de Lexa. Au-delà des
// chiffres : ce que l'entreprise (et Lexa) a fait dans le mois, ce qui reste à
// traiter, les alertes et une recommandation. Différenciateur : c'est une
// comptable IA qui rend compte de son activité, pas un simple état financier.
// ============================================================================

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const grp = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function monthRange(year: number, month0: number): { from: string; to: string } {
  const last = new Date(year, month0 + 1, 0).getDate();
  const mm = String(month0 + 1).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}

export async function activityReport(c: Client, dossierId: string, year: number, month0: number): Promise<any> {
  const { from, to } = monthRange(year, month0);
  const { rows: dr } = await c.query('select raison_sociale, base_currency from dossiers where id=$1', [dossierId]);
  const d: any = dr[0] ?? {};
  const cur = d.base_currency ?? 'XOF';

  // --- Activité du mois (ce qui a été fait) ---
  const { rows: er } = await c.query(
    "select count(*)::int n from entries where dossier_id=$1 and status='posted' and entry_date between $2 and $3", [dossierId, from, to]);
  const ecritures = er[0]?.n ?? 0;

  let ventes = { n: 0, total: 0 }, achats = { n: 0, total: 0 }, paie = { n: 0 };
  if (await tableExists('invoices')) {
    const { rows } = await c.query(
      "select count(*)::int n, coalesce(sum(total_ttc),0) total from invoices where dossier_id=$1 and doc_type='invoice' and status<>'draft' and invoice_date between $2 and $3", [dossierId, from, to]);
    ventes = { n: rows[0].n, total: Number(rows[0].total) };
  }
  if (await tableExists('purchase_invoices')) {
    const { rows } = await c.query(
      "select count(*)::int n, coalesce(sum(total_ttc),0) total from purchase_invoices where dossier_id=$1 and status='recorded' and invoice_date between $2 and $3", [dossierId, from, to]);
    achats = { n: rows[0].n, total: Number(rows[0].total) };
  }
  if (await tableExists('payroll_payslips')) {
    const { rows } = await c.query(
      'select count(*)::int n from payroll_payslips where dossier_id=$1 and period_year=$2 and period_month=$3', [dossierId, year, month0 + 1]);
    paie = { n: rows[0].n };
  }

  // --- Ce que Lexa a fait (piste d'audit) ---
  const { rows: lr } = await c.query(
    `select count(*) filter (where action like 'lexa.%')::int as actions,
            count(*) filter (where action = 'agent.query')::int as echanges
       from audit_log where dossier_id=$1 and created_at >= $2::date and created_at < ($3::date + interval '1 day')`,
    [dossierId, from, to]);
  const lexa = { actions: lr[0]?.actions ?? 0, echanges: lr[0]?.echanges ?? 0 };

  // --- Chiffres clés + alertes (réutilise les moteurs existants) ---
  let chiffres: any = null;
  try { chiffres = await monthlyReport(c, dossierId, year, month0); } catch { /* best effort */ }
  let alertes: any[] = [];
  try { const a: any = await dossierAlerts(c, dossierId); alertes = a.alertes ?? []; } catch { /* best effort */ }

  // --- Recommandations (déterministes, dérivées des alertes prioritaires) ---
  const recommandations = alertes.slice(0, 3).map((a: any) => a.titre + (a.echeance ? ` (échéance ${a.echeance})` : ''));

  return {
    periode: `${MOIS[month0]} ${year}`, from, to, devise: cur, entreprise: d.raison_sociale ?? '',
    activite: { ecritures, ventes, achats, paie },
    lexa,
    chiffres: chiffres ? { produits: chiffres.courant?.produits, charges: chiffres.courant?.charges, resultat: chiffres.courant?.resultat, tresorerie: chiffres.situation?.tresorerie } : null,
    alertes: alertes.slice(0, 8),
    recommandations,
  };
}

export async function activityReportPdf(c: Client, dossierId: string, year: number, month0: number): Promise<{ filename: string; buffer: Buffer }> {
  const r = await activityReport(c, dossierId, year, month0);
  const money = (n: number) => `${grp(n)} ${r.devise}`;
  const sd = (n: number): [string, string][] => [];

  const sections: any[] = [
    {
      heading: "Activité du mois",
      rows: [
        ['Écritures comptabilisées', String(r.activite.ecritures)],
        ['Factures de vente émises', `${r.activite.ventes.n}${r.activite.ventes.total ? ` · ${money(r.activite.ventes.total)}` : ''}`],
        ['Factures d\'achat enregistrées', `${r.activite.achats.n}${r.activite.achats.total ? ` · ${money(r.activite.achats.total)}` : ''}`],
        ['Bulletins de paie', String(r.activite.paie.n)],
      ] as [string, string][],
    },
    {
      heading: "Ce que Lexa a fait",
      rows: [
        ['Actions exécutées par Lexa', String(r.lexa.actions)],
        ['Échanges (questions traitées)', String(r.lexa.echanges)],
      ] as [string, string][],
    },
  ];

  if (r.chiffres) {
    sections.push({
      heading: 'Chiffres clés du mois',
      rows: [
        ['Produits', money(r.chiffres.produits ?? 0)],
        ['Charges', money(r.chiffres.charges ?? 0)],
        ['Trésorerie', money(r.chiffres.tresorerie ?? 0)],
      ] as [string, string][],
      total: ['Résultat du mois', money(r.chiffres.resultat ?? 0)] as [string, string],
    });
  }

  if (r.alertes.length) {
    sections.push({
      heading: 'À traiter — points d\'attention',
      rows: r.alertes.map((a: any) => [`${a.niveau === 'haute' ? '● ' : ''}${a.titre}`, a.montant ? money(a.montant) : (a.echeance ?? '')]) as [string, string][],
    });
  }
  if (r.recommandations.length) {
    sections.push({
      heading: 'Recommandations de Lexa',
      rows: r.recommandations.map((t: string, i: number) => [`${i + 1}. ${t}`, '']) as [string, string][],
    });
  }
  void sd;

  const buffer = await sectionsPdf({
    title: "Rapport d'activité",
    subtitle: `${r.entreprise} · ${r.periode} · préparé par Lexa`,
    meta: [r.entreprise],
    sections,
    footNote: "Rapport d'activité mensuel généré par Lexa, la comptable IA de Nova. Synthèse de l'activité comptable, des points à traiter et des recommandations.",
  });
  const nom = String(r.entreprise || 'entreprise').replace(/\s+/g, '-');
  return { filename: `rapport-activite-${nom}-${year}-${String(month0 + 1).padStart(2, '0')}.pdf`, buffer };
}
