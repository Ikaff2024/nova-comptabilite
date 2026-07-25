import type { Client } from '../db.js';
import { vatDeclaration } from './tax.js';
import { agedBalance } from './lettrage.js';
import { listAssets } from './assets.js';
import { carryForwardFiscalYears, NOT_CARRY_FORWARD } from './carryforward.js';

// ============================================================================
// Tableau de bord par entreprise (dossier) : agrège les données déjà calculées
// (résultat, trésorerie, TVA du mois, tiers, balance âgée, immos, automatisation)
// en une vue de pilotage. Aucune écriture — lecture seule.
// ============================================================================

const AUTO_SOURCES = ['ocr', 'mobile_money', 'bank_import', 'recurring', 'api'];

function monthRange(d: Date): { from: string; to: string; ym: string } {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}`, ym: `${y}-${mm}` };
}

export async function dossierDashboard(c: Client, dossierId: string, fiscalYearId?: string) {
  // Exercice de référence : celui fourni, sinon l'exercice ouvert le plus récent.
  const { rows: fys } = await c.query(
    'select id, label, start_date, end_date, status from fiscal_years where dossier_id=$1 order by start_date desc', [dossierId]);
  const fy = (fiscalYearId && fys.find((f: any) => f.id === fiscalYearId)) || fys.find((f: any) => f.status !== 'closed') || fys[0] || null;

  // --- Soldes cumulés par compte (position bilancielle : trésorerie, tiers) ---
  // Position à la clôture de l'exercice affiché : on cumule les écritures
  // jusqu'à sa date de fin, en écartant les à-nouveaux de report qui
  // rejoueraient les exercices déjà clos (cf. domain/carryforward.ts). Ce calcul
  // reste juste que les exercices précédents aient été clôturés ou non.
  const cf = await carryForwardFiscalYears(c, dossierId);
  const { rows: bal } = await c.query(
    `select a.account_code, a.class_no, coalesce(sum(l.amount_debit - l.amount_credit),0) as balance
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where l.dossier_id = $1 and ${NOT_CARRY_FORWARD(2)}
        and ($3::date is null or e.entry_date <= $3::date)
      group by a.account_code, a.class_no`, [dossierId, cf, fy?.end_date ?? null]);
  const tresorerie = bal.filter((r: any) => r.class_no === 5).reduce((s: number, r: any) => s + Number(r.balance), 0);
  const creances = bal.filter((r: any) => r.account_code.startsWith('41') && Number(r.balance) > 0).reduce((s: number, r: any) => s + Number(r.balance), 0);
  const dettesFrs = -bal.filter((r: any) => r.account_code.startsWith('40') && Number(r.balance) < 0).reduce((s: number, r: any) => s + Number(r.balance), 0);

  // --- Compte de résultat de l'exercice (P&L) ---
  const fyParams: any[] = [dossierId];
  let fyWhere = "l.dossier_id=$1";
  if (fy) { fyParams.push(fy.id); fyWhere += ` and e.fiscal_year_id=$${fyParams.length}`; }
  const { rows: pl } = await c.query(
    `select
        coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no=7),0) as produits,
        coalesce( sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges,
        coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.account_code like '70%'),0) as ca
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where ${fyWhere}`, fyParams);
  const produits = Number(pl[0].produits), charges = Number(pl[0].charges), chiffreAffaires = Number(pl[0].ca);
  const resultat = produits - charges;

  // --- Activité (compteurs + automatisation), sur l'exercice affiché ---
  const { rows: act } = await c.query(
    `select
        count(*) filter (where status='posted') as posted,
        count(*) filter (where status='draft') as drafts,
        count(*) filter (where status='posted' and source = any($2)) as auto,
        count(*) filter (where status='posted' and entry_date >= date_trunc('month', current_date)) as this_month
       from entries where dossier_id=$1 and ($3::uuid is null or fiscal_year_id=$3::uuid)`,
    [dossierId, AUTO_SOURCES, fy?.id ?? null]);
  const posted = Number(act[0].posted), drafts = Number(act[0].drafts);
  const autoPct = posted ? Math.round((Number(act[0].auto) / posted) * 100) : 0;

  // --- Tendance 12 mois (produits / charges) ---
  const { rows: trend } = await c.query(
    `select to_char(e.entry_date,'YYYY-MM') as ym,
        coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no=7),0) as produits,
        coalesce( sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where l.dossier_id=$1 and e.entry_date >= (date_trunc('month', current_date) - interval '11 months')
      group by ym order by ym`, [dossierId]);
  const monthly = trend.map((r: any) => {
    const p = Number(r.produits), ch = Number(r.charges);
    return { month: r.ym, produits: p, charges: ch, resultat: p - ch };
  });

  // --- Top clients / fournisseurs (par solde auxiliaire, même assiette) ---
  const { rows: cps } = await c.query(
    `select cp.name, cp.type, coalesce(sum(l.amount_debit - l.amount_credit),0) as balance
       from entry_lines l
       join counterparties cp on cp.id = l.counterparty_id
       join entries e on e.id = l.entry_id and e.status='posted'
      where l.dossier_id=$1 and ${NOT_CARRY_FORWARD(2)}
        and ($3::date is null or e.entry_date <= $3::date)
      group by cp.name, cp.type having coalesce(sum(l.amount_debit - l.amount_credit),0) <> 0`,
    [dossierId, cf, fy?.end_date ?? null]);
  const topClients = cps.filter((r: any) => Number(r.balance) > 0).map((r: any) => ({ name: r.name, amount: Number(r.balance) }))
    .sort((a: any, b: any) => b.amount - a.amount).slice(0, 5);
  const topFournisseurs = cps.filter((r: any) => Number(r.balance) < 0).map((r: any) => ({ name: r.name, amount: -Number(r.balance) }))
    .sort((a: any, b: any) => b.amount - a.amount).slice(0, 5);

  // --- TVA du mois courant ---
  const mr = monthRange(new Date());
  const vat = await vatDeclaration(c, dossierId, mr.from, mr.to);

  // --- Balance âgée (retards de règlement) ---
  const aged = await agedBalance(c, dossierId);
  const overdue90 = aged.reduce((s: number, r: any) => s + (r.b90_plus > 0 ? r.b90_plus : 0), 0);

  // --- Immobilisations (dotations en attente) ---
  const assets = await listAssets(c, dossierId);
  const assetsPending = assets.filter((a: any) => (a.pending ?? 0) > 0).length;
  const vncTotal = assets.reduce((s: number, a: any) => s + a.vnc, 0);

  // --- Dernières écritures ---
  const { rows: recent } = await c.query(
    `select to_char(e.entry_date,'YYYY-MM-DD') as date, e.piece_ref, e.description, e.source, j.code as journal,
            coalesce((select sum(amount_debit) from entry_lines where entry_id=e.id),0) as amount
       from entries e join journals j on j.id=e.journal_id
      where e.dossier_id=$1 and e.status='posted'
        and ($2::uuid is null or e.fiscal_year_id=$2::uuid)
      order by e.entry_date desc, e.created_at desc limit 8`, [dossierId, fy?.id ?? null]);

  // --- Alertes ---
  const alerts: { level: 'info' | 'warn'; message: string; tab?: string }[] = [];
  if (drafts > 0) alerts.push({ level: 'warn', message: `${drafts} écriture(s) en brouillon à valider`, tab: 'saisie' });
  if (vat.netDue > 0) alerts.push({ level: 'warn', message: `TVA à déclarer ce mois : ${Math.round(vat.netDue)}`, tab: 'fiscalite' });
  if (assetsPending > 0) alerts.push({ level: 'info', message: `${assetsPending} immobilisation(s) avec dotation en attente`, tab: 'immos' });
  if (overdue90 > 0) alerts.push({ level: 'warn', message: `Créances de plus de 90 jours : ${Math.round(overdue90)}`, tab: 'tiers' });
  if (fy && fy.status !== 'closed' && new Date(fy.end_date) < new Date()) alerts.push({ level: 'info', message: `Exercice ${fy.label} échu — clôture possible`, tab: 'journaux' });

  return {
    fiscalYear: fy ? { id: fy.id, label: fy.label } : null,
    kpis: { resultat, chiffreAffaires, tresorerie, creances, dettesFrs, vncTotal },
    activity: { posted, drafts, thisMonth: Number(act[0].this_month), autoPct },
    vat: { collectee: vat.collectee, deductible: vat.deductible, netDue: vat.netDue, creditReportable: vat.creditReportable, period: mr.ym },
    monthly,
    topClients, topFournisseurs,
    aged: { overdue90 },
    recent: recent.map((r: any) => ({ ...r, amount: Number(r.amount) })),
    alerts,
  };
}
