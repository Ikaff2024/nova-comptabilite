import type { Client } from '../db.js';
import { financialStatements } from './accounting.js';

// ============================================================================
// Analyse financière : ratios de structure, liquidité, rentabilité et grandes
// masses (BFR, FR, trésorerie nette), calculés à partir des états financiers
// SYSCOHADA. Lecture seule. Alimente le conseil de Lexa.
// ============================================================================

export type Niveau = 'bon' | 'moyen' | 'faible';
export interface Ratio {
  cle: string; libelle: string; valeur: number | null; unite: 'ratio' | 'pourcent' | 'jours' | 'montant';
  formule: string; niveau?: Niveau; commentaire?: string;
}

const div = (a: number, b: number): number | null => (b === 0 || !isFinite(a / b) ? null : a / b);
const pick = (arr: any[], label: string): number => arr.find((r) => r.label === label)?.amount ?? 0;
const level = (v: number | null, bon: number, moyen: number): Niveau | undefined =>
  v == null ? undefined : v >= bon ? 'bon' : v >= moyen ? 'moyen' : 'faible';

export async function financialRatios(c: Client, dossierId: string, fiscalYearId?: string): Promise<{
  devise: string; chiffreAffaires: number;
  soldes: Record<string, number>;
  ratios: Ratio[];
}> {
  const { rows: dr } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
  const devise = dr[0]?.base_currency ?? 'XOF';

  const fs: any = await financialStatements(c, dossierId, fiscalYearId);
  const bs = fs.balanceSheet, is = fs.incomeStatement;
  const sig = (label: string): number => is.sig?.find((s: any) => s.label === label)?.amount ?? 0;

  // Grandes masses (bilan fonctionnel simplifié).
  const actifImmobilise = pick(bs.actif, 'Actif immobilisé (net)');
  const stocks = pick(bs.actif, 'Stocks');
  const creances = pick(bs.actif, 'Créances et emplois assimilés');
  const tresoActif = pick(bs.actif, 'Trésorerie-Actif');
  const capitauxHorsResultat = pick(bs.passif, 'Capitaux propres');
  const resultatNet = is.resultatNet;
  const dettesFin = pick(bs.passif, 'Dettes financières et ressources assimilées');
  const passifCirc = pick(bs.passif, 'Passif circulant');
  const tresoPassif = pick(bs.passif, 'Trésorerie-Passif');

  const capitauxPropres = capitauxHorsResultat + resultatNet;
  const actifCirculant = stocks + creances + tresoActif;
  const dettesCourtTerme = passifCirc + tresoPassif;
  const ressourcesStables = capitauxPropres + dettesFin;
  const bfr = stocks + creances - passifCirc;
  const tresorerieNette = tresoActif - tresoPassif;
  const fondsRoulement = ressourcesStables - actifImmobilise;
  const ca = sig("Chiffre d'affaires");
  const resultatExploitation = sig("Résultat d'exploitation");
  const valeurAjoutee = sig('Valeur ajoutée (V.A.)');

  const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  const pct = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 10);

  const ratios: Ratio[] = [
    { cle: 'liquidite_generale', libelle: 'Liquidité générale', valeur: r2(div(actifCirculant, dettesCourtTerme)), unite: 'ratio',
      formule: 'Actif circulant / Dettes à court terme', niveau: level(div(actifCirculant, dettesCourtTerme), 1.5, 1),
      commentaire: 'Capacité à honorer les dettes court terme avec l\'actif circulant (> 1 souhaitable).' },
    { cle: 'liquidite_reduite', libelle: 'Liquidité réduite', valeur: r2(div(creances + tresoActif, dettesCourtTerme)), unite: 'ratio',
      formule: '(Créances + Trésorerie) / Dettes à court terme', niveau: level(div(creances + tresoActif, dettesCourtTerme), 1, 0.7) },
    { cle: 'autonomie_financiere', libelle: 'Autonomie financière', valeur: pct(div(capitauxPropres, bs.totalPassif)), unite: 'pourcent',
      formule: 'Capitaux propres / Total passif', niveau: level(div(capitauxPropres, bs.totalPassif), 0.4, 0.2),
      commentaire: 'Part des ressources apportées en propre (> 20-30 % recherché).' },
    { cle: 'endettement', libelle: 'Levier d\'endettement financier', valeur: r2(div(dettesFin, capitauxPropres)), unite: 'ratio',
      formule: 'Dettes financières / Capitaux propres', commentaire: 'Plus il est bas, plus la structure est solide (souvent < 1).' },
    { cle: 'rentabilite_nette', libelle: 'Rentabilité nette', valeur: pct(div(resultatNet, ca)), unite: 'pourcent',
      formule: 'Résultat net / Chiffre d\'affaires', niveau: level(div(resultatNet, ca), 0.05, 0) },
    { cle: 'marge_exploitation', libelle: 'Marge d\'exploitation', valeur: pct(div(resultatExploitation, ca)), unite: 'pourcent',
      formule: 'Résultat d\'exploitation / Chiffre d\'affaires', niveau: level(div(resultatExploitation, ca), 0.05, 0) },
    { cle: 'taux_valeur_ajoutee', libelle: 'Taux de valeur ajoutée', valeur: pct(div(valeurAjoutee, ca)), unite: 'pourcent',
      formule: 'Valeur ajoutée / Chiffre d\'affaires' },
    { cle: 'delai_clients', libelle: 'Délai de recouvrement clients (indicatif)', valeur: r2(div(creances * 360, ca)), unite: 'jours',
      formule: 'Créances / CA × 360', commentaire: 'Indicatif : créances TTC rapportées à un CA HT ; à interpréter comme un ordre de grandeur.' },
  ];

  return {
    devise, chiffreAffaires: Math.round(ca),
    soldes: {
      actifCirculant: Math.round(actifCirculant), dettesCourtTerme: Math.round(dettesCourtTerme),
      bfr: Math.round(bfr), fondsRoulement: Math.round(fondsRoulement), tresorerieNette: Math.round(tresorerieNette),
      capitauxPropres: Math.round(capitauxPropres), dettesFinancieres: Math.round(dettesFin), totalActif: Math.round(bs.totalActif),
    },
    ratios,
  };
}
