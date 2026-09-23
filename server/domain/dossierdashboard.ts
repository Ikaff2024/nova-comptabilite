import type { Client } from '../db.js';
import * as acc from './accounting.js';
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
  // Même règle que partout ailleurs (acc.exerciceCourant) : l'exercice courant
  // est celui qui couvre la date du jour, pas le premier « non clôturé » venu.
  const fy = (fiscalYearId && fys.find((f: any) => f.id === fiscalYearId))
    || acc.exerciceCourant(fys as any)
    || null;

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
  // TRÉSORERIE — toute la classe 5, virements internes COMPRIS.
  //
  // J'avais d'abord exclu les comptes 58x « virements de fonds », en les prenant
  // pour du transit sans valeur. C'est faux, et l'arithmétique le montre : sur un
  // virement banque → caisse dont seule la première étape est passée, l'argent
  // EST dans le 585. Sur un dossier à 3 000 000 :
  //
  //     avec le 585 : 3 000 000   ← l'argent existe toujours
  //     sans le 585 : 1 000 000   ← 2 000 000 volatilisés
  //
  // Exclure le 58 ferait donc plonger la trésorerie affichée pendant tout
  // virement en cours. On garde la classe 5 entière.
  //
  // Ce que demandait l'audit (constat N06) n'était pas d'exclure des comptes,
  // mais que « la définition de trésorerie précise les comptes retenus ». On
  // expose donc la définition ET le solde des virements internes : à une date
  // d'arrêté, un 58 non nul est une anomalie — un virement parti sans arriver —
  // et le contrôle de révision « virements non soldés » le signale déjà.
  const tresorerie = bal.filter((r: any) => r.class_no === 5)
    .reduce((s: number, r: any) => s + Number(r.balance), 0);
  const virementsNonSoldes = bal
    .filter((r: any) => /^58/.test(String(r.account_code ?? '')))
    .reduce((s: number, r: any) => s + Number(r.balance), 0);
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
  // Constat N07 de l'audit externe : le classement se faisait sur le SENS du
  // solde, pas sur la NATURE du tiers. Un fournisseur à qui l'on a versé une
  // avance présente un solde débiteur — il apparaissait donc dans « Top
  // clients », et un client en trop-perçu (avoir, acompte) dans « Top
  // fournisseurs ». Le tableau de bord affichait des noms manifestement faux,
  // ce qui est le genre de détail qui fait douter de tout le reste.
  //
  // On croise désormais les deux : la nature du tiers décide de la liste, le
  // sens du solde décide de la présence. Un client débiteur est une créance ;
  // un client créditeur (il nous doit d'être remboursé) n'est pas une créance
  // et n'a rien à faire dans un palmarès de créances — il relève du contrôle
  // de révision, pas du tableau de bord.
  const palmares = (nature: string, sens: 1 | -1) => cps
    .filter((r: any) => r.type === nature && Number(r.balance) * sens > 0)
    .map((r: any) => ({ name: r.name, amount: Math.abs(Number(r.balance)) }))
    .sort((a, b) => b.amount - a.amount).slice(0, 5);

  const topClients = palmares('client', 1);
  const topFournisseurs = palmares('fournisseur', -1);

  // Les tiers à solde « à contre-sens » : un client créditeur ou un fournisseur
  // débiteur. Ce n'est pas une anomalie en soi (avance versée, avoir à établir),
  // mais cela se signale au lieu de se cacher dans le mauvais palmarès.
  const tiersAContreSens = cps
    .filter((r: any) => (r.type === 'client' && Number(r.balance) < 0)
                     || (r.type === 'fournisseur' && Number(r.balance) > 0))
    .map((r: any) => ({
      name: r.name,
      type: r.type,
      amount: Math.abs(Number(r.balance)),
      motif: r.type === 'client'
        ? 'client à solde créditeur (acompte reçu ou avoir à établir)'
        : 'fournisseur à solde débiteur (avance versée ou avoir à recevoir)',
    }))
    .sort((a, b) => b.amount - a.amount).slice(0, 5);

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
  // Les brouillons se valident dans Révision, pas dans Saisie — l'onglet Saisie
  // sert à créer une écriture, il n'affiche pas celles qui attendent.
  if (drafts > 0) alerts.push({ level: 'warn', message: `${drafts} écriture(s) en brouillon à valider`, tab: 'revision' });
  if (vat.netDue > 0) alerts.push({ level: 'warn', message: `TVA à déclarer ce mois : ${Math.round(vat.netDue)}`, tab: 'fiscalite' });
  if (assetsPending > 0) alerts.push({ level: 'info', message: `${assetsPending} immobilisation(s) avec dotation en attente`, tab: 'immos' });
  if (overdue90 > 0) alerts.push({ level: 'warn', message: `Créances de plus de 90 jours : ${Math.round(overdue90)}`, tab: 'tiers' });
  if (fy && fy.status !== 'closed' && new Date(fy.end_date) < new Date()) alerts.push({ level: 'info', message: `Exercice ${fy.label} échu — clôture possible`, tab: 'journaux' });

  return {
    fiscalYear: fy ? { id: fy.id, label: fy.label } : null,
    kpis: { resultat, chiffreAffaires, tresorerie, creances, dettesFrs, vncTotal },
    // Périmètre explicite des chiffres affichés : sans lui, un dirigeant ne
    // peut pas rapprocher cette carte de sa balance (constat N06).
    tresorerieDefinition: {
      libelle: 'Comptes de classe 5 : banques, caisses, Mobile Money et virements internes',
      virementsNonSoldes,
    },
    activity: { posted, drafts, thisMonth: Number(act[0].this_month), autoPct },
    vat: { collectee: vat.collectee, deductible: vat.deductible, netDue: vat.netDue, creditReportable: vat.creditReportable, period: mr.ym },
    monthly,
    topClients, topFournisseurs, tiersAContreSens,
    aged: { overdue90 },
    recent: recent.map((r: any) => ({ ...r, amount: Number(r.amount) })),
    alerts,
  };
}
