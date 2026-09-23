import { useEffect } from 'react';

// ============================================================================
// GARDE DES SAISIES NON ENREGISTRÉES (constat N09 de l'audit externe).
//
// Reproduction : remplir une nouvelle facture, ouvrir « Catalogue », revenir à
// « Facturation », rouvrir le formulaire. Aucun avertissement au changement de
// module, et le formulaire revient vide — client, désignation, prix, quantité,
// tout est perdu sans qu'on ait rien pu faire.
//
// Le mécanisme est volontairement minimal et partagé plutôt que recopié dans
// chaque écran : la perte de saisie n'a aucune raison d'être propre à la
// facturation, et un garde qu'on doit se rappeler d'ajouter finit par manquer
// là où il compte.
//
// Deux sorties à couvrir, pas une :
//   · la navigation INTERNE (changement d'onglet), qui ne déclenche aucun
//     événement navigateur — c'est celle que l'audit a prise en défaut ;
//   · la sortie de page (fermeture, rechargement, retour arrière), couverte par
//     beforeunload.
// ============================================================================

/** Écrans ayant actuellement une saisie non enregistrée. */
const enCours = new Map<string, string>();

/** Déclare (ou retire) une saisie en cours pour un écran donné. */
export function marquerSaisie(cle: string, actif: boolean, libelle: string): void {
  if (actif) enCours.set(cle, libelle);
  else enCours.delete(cle);
}

/** Libellé de la saisie en cours, s'il y en a une. */
export function saisieEnCours(): string | null {
  const [premier] = enCours.values();
  return premier ?? null;
}

/**
 * Demande confirmation si une saisie est en cours. Renvoie `true` si l'on peut
 * poursuivre — soit qu'il n'y ait rien à perdre, soit que l'utilisateur l'ait
 * accepté en connaissance de cause.
 *
 * `confirm` est volontairement utilisé : il bloque réellement la navigation, ce
 * qu'une fenêtre maison ne fait pas sans réécrire tout le routage. Le message
 * nomme ce qui va être perdu — un « Êtes-vous sûr ? » sans objet ne renseigne
 * personne.
 */
export function confirmerAbandon(): boolean {
  const libelle = saisieEnCours();
  if (!libelle) return true;
  const ok = window.confirm(
    `${libelle}\n\n`
    + 'Cette saisie n\'est pas enregistrée et sera perdue si vous quittez maintenant.\n\n'
    + 'OK pour quitter sans enregistrer — Annuler pour revenir la terminer.');
  return ok;
}

/**
 * Signale une saisie en cours tant que `actif` est vrai, et prévient aussi
 * avant une fermeture ou un rechargement de page. Le nettoyage au démontage
 * évite qu'un écran quitté laisse une garde fantôme derrière lui.
 */
export function useSaisieNonEnregistree(cle: string, actif: boolean, libelle: string): void {
  useEffect(() => {
    marquerSaisie(cle, actif, libelle);
    if (!actif) return;
    const avantSortie = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', avantSortie);
    return () => {
      window.removeEventListener('beforeunload', avantSortie);
      marquerSaisie(cle, false, libelle);
    };
  }, [cle, actif, libelle]);
}
