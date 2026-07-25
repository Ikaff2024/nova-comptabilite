import type { Client } from '../db.js';
import { trialBalance } from './accounting.js';
import {
  BILAN_ACTIF, BILAN_PASSIF, COMPTE_DE_RESULTAT,
  matchExpression, type PosteEtat,
} from './etats-postes.js';

// ============================================================================
// Bilan et Compte de résultat au format OFFICIEL SYSCOHADA (Système Normal) :
// les 99 postes référencés (AD…BZ, CA…DZ, TA…XI), calculés depuis la balance de
// l'exercice via la table de correspondance de l'ouvrage (cf. etats-postes.ts).
//
// Ce que ça apporte sur financialStatements(), qui regroupe les classes 6 et 7
// par préfixe à deux chiffres : les références de postes, la ventilation
// brut / amortissements de l'actif, et surtout les SOLDES INTERMÉDIAIRES de
// gestion — marge commerciale, valeur ajoutée, EBE — que la présentation par
// préfixe ne peut pas produire.
//
// Deux égalités rendent le calcul AUTO-VÉRIFIANT, et sont renvoyées avec l'état :
//   BZ (total actif) = DZ (total passif)
//   XI (résultat net) = produits − charges de la balance
// Un écart signale une erreur de correspondance ou un compte non affecté ; il
// est renvoyé, jamais masqué.
//
// Convention de signe : un poste vaut CRÉDIT − DÉBIT. Les produits ressortent
// donc positifs, les charges négatives, et les soldes intermédiaires s'obtiennent
// par simple somme — exactement la lecture de l'ouvrage, qui porte le sens sur
// chaque ligne (+ produit, − charge, −/+ variation de stock).
// ============================================================================

export interface LigneEtat {
  ref: string;
  libelle: string;
  nature: PosteEtat['nature'];
  brut?: number;      // bilan actif
  amort?: number;     // bilan actif (positif = à déduire)
  net?: number;       // bilan actif
  montant?: number;   // bilan passif et compte de résultat
  note?: string;
}

export interface CompteNonAffecte { compte: string; intitule: string; solde: number; etat: 'bilan' | 'resultat' }

export interface EtatsOfficiels {
  exercice: { id: string; label: string } | null;
  bilanActif: LigneEtat[];
  bilanPassif: LigneEtat[];
  compteResultat: LigneEtat[];
  controles: {
    equilibreBilan: { actif: number; passif: number; ecart: number; ok: boolean };
    resultat: { parLesPostes: number; parLaBalance: number; ecart: number; ok: boolean };
  };
  comptesNonAffectes: CompteNonAffecte[];
}

interface SoldeCompte { code: string; label: string; solde: number } // solde = débit − crédit

const r2 = (n: number) => Math.round(n * 100) / 100;
const proche = (a: number, b: number) => Math.abs(a - b) < 0.5; // tolérance d'arrondi au franc

// Somme des soldes des comptes rattachés à l'une des expressions.
// `sens` filtre les comptes selon leur position : certains postes ne retiennent
// que les soldes créditeurs (un 44 débiteur est une créance, il va à l'actif).
function sommeSoldes(
  comptes: SoldeCompte[], expressions: string[] | undefined, sens?: 'debiteur' | 'crediteur',
): number {
  if (!expressions?.length) return 0;
  let t = 0;
  for (const c of comptes) {
    if (sens === 'crediteur' && c.solde > 0) continue;
    if (sens === 'debiteur' && c.solde < 0) continue;
    if (expressions.some((e) => matchExpression(c.code, e))) t += c.solde;
  }
  return t;
}

// Évalue une formule de l'ouvrage : « somme TA à RB », « XG + XH + RQ + RS »,
// « (XB + RA + RB) + (somme TE à RJ) ». Ce sont toutes des additions — le sens
// est déjà porté par la valeur de chaque poste.
function evaluerFormule(formule: string, table: PosteEtat[], valeurs: Map<string, number>): number {
  let t = 0;
  for (const terme of formule.replace(/[()]/g, ' ').split('+')) {
    const s = terme.trim();
    if (!s) continue;
    const plage = s.match(/^somme\s+([A-Z]{2})\s+à\s+([A-Z]{2})$/i);
    if (plage) {
      const i = table.findIndex((p) => p.ref === plage[1]);
      const j = table.findIndex((p) => p.ref === plage[2]);
      if (i < 0 || j < 0) continue;
      for (let k = i; k <= j; k++) if (table[k].nature === 'poste') t += valeurs.get(table[k].ref) ?? 0;
    } else {
      t += valeurs.get(s) ?? 0;
    }
  }
  return t;
}

export async function etatsOfficiels(
  c: Client, dossierId: string, fiscalYearId?: string,
): Promise<EtatsOfficiels> {
  const rows = await trialBalance(c, dossierId, fiscalYearId);
  const comptes: SoldeCompte[] = rows.map((r: any) => ({
    code: r.account_code, label: r.account_label ?? '', solde: Number(r.balance),
  }));

  const { rows: fy } = await c.query(
    'select id, label from fiscal_years where dossier_id=$1 and ($2::uuid is null or id=$2::uuid) order by start_date desc limit 1',
    [dossierId, fiscalYearId ?? null],
  );

  // Résultat de l'exercice tel que la balance le donne : produits − charges,
  // classe 8 (H.A.O.) comprise. Sert de contrôle, et de repli pour le poste CJ
  // tant que l'exercice n'est pas clôturé (la classe 13 est alors vide).
  const resultatBalance = r2(-comptes.filter((x) => '678'.includes(x.code[0])).reduce((s, x) => s + x.solde, 0));

  // --- Bilan actif : brut − amortissements = net ---
  const valActif = new Map<string, number>();
  const bilanActif: LigneEtat[] = BILAN_ACTIF.map((p) => {
    if (p.nature !== 'poste') return { ref: p.ref, libelle: p.libelle, nature: p.nature, note: p.note };
    const sens = p.note?.startsWith('Soldes débiteurs') ? 'debiteur' : undefined;
    const brut = r2(sommeSoldes(comptes, p.brut, sens));
    const amort = r2(-sommeSoldes(comptes, p.amort));
    const net = r2(brut - amort);
    valActif.set(p.ref, net);
    return { ref: p.ref, libelle: p.libelle, nature: p.nature, brut, amort, net, note: p.note };
  });
  for (const l of bilanActif) {
    if (l.nature !== 'total') continue;
    const p = BILAN_ACTIF.find((x) => x.ref === l.ref)!;
    l.net = r2(evaluerFormule(p.formule ?? '', BILAN_ACTIF, valActif));
    valActif.set(l.ref, l.net);
  }

  // --- Bilan passif : montants créditeurs positifs ---
  const valPassif = new Map<string, number>();
  const bilanPassif: LigneEtat[] = BILAN_PASSIF.map((p) => {
    if (p.nature !== 'poste') return { ref: p.ref, libelle: p.libelle, nature: p.nature, note: p.note };
    let montant = r2(-sommeSoldes(comptes, p.comptes, p.crediteur ? 'crediteur' : undefined));
    // Exercice non clôturé : la classe 13 est vide, le résultat vient des
    // classes 6/7/8 — sans quoi le bilan ne pourrait pas s'équilibrer.
    if (p.ref === 'CJ' && montant === 0) montant = resultatBalance;
    valPassif.set(p.ref, montant);
    return { ref: p.ref, libelle: p.libelle, nature: p.nature, montant, note: p.note };
  });
  for (const l of bilanPassif) {
    if (l.nature !== 'total') continue;
    const p = BILAN_PASSIF.find((x) => x.ref === l.ref)!;
    l.montant = r2(evaluerFormule(p.formule ?? '', BILAN_PASSIF, valPassif));
    valPassif.set(l.ref, l.montant);
  }

  // --- Compte de résultat : crédit − débit, soldes par sommation ---
  const valCR = new Map<string, number>();
  const compteResultat: LigneEtat[] = COMPTE_DE_RESULTAT.map((p) => {
    if (p.nature !== 'poste') return { ref: p.ref, libelle: p.libelle, nature: p.nature, note: p.note };
    const montant = r2(-sommeSoldes(comptes, p.comptes));
    valCR.set(p.ref, montant);
    return { ref: p.ref, libelle: p.libelle, nature: p.nature, montant, note: p.note };
  });
  for (const l of compteResultat) {
    if (l.nature !== 'solde') continue;
    const p = COMPTE_DE_RESULTAT.find((x) => x.ref === l.ref)!;
    l.montant = r2(evaluerFormule(p.formule ?? '', COMPTE_DE_RESULTAT, valCR));
    valCR.set(l.ref, l.montant);
  }

  // --- Comptes qui ne tombent dans aucun poste : leur solde s'évaporerait ---
  const affecte = (code: string, table: PosteEtat[]) => table.some((p) =>
    [...(p.brut ?? []), ...(p.amort ?? []), ...(p.comptes ?? [])].some((e) => matchExpression(code, e)));
  const comptesNonAffectes: CompteNonAffecte[] = [];
  for (const x of comptes) {
    if (x.solde === 0) continue;
    const bilan = '12345'.includes(x.code[0]);
    const ok = bilan ? (affecte(x.code, BILAN_ACTIF) || affecte(x.code, BILAN_PASSIF)) : affecte(x.code, COMPTE_DE_RESULTAT);
    if (!ok) comptesNonAffectes.push({ compte: x.code, intitule: x.label, solde: r2(x.solde), etat: bilan ? 'bilan' : 'resultat' });
  }

  const totalActif = valActif.get('BZ') ?? 0;
  const totalPassif = valPassif.get('DZ') ?? 0;
  const resultatPostes = valCR.get('XI') ?? 0;

  return {
    exercice: fy[0] ? { id: fy[0].id, label: fy[0].label } : null,
    bilanActif, bilanPassif, compteResultat,
    controles: {
      equilibreBilan: { actif: totalActif, passif: totalPassif, ecart: r2(totalActif - totalPassif), ok: proche(totalActif, totalPassif) },
      resultat: { parLesPostes: resultatPostes, parLaBalance: resultatBalance, ecart: r2(resultatPostes - resultatBalance), ok: proche(resultatPostes, resultatBalance) },
    },
    comptesNonAffectes,
  };
}
