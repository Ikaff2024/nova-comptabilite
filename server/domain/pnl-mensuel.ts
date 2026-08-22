import type { Client } from '../db.js';
import { calculerEtats, type SoldeCompte } from './etats-officiels.js';
import { COMPTE_DE_RESULTAT, matchExpression, type PosteEtat } from './etats-postes.js';

// ============================================================================
// COMPTE DE RÉSULTAT MENSUALISÉ — l'outil de revue des arrêtés.
//
// Un compte de résultat annuel dit COMBIEN. Il ne dit pas QUAND, et c'est le
// quand qui fait trouver les erreurs : un loyer qui apparaît onze fois au lieu
// de douze, une prime qui tombe deux fois en juillet, un chiffre d'affaires
// qui s'effondre en mars sans raison. Ces anomalies sont invisibles dans un
// total annuel — elles sautent aux yeux dans une grille à douze colonnes.
//
// DEUX PRINCIPES.
//
// 1. Le mensuel ne réinvente pas le calcul. Chaque mois passe par le MÊME
//    moteur que le compte de résultat officiel (`calculerEtats`), avec les
//    mêmes postes et les mêmes formules transcrites du Praticien. La somme des
//    douze colonnes retombe donc sur l'état annuel par construction, et le
//    contrôle le vérifie à chaque appel plutôt que de l'espérer.
//
// 2. On descend jusqu'à l'écriture. Un écart repéré dans une case ne vaut que
//    si on peut l'ouvrir : poste → comptes → écritures, sans quitter l'écran et
//    sans avoir à deviner quel compte alimente quel poste.
//
// Convention de signe, héritée de l'état officiel : les charges sont NÉGATIVES.
// Tout s'additionne alors sans se poser de question, et un total positif est un
// bénéfice.
// ============================================================================

const r2 = (n: number) => Math.round(n * 100) / 100;
const ABR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

export interface MoisPnl { cle: string; libelle: string }
export interface LignePnl {
  ref: string; libelle: string; nature: PosteEtat['nature'];
  mensuel: number[]; total: number;
  /** Un poste se descend jusqu'aux écritures ; un solde intermédiaire, non. */
  detaillable: boolean;
}
export interface PnlMensuel {
  exercice: { id: string; label: string } | null;
  mois: MoisPnl[];
  lignes: LignePnl[];
  /** Le cumul des mois doit retomber sur le résultat annuel, au franc près. */
  controle: { cumulMensuel: number; resultatAnnuel: number; ecart: number; ok: boolean };
  comptesNonAffectes: { compte: string; intitule: string; solde: number }[];
}

const libelleMois = (cle: string) => {
  const [y, mo] = cle.split('-');
  return `${ABR[Number(mo) - 1]} ${y.slice(2)}`;
};

/**
 * Colonnes = les mois de l'EXERCICE, dans son ordre à lui (un exercice peut
 * courir d'avril à mars). S'y ajoutent les mois réellement rencontrés hors
 * bornes : plutôt que de les fondre dans une colonne voisine, on les montre —
 * une écriture mal datée doit se voir, pas se cacher.
 */
async function moisDeLExercice(
  c: Client, dossierId: string, fiscalYearId: string | undefined, rencontres: Set<string>,
): Promise<string[]> {
  const cles = new Set(rencontres);
  if (fiscalYearId) {
    const { rows } = await c.query(
      "select to_char(start_date,'YYYY-MM') as d1, to_char(end_date,'YYYY-MM') as d2 from fiscal_years where dossier_id=$1 and id=$2",
      [dossierId, fiscalYearId]);
    if (rows[0]) {
      let [y, mo] = rows[0].d1.split('-').map(Number);
      for (let i = 0; i < 24; i++) {
        const k = `${y}-${String(mo).padStart(2, '0')}`;
        cles.add(k);
        if (k === rows[0].d2) break;
        mo += 1; if (mo > 12) { mo = 1; y += 1; }
      }
    }
  }
  return [...cles].sort();
}

export async function pnlMensuel(
  c: Client, dossierId: string, fiscalYearId?: string,
): Promise<PnlMensuel> {
  const params: any[] = [dossierId];
  let where = 'l.dossier_id = $1';
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }

  // Seules les classes de gestion : le compte de résultat n'en connaît pas
  // d'autres, et les passer toutes ferait calculer un bilan mensuel qui n'a
  // aucun sens (des mouvements ne sont pas des soldes).
  const { rows } = await c.query(
    `select to_char(e.entry_date,'YYYY-MM') as mois, a.account_code, a.label,
            coalesce(sum(l.amount_debit - l.amount_credit), 0) as solde
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id and a.class_no in (6,7,8)
      where ${where}
      group by mois, a.account_code, a.label`,
    params);

  const mois = await moisDeLExercice(c, dossierId, fiscalYearId, new Set(rows.map((r: any) => r.mois as string)));
  const index = new Map(mois.map((k, i) => [k, i]));

  // Une balance de gestion par mois, passée au moteur officiel.
  const parMois: SoldeCompte[][] = mois.map(() => []);
  for (const r of rows) {
    const i = index.get(r.mois as string);
    if (i == null) continue;
    parMois[i].push({ code: r.account_code, label: r.label ?? '', solde: Number(r.solde) });
  }
  const etatsParMois = parMois.map((comptes) => calculerEtats(comptes));

  const lignes: LignePnl[] = COMPTE_DE_RESULTAT.map((p, k) => {
    const mensuel = etatsParMois.map((e) => r2(e.compteResultat[k]?.montant ?? 0));
    return {
      ref: p.ref, libelle: p.libelle, nature: p.nature,
      mensuel, total: r2(mensuel.reduce((s, v) => s + v, 0)),
      detaillable: p.nature === 'poste' && (p.comptes?.length ?? 0) > 0,
    };
  });

  // Contrôle d'articulation : le cumul des XI mensuels contre le XI annuel,
  // calculé par le même moteur sur la balance entière.
  const cumul = new Map<string, SoldeCompte>();
  for (const r of rows) {
    const cur = cumul.get(r.account_code) ?? { code: r.account_code, label: r.label ?? '', solde: 0 };
    cur.solde = r2(cur.solde + Number(r.solde));
    cumul.set(r.account_code, cur);
  }
  const annuel = calculerEtats([...cumul.values()]);
  const xiAnnuel = r2(annuel.compteResultat.find((x) => x.ref === 'XI')?.montant ?? 0);
  const xiMensuel = r2(lignes.find((x) => x.ref === 'XI')?.total ?? 0);

  const { rows: fy } = await c.query(
    'select id, label from fiscal_years where dossier_id=$1 and ($2::uuid is null or id=$2::uuid) order by start_date desc limit 1',
    [dossierId, fiscalYearId ?? null]);

  return {
    exercice: fy[0] ? { id: fy[0].id, label: fy[0].label } : null,
    mois: mois.map((cle) => ({ cle, libelle: libelleMois(cle) })),
    lignes,
    controle: {
      cumulMensuel: xiMensuel, resultatAnnuel: xiAnnuel,
      ecart: r2(xiMensuel - xiAnnuel), ok: Math.abs(xiMensuel - xiAnnuel) < 0.5,
    },
    comptesNonAffectes: annuel.comptesNonAffectes
      .filter((x) => x.etat === 'resultat')
      .map((x) => ({ compte: x.compte, intitule: x.intitule, solde: x.solde })),
  };
}

// --- Descente : poste → comptes → écritures ---------------------------------

export interface LigneDetailPnl {
  entryId: string; date: string; journal: string; pieceRef: string | null;
  compte: string; intitule: string; libelle: string;
  debit: number; credit: number; montant: number;
}
export interface DetailPnl {
  poste: { ref: string; libelle: string };
  mois: string | null;
  parCompte: { compte: string; intitule: string; montant: number; nb: number }[];
  lignes: LigneDetailPnl[];
  total: number;
}

export async function pnlDetail(
  c: Client, dossierId: string, ref: string,
  opts: { mois?: string; fiscalYearId?: string } = {},
): Promise<DetailPnl> {
  const poste = COMPTE_DE_RESULTAT.find((p) => p.ref === String(ref ?? '').toUpperCase());
  if (!poste) throw new Error(`Poste « ${ref} » inconnu au compte de résultat.`);
  if (poste.nature !== 'poste' || !poste.comptes?.length) {
    throw new Error(`« ${poste.ref} ${poste.libelle} » est un solde calculé : il n'a pas d'écritures propres. Ouvrez les postes qui le composent.`);
  }

  // Comptes du dossier réellement rattachés à ce poste — résolus par les mêmes
  // expressions que l'état officiel, pas par une liste recopiée.
  const { rows: all } = await c.query(
    'select account_code, label from accounts where dossier_id=$1 and class_no in (6,7,8)', [dossierId]);
  const codes = all
    .filter((a: any) => poste.comptes!.some((e) => matchExpression(a.account_code, e)))
    .map((a: any) => a.account_code);
  if (!codes.length) {
    return { poste: { ref: poste.ref, libelle: poste.libelle }, mois: opts.mois ?? null, parCompte: [], lignes: [], total: 0 };
  }

  const params: any[] = [dossierId, codes];
  let where = "l.dossier_id = $1 and a.account_code = any($2) and e.status = 'posted'";
  if (opts.fiscalYearId) { params.push(opts.fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }
  if (opts.mois) { params.push(opts.mois); where += ` and to_char(e.entry_date,'YYYY-MM') = $${params.length}`; }

  const { rows } = await c.query(
    `select e.id as entry_id, to_char(e.entry_date,'YYYY-MM-DD') as date, j.code as journal,
            e.piece_ref, a.account_code, a.label as intitule,
            coalesce(l.label, e.description) as libelle,
            l.amount_debit as debit, l.amount_credit as credit
       from entry_lines l
       join entries e on e.id = l.entry_id
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id
      where ${where}
      order by e.entry_date, e.created_at, l.line_no`,
    params);

  // Même convention que l'état : produit positif, charge négative.
  const lignes: LigneDetailPnl[] = rows.map((r: any) => {
    const debit = Number(r.debit), credit = Number(r.credit);
    return {
      entryId: r.entry_id, date: r.date, journal: r.journal, pieceRef: r.piece_ref,
      compte: r.account_code, intitule: r.intitule, libelle: r.libelle,
      debit, credit, montant: r2(credit - debit),
    };
  });

  const map = new Map<string, { compte: string; intitule: string; montant: number; nb: number }>();
  for (const l of lignes) {
    const cur = map.get(l.compte) ?? { compte: l.compte, intitule: l.intitule, montant: 0, nb: 0 };
    cur.montant = r2(cur.montant + l.montant); cur.nb += 1;
    map.set(l.compte, cur);
  }

  return {
    poste: { ref: poste.ref, libelle: poste.libelle },
    mois: opts.mois ?? null,
    parCompte: [...map.values()].sort((a, b) => a.compte.localeCompare(b.compte)),
    lignes,
    total: r2(lignes.reduce((s, l) => s + l.montant, 0)),
  };
}
