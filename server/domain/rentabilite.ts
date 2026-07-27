import type { Client } from '../db.js';
import { listAssets } from './assets.js';

// ============================================================================
// Rentabilité par ACTIVITÉ : ce que chaque activité rapporte, ce qu'elle coûte,
// et ce qu'elle a demandé d'investir.
//
// L'analytique répond déjà à « combien cette activité a-t-elle produit et
// dépensé cette année ». Elle ne dit rien de l'investissement : le camion de
// l'agence, le four de l'atelier, le logiciel du produit. Or c'est précisément
// ce qui manque pour juger — une activité peut dégager une belle marge et
// n'avoir jamais remboursé ce qu'elle a coûté à mettre en place.
//
// D'où le rapprochement fait ici, pour chaque section :
//   • le résultat de l'EXERCICE (produits, charges, marge) ;
//   • le résultat CUMULÉ depuis l'origine — les classes 6 et 7 ne portent pas
//     d'à-nouveaux, leur cumul toutes périodes est donc directement lisible ;
//   • l'INVESTISSEMENT : immobilisations rattachées (valeur d'origine, VNC,
//     dotation de l'exercice) et chantiers encore en cours ;
//   • le RETOUR : marge cumulée rapportée à l'investissement.
//
// Le retour est un indicateur de gestion, pas un poste comptable : il n'est
// calculé que lorsqu'il y a un investissement à rapporter, et présenté comme
// une lecture, jamais comme une vérité arrêtée.
// ============================================================================

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ActiviteRentabilite {
  code: string;
  libelle: string;
  exercice: { produits: number; charges: number; marge: number; tauxMarge: number | null };
  cumul: { produits: number; charges: number; marge: number };
  investissement: {
    immobilise: number;      // valeur d'origine des immobilisations rattachées
    vnc: number;             // ce qu'il en reste au bilan
    dotationExercice: number;
    enCours: number;         // chantiers de production interne non encore mis en service
    total: number;           // immobilisé + en cours
    nbImmobilisations: number;
  };
  retour: { ratio: number | null; commentaire: string };
}

export interface RapportRentabilite {
  exercice: { id: string; label: string } | null;
  activites: ActiviteRentabilite[];
  totaux: { margeExercice: number; margeCumulee: number; investissement: number; vnc: number };
  sansSection: { produits: number; charges: number; marge: number } | null;
}

export async function rentabiliteParActivite(
  c: Client, dossierId: string, fiscalYearId?: string,
): Promise<RapportRentabilite> {
  const { rows: fy } = await c.query(
    'select id, label from fiscal_years where dossier_id=$1 and ($2::uuid is null or id=$2::uuid) order by start_date desc limit 1',
    [dossierId, fiscalYearId ?? null]);

  // Produits et charges par section : sur l'exercice, et depuis l'origine.
  const { rows: pl } = await c.query(
    `select coalesce(nullif(l.analytic_axis, ''), '') as section,
            coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no = 7 and ($2::uuid is null or e.fiscal_year_id = $2::uuid)), 0) as produits_ex,
            coalesce( sum(l.amount_debit - l.amount_credit) filter (where a.class_no = 6 and ($2::uuid is null or e.fiscal_year_id = $2::uuid)), 0) as charges_ex,
            coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no = 7), 0) as produits_cum,
            coalesce( sum(l.amount_debit - l.amount_credit) filter (where a.class_no = 6), 0) as charges_cum
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id and a.class_no in (6, 7)
      where l.dossier_id = $1
      group by section`,
    [dossierId, fiscalYearId ?? null]);

  const { rows: secs } = await c.query(
    'select code, label from analytic_sections where dossier_id=$1 order by code', [dossierId]);

  // Immobilisations rattachées : valeur d'origine, VNC, dotation de l'exercice.
  const assets: any[] = await listAssets(c, dossierId);
  // Dotations COMPTABILISÉES sur l'exercice, par immobilisation : on lit ce qui
  // a été passé, pas ce qui était prévu au plan d'amortissement.
  const { rows: dots } = await c.query(
    `select d.fixed_asset_id, coalesce(sum(d.amount), 0) as dotation
       from fixed_asset_depreciations d
      where d.dossier_id = $1
        and ($2::uuid is null or d.period_date between
             (select start_date from fiscal_years where id = $2::uuid)
         and (select end_date   from fiscal_years where id = $2::uuid))
      group by d.fixed_asset_id`,
    [dossierId, fy[0]?.id ?? null]);
  const dotationDe = new Map<string, number>(dots.map((d: any) => [d.fixed_asset_id, Number(d.dotation)]));

  const { rows: wips } = await c.query(
    `select w.analytic_section, coalesce(sum(k.amount), 0) as cumul
       from assets_in_progress w
       left join assets_in_progress_costs k on k.wip_id = w.id
      where w.dossier_id = $1 and w.commissioned_on is null
      group by w.analytic_section`,
    [dossierId]);

  const parSection = new Map<string, ActiviteRentabilite>();
  const cle = (s: string) => s || '';

  const init = (code: string, libelle: string): ActiviteRentabilite => ({
    code, libelle,
    exercice: { produits: 0, charges: 0, marge: 0, tauxMarge: null },
    cumul: { produits: 0, charges: 0, marge: 0 },
    investissement: { immobilise: 0, vnc: 0, dotationExercice: 0, enCours: 0, total: 0, nbImmobilisations: 0 },
    retour: { ratio: null, commentaire: '' },
  });

  for (const s of secs) parSection.set(s.code, init(s.code, s.label));

  let sansSection: RapportRentabilite['sansSection'] = null;
  for (const r of pl) {
    const code = cle(r.section);
    const pex = r2(Number(r.produits_ex)), cex = r2(Number(r.charges_ex));
    const pcu = r2(Number(r.produits_cum)), ccu = r2(Number(r.charges_cum));
    if (!code) {
      sansSection = { produits: pex, charges: cex, marge: r2(pex - cex) };
      continue;
    }
    const a = parSection.get(code) ?? init(code, code);
    a.exercice = { produits: pex, charges: cex, marge: r2(pex - cex), tauxMarge: pex ? r2(((pex - cex) / pex) * 100) : null };
    a.cumul = { produits: pcu, charges: ccu, marge: r2(pcu - ccu) };
    parSection.set(code, a);
  }

  for (const asset of assets) {
    const code = cle(asset.analyticSection ?? asset.analytic_section ?? '');
    if (!code) continue;
    const a = parSection.get(code) ?? init(code, code);
    a.investissement.immobilise = r2(a.investissement.immobilise + Number(asset.amount ?? 0));
    a.investissement.vnc = r2(a.investissement.vnc + Number(asset.vnc ?? 0));
    a.investissement.nbImmobilisations += 1;
    a.investissement.dotationExercice = r2(a.investissement.dotationExercice + (dotationDe.get(asset.id) ?? 0));
    parSection.set(code, a);
  }

  for (const w of wips) {
    const code = cle(w.analytic_section ?? '');
    if (!code) continue;
    const a = parSection.get(code) ?? init(code, code);
    a.investissement.enCours = r2(a.investissement.enCours + Number(w.cumul));
    parSection.set(code, a);
  }

  const activites = [...parSection.values()].map((a) => {
    a.investissement.total = r2(a.investissement.immobilise + a.investissement.enCours);
    if (a.investissement.total > 0) {
      a.retour.ratio = r2((a.cumul.marge / a.investissement.total) * 100);
      a.retour.commentaire = a.cumul.marge >= a.investissement.total
        ? "L'activité a couvert son investissement."
        : a.cumul.marge > 0
          ? `Il reste ${r2(a.investissement.total - a.cumul.marge)} à couvrir.`
          : "L'activité n'a encore rien remboursé de son investissement.";
    } else {
      a.retour.commentaire = 'Aucun investissement rattaché à cette activité.';
    }
    return a;
  }).filter((a) => a.cumul.produits || a.cumul.charges || a.investissement.total)
    .sort((x, y) => y.cumul.marge - x.cumul.marge);

  return {
    exercice: fy[0] ? { id: fy[0].id, label: fy[0].label } : null,
    activites,
    totaux: {
      margeExercice: r2(activites.reduce((s, a) => s + a.exercice.marge, 0)),
      margeCumulee: r2(activites.reduce((s, a) => s + a.cumul.marge, 0)),
      investissement: r2(activites.reduce((s, a) => s + a.investissement.total, 0)),
      vnc: r2(activites.reduce((s, a) => s + a.investissement.vnc, 0)),
    },
    sansSection,
  };
}
