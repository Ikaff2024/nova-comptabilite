// ============================================================================
// POLITIQUE MONÉTAIRE — constat NOVA-P2-01
// ============================================================================
// Les montants vivent en base en `numeric(20,4)` : un type EXACT, sans arrondi.
// Côté serveur, le pilote de base les convertit en nombre JavaScript, c'est-à-
// dire en flottant IEEE 754. Cette conversion est le seul endroit du produit où
// un montant peut changer de valeur sans que personne ne le demande.
//
// ── Ce qui a été mesuré, plutôt que supposé ────────────────────────────────
//
// Un flottant représente exactement les entiers jusqu'à 2^53. Avec quatre
// décimales, cela borne les montants exactement relisibles à :
//
//     2^53 / 10^4  ≈  900 719 925 474,0991
//
// Vérifié en base : 123 456 789 012,3456 revient intact ; 1 234 567 890 123,4567
// revient en ...456**8**. Le centime a disparu sans le dire.
//
// Ont en revanche été mesurés SANS écart :
//   · le calcul d'une TVA à 18 % en JavaScript, puis stockage ;
//   · la somme de 100 000 montants en JavaScript (dérive 3·10⁻⁵, donc très
//     en-dessous de la quatrième décimale : absorbée au stockage).
//
// ── Ce qu'on en fait ───────────────────────────────────────────────────────
//
// Réécrire les 634 conversions du produit en arithmétique entière serait un
// chantier de plusieurs semaines pour un risque qui ne se matérialise qu'au-delà
// de 900 milliards. La réponse retenue tient en deux gestes :
//
//   1. RENDRE LE DANGER IMPOSSIBLE : la base refuse d'enregistrer un montant
//      qu'elle ne pourrait pas rendre intact (contrainte, migration 0085).
//   2. RENDRE LE DANGER BRUYANT : si un tel montant existe malgré tout — donnée
//      héritée, import, calcul intermédiaire — sa lecture lève une erreur au
//      lieu de rendre un chiffre faux (server/db.ts).
//
// Le principe est celui du reste du produit : mieux vaut un refus franc qu'un
// chiffre approximatif dans une comptabilité.
// ============================================================================

/** Nombre de décimales stockées pour un montant (`numeric(20,4)`). */
export const DECIMALES_MONTANT = 4;

/**
 * Plus grand montant qu'un nombre JavaScript peut porter sans perdre une
 * décimale : 2^53 / 10^4, arrondi à l'unité par prudence.
 *
 * Soit environ 900 milliards. À titre de repère, le budget annuel de l'État de
 * Côte d'Ivoire est de l'ordre de 13 000 milliards FCFA : la borne est donc très
 * au-delà de tout montant qu'une PME ou un cabinet inscrira dans une écriture,
 * mais très en-deçà du maximum que `numeric(20,4)` autoriserait (10^16).
 */
export const MONTANT_MAX_SUR = Math.floor(Number.MAX_SAFE_INTEGER / 10 ** DECIMALES_MONTANT);

/** Vrai si le montant se relit à l'identique après un aller-retour en base. */
export function estMontantSur(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v) <= MONTANT_MAX_SUR;
}

/**
 * Arrondit un montant à la précision réellement stockée.
 *
 * À utiliser dès qu'un montant est CALCULÉ en JavaScript avant d'être
 * enregistré (ventilation, prorata, amortissement). Sans cela, on confie à la
 * base le soin d'arrondir : elle le fait bien, mais le total recalculé côté
 * serveur et le total relu depuis la base peuvent alors différer d'un dix-
 * millième, et c'est ce genre d'écart qui fait douter d'une balance.
 */
export function arrondirMontant(v: number): number {
  const f = 10 ** DECIMALES_MONTANT;
  return Math.round((v + Number.EPSILON * Math.abs(v)) * f) / f;
}

/**
 * Message unique, en français comptable, pour un montant hors bornes. Centralisé
 * pour que la base et le serveur disent exactement la même chose.
 */
export function messageMontantHorsBornes(v: string | number): string {
  return `Montant hors des limites admises (${v}). Nova n'enregistre pas un montant `
    + `supérieur à ${MONTANT_MAX_SUR.toLocaleString('fr-FR')} : au-delà, il ne pourrait `
    + `plus être restitué au centime près. Vérifiez la saisie — il s'agit presque `
    + `toujours d'une erreur de virgule ou d'unité.`;
}
