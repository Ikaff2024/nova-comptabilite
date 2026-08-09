import type { Client } from '../db.js';
import * as acc from './accounting.js';
import { BILAN_ACTIF, matchExpression, type PosteEtat } from './etats-postes.js';

// ============================================================================
// NOTES ANNEXES — Note 3A (immobilisations brutes) et Note 3C (amortissements).
//
// Ce sont les deux tableaux de mouvements du DSF : pour chaque poste
// d'immobilisation, ce qu'on avait à l'ouverture, ce qui est entré, ce qui est
// sorti, ce qu'il reste à la clôture.
//
// POURQUOI NOVA LES CALCULE MIEUX QU'UN MOTEUR SUR BALANCE.
//
// Un moteur qui ne reçoit que deux balances (N et N-1) doit DEVINER les
// mouvements : il fait la différence des soldes de clôture et l'attribue à une
// augmentation ou à une diminution. Cette déduction casse dès que la balance
// N-1 est partielle — le moteur conclut alors que tout le parc a été cédé.
//
// Nova n'a pas ce problème : sa balance porte séparément les à-nouveaux
// (`open_debit/credit`) et les MOUVEMENTS de l'exercice (`period_debit/credit`).
// Les quatre colonnes de la note se lisent donc directement, sans inférence :
//
//     ouverture     = à-nouveaux
//     augmentations = mouvements au débit    (acquisitions, virements entrants)
//     diminutions   = mouvements au crédit   (cessions, mises hors service)
//     clôture       = solde
//
// Et l'égalité `ouverture + augmentations − diminutions = clôture` n'est pas un
// contrôle à espérer : elle est vraie par construction. Ce qui se contrôle, en
// revanche, c'est l'ARTICULATION avec le bilan — la clôture de la note doit
// retomber exactement sur la colonne du bilan. C'est ce que vérifie `articulee`.
//
// Le regroupement réutilise la table de correspondance du bilan
// ([etats-postes.ts]), transcrite du Praticien : la note et le bilan parlent
// donc du même découpage, par construction et non par recopie.
// ============================================================================

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface LigneNoteImmo {
  ref: string;              // référence du poste au bilan (AE, AF, AJ…)
  libelle: string;
  ouverture: number;
  augmentations: number;
  diminutions: number;
  cloture: number;
  /** Comptes qui alimentent la ligne, pour justifier le chiffre. */
  comptes: { code: string; libelle: string; ouverture: number; augmentations: number; diminutions: number; cloture: number }[];
}

export interface NoteImmobilisations {
  note: '3A' | '3C';
  intitule: string;
  exercice: string | null;
  lignes: LigneNoteImmo[];
  totaux: { ouverture: number; augmentations: number; diminutions: number; cloture: number };
  /** Comptes de la classe visée qu'aucun poste du bilan ne capte — jamais silencieux. */
  comptesNonAffectes: { code: string; libelle: string; solde: number }[];
  /** Contrôle d'articulation : la clôture de la note retombe-t-elle sur le bilan ? */
  articulation: { ref: string; note: number; bilan: number; ecart: number }[];
  articulee: boolean;
}

/** Postes d'immobilisation du bilan actif : ceux qui portent une colonne « brut ». */
function postesImmobilisations(): PosteEtat[] {
  return BILAN_ACTIF.filter((p) => p.nature === 'poste' && (p.brut?.length ?? 0) > 0
    && (p.brut ?? []).some((e) => /^[2]/.test(e.trim())));
}

/**
 * Note 3A — mouvements des valeurs BRUTES, ou Note 3C — mouvements des
 * AMORTISSEMENTS et dépréciations. Même structure, deux colonnes de la table de
 * correspondance : `brut` pour l'une, `amort` pour l'autre.
 */
async function noteMouvements(
  c: Client, dossierId: string, fiscalYearId: string | undefined, quoi: 'brut' | 'amort',
): Promise<NoteImmobilisations> {
  const tb = await acc.trialBalance(c, dossierId, fiscalYearId);
  const postes = postesImmobilisations();
  const expressions = (p: PosteEtat) => (quoi === 'brut' ? p.brut : p.amort) ?? [];

  // Un compte d'amortissement est créditeur, une immobilisation est débitrice :
  // on présente les deux dans leur sens naturel, pour que la note se lise en
  // valeurs positives comme sur l'imprimé.
  const sens = quoi === 'brut' ? 1 : -1;

  const lignes: LigneNoteImmo[] = [];
  const pris = new Set<string>();

  for (const p of postes) {
    const exprs = expressions(p);
    if (!exprs.length) continue;
    const comptes: LigneNoteImmo['comptes'] = [];
    let ouv = 0, aug = 0, dim = 0, clo = 0;

    for (const r of tb) {
      if (!exprs.some((e) => matchExpression(r.account_code, e))) continue;
      pris.add(r.account_code);
      const o = sens * (r.open_debit - r.open_credit);
      // « Augmentation » et « diminution » se lisent dans le sens du compte :
      // un amortissement AUGMENTE au crédit, une immobilisation au débit.
      const a = sens > 0 ? r.period_debit : r.period_credit;
      const d = sens > 0 ? r.period_credit : r.period_debit;
      const f = sens * r.balance;
      if (o === 0 && a === 0 && d === 0 && f === 0) continue;
      comptes.push({ code: r.account_code, libelle: r.account_label, ouverture: r2(o), augmentations: r2(a), diminutions: r2(d), cloture: r2(f) });
      ouv += o; aug += a; dim += d; clo += f;
    }

    if (!comptes.length) continue;
    lignes.push({
      ref: p.ref, libelle: p.libelle,
      ouverture: r2(ouv), augmentations: r2(aug), diminutions: r2(dim), cloture: r2(clo),
      comptes,
    });
  }

  // Ce qui n'a été capté par aucun poste. La classe visée : 2x hors 28/29 pour
  // le brut, 28/29 pour les amortissements et dépréciations.
  const concerne = (code: string) => (quoi === 'brut'
    ? /^2/.test(code) && !/^(28|29)/.test(code)
    : /^(28|29)/.test(code));
  const comptesNonAffectes = tb
    .filter((r: any) => concerne(r.account_code) && !pris.has(r.account_code) && r.balance !== 0)
    .map((r: any) => ({ code: r.account_code, libelle: r.account_label, solde: r2(sens * r.balance) }));

  const totaux = lignes.reduce((t, l) => ({
    ouverture: r2(t.ouverture + l.ouverture),
    augmentations: r2(t.augmentations + l.augmentations),
    diminutions: r2(t.diminutions + l.diminutions),
    cloture: r2(t.cloture + l.cloture),
  }), { ouverture: 0, augmentations: 0, diminutions: 0, cloture: 0 });

  // Articulation avec le bilan : la clôture de chaque ligne doit être exactement
  // la colonne correspondante de l'état. C'est le seul contrôle qui vaille —
  // le bouclage interne, lui, est vrai par construction.
  const articulation = lignes.map((l) => {
    const p = postes.find((x) => x.ref === l.ref)!;
    const exprs = expressions(p);
    const bilan = r2(sens * tb
      .filter((r: any) => exprs.some((e) => matchExpression(r.account_code, e)))
      .reduce((s: number, r: any) => s + r.balance, 0));
    return { ref: l.ref, note: l.cloture, bilan, ecart: r2(l.cloture - bilan) };
  });

  const { rows: fy } = fiscalYearId
    ? await c.query('select label from fiscal_years where dossier_id=$1 and id=$2', [dossierId, fiscalYearId])
    : { rows: [] as any[] };

  return {
    note: quoi === 'brut' ? '3A' : '3C',
    intitule: quoi === 'brut'
      ? 'Note 3A — Immobilisations brutes (mouvements de l\'exercice)'
      : 'Note 3C — Amortissements et dépréciations des immobilisations',
    exercice: fy[0]?.label ?? null,
    lignes, totaux, comptesNonAffectes, articulation,
    articulee: articulation.every((a) => Math.abs(a.ecart) < 0.01),
  };
}

export function note3A(c: Client, dossierId: string, fiscalYearId?: string) {
  return noteMouvements(c, dossierId, fiscalYearId, 'brut');
}
export function note3C(c: Client, dossierId: string, fiscalYearId?: string) {
  return noteMouvements(c, dossierId, fiscalYearId, 'amort');
}

/**
 * Rapprochement avec le REGISTRE des immobilisations.
 *
 * La note se calcule sur le grand livre, qui fait foi. Le registre, lui, connaît
 * le détail bien par bien. Les deux doivent dire la même chose : un écart
 * signale soit une immobilisation achetée sans être inscrite au registre (donc
 * jamais amortie), soit une écriture passée à la main à côté du registre.
 * C'est un contrôle que le seul grand livre ne peut pas faire.
 */
export async function rapprochementRegistre(
  c: Client, dossierId: string, fiscalYearId?: string,
): Promise<{ registreBrut: number; comptaBrut: number; ecartBrut: number;
             registreAmort: number; comptaAmort: number; ecartAmort: number; concordant: boolean }> {
  const [a, d] = await Promise.all([note3A(c, dossierId, fiscalYearId), note3C(c, dossierId, fiscalYearId)]);
  const { rows } = await c.query(
    `select coalesce(sum(fa.amount), 0) as brut,
            coalesce((select sum(dp.amount) from fixed_asset_depreciations dp
                       join fixed_assets f2 on f2.id = dp.fixed_asset_id
                      where dp.dossier_id = $1 and f2.status <> 'disposed'), 0) as amort
       from fixed_assets fa where fa.dossier_id=$1 and fa.status <> 'disposed'`, [dossierId]);
  const registreBrut = r2(Number(rows[0]?.brut ?? 0));
  const registreAmort = r2(Number(rows[0]?.amort ?? 0));
  const ecartBrut = r2(registreBrut - a.totaux.cloture);
  const ecartAmort = r2(registreAmort - d.totaux.cloture);
  return {
    registreBrut, comptaBrut: a.totaux.cloture, ecartBrut,
    registreAmort, comptaAmort: d.totaux.cloture, ecartAmort,
    concordant: Math.abs(ecartBrut) < 1 && Math.abs(ecartAmort) < 1,
  };
}
