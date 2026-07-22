// =============================================================================
// Jeux de règles de paie — datés et versionnés (socle « veille légale »)
// =============================================================================
// Les barèmes ne sont plus codés en dur dans le moteur : ils vivent ici, sous
// forme de données à EFFET DATÉ (effectiveFrom/effectiveTo) et VERSIONNÉES.
// Bénéfices :
//   • recalcul historique correct (un bulletin applique les règles de sa date) ;
//   • traçabilité : chaque calcul est estampillé de la version appliquée ;
//   • mise à jour d'un taux sans toucher au moteur ;
//   • extension multi-pays OHADA (un jeu de règles par pays).
// ⚠️ Les valeurs de CI-2024 reproduisent EXACTEMENT le moteur d'origine
//    (réforme IUS/CUE, loi de finances 2024) — garanties par les golden tests.
// =============================================================================

// Tranche d'un barème progressif : impôt = base + (x - lower) * rate, pour la
// tranche dont `lower` est le plus grand seuil ≤ x.
export interface TaxBracket {
  lower: number;
  rate: number;
  base: number; // impôt cumulé au seuil bas de la tranche
}

export interface PayrollRuleSet {
  version: string; // ex. 'CI-2024.1'
  country: string; // code pays ISO — 'CI'
  label: string;
  effectiveFrom: string; // 'YYYY-MM-DD' inclus
  effectiveTo?: string; // 'YYYY-MM-DD' exclu ; absent = en vigueur
  source?: string; // référence légale

  absenceDivisor: number; // jours pour le prorata d'absence (30)
  hourlyDivisor: number; // heures mensuelles pour le taux horaire (173.33)
  overtime: { hs15: number; hs50: number; hs75: number; hs100: number };
  // Seuils de ventilation des heures sup depuis le pointage (attestés).
  overtimeThresholds: { weeklyNormalHours: number; firstTierHours: number };
  seniority: { thresholdYears: number; startPct: number; incrementPct: number; capPct: number };
  transportExemptCap: number; // exonération transport (30 000)
  // Allocations spéciales couvrant les frais inhérents à la fonction ou à l'emploi
  // (art. 116-1° CGI ; note de service DGI n° 054/MFB/DGI-DLCD du 08/07/2024) :
  // exonérées « dans la limite du dixième de la rémunération totale, indemnités
  // comprises, hors avantages en nature ». Sont EXCLUS de cette assiette : la
  // prime légale de transport exonérée, les indemnités à caractère familial et
  // les avantages en nature.
  specialAllowanceExemptRate: number; // 0,10

  // Assiettes CNPS — communiqué officiel CNPS (décret n° 2022-986 du 21/12/2022,
  // SMIG porté à 75 000), en vigueur au 01/01/2023.
  cnps: {
    floor: number; // plancher TOUTES BRANCHES confondues (75 000)
    ceiling: number; // plafond branche retraite (3 375 000 = 45 × SMIG)
    employeeRate: number; // 6,3 %
    // Plafond des AUTRES branches (maternité, prestations familiales, AT/MP).
    // Égal au plancher depuis 2023 → l'assiette de ces branches vaut toujours
    // exactement 75 000.
    familyCeiling: number;
    familyRate: number; // 5,75 % = prestations familiales 5 % + maternité 0,75 %
    accidentRate: number; // AT/MP : 2 % à 5 % selon le secteur (notifié par la CNPS)
    retirementEmployerRate: number; // 7,7 %
  };

  ius: {
    // Abattement forfaitaire sur l'assiette. SUPPRIMÉ par la réforme 2024 (0) :
    // le barème s'applique directement au revenu brut imposable (art. 118 CGI).
    abatementRate: number;
    brackets: TaxBracket[];
    // Réduction d'Impôt pour Charges de Famille (RICF) : montant FIXE mensuel
    // selon le nombre de parts — elle a remplacé le quotient familial. Ce n'est
    // PAS un pourcentage de l'impôt.
    ricfByParts: { parts: number; monthly: number }[];
    maxParts: number; // plafond légal (5 parts)
  };

  cmuFlat: number; // CMU forfaitaire (1 000)

  // Impôts et taxes sur salaires À LA CHARGE DE L'EMPLOYEUR (DGI), en TAUX
  // EFFECTIFS sur le revenu brut imposable. Source : formulaire officiel de
  // déclaration DGI (FUDP), section 03.2 + 03.4 — les taux « d'usage » y
  // intègrent déjà l'abattement de 20 % (ex. CN = 1,5 % × 0,8 = 1,2 %).
  //   Total personnel LOCAL     = 2,8 % (CE 0 + CN 1,2 + TA 0,4 + TFPC 1,2)
  //   Total personnel EXPATRIÉ  = 12 %  (CE 9,2 + CN 1,2 + TA 0,4 + TFPC 1,2)
  employerTaxes: {
    ceRateLocal: number;      // Contribution Employeur — personnel local (0)
    ceRateExpat: number;      // Contribution Employeur — personnel expatrié (9,2 %)
    cnRate: number;           // Contribution Nationale (1,2 %)
    apprenticeshipRate: number; // Taxe d'apprentissage — TA (0,4 %)
    trainingRate: number;     // Taxe additionnelle formation continue — TFPC (1,2 %)
  };

  // Solde de tout compte (rupture de contrat). Barèmes ATTESTÉS par le porteur
  // du produit (Code du travail 2015-532, décret 96-201). Les conventions
  // collectives sectorielles peuvent être plus favorables.
  stc: {
    referenceMonths: number; // moyenne des N derniers mois pour le salaire de réf. (12)
    congesDivisor: number; // valorisation d'un jour de congé (salaire / 26)
    licenciementMinTenureYears: number; // ancienneté minimale ouvrant droit (1 an)
    // Indemnité de licenciement : % du salaire moyen mensuel par année, par tranche.
    licenciementBands: { uptoYear: number; rate: number }[];
    cddEndRate: number; // indemnité de fin de CDD (6 % du brut total perçu)
    // Durée du préavis (en mois) par catégorie socio-pro (indicatif, conventionnel).
    preavisMonthsByCategory: Record<string, number>;
  };
}

// --- Côte d'Ivoire — réforme IUS/CUE (loi de finances 2024) ------------------
const CI_2024: PayrollRuleSet = {
  version: 'CI-2024.2',
  country: 'CI',
  label: 'Côte d’Ivoire — ITS unifié (réforme 2024), barème officiel DGI',
  effectiveFrom: '2024-01-01',
  source:
    "Ordonnance du 13/09/2023 ; note DGI du 03/01/2024 (fusion IS+CN+IGR, "
    + "suppression de l'abattement, RICF par parts) ; barème repris de l'onglet "
    + 'PARAMETRES du modèle officiel État 301 (edi-annexe-ETAT301.xlsm) ; CNPS ; CMU',

  absenceDivisor: 30,
  hourlyDivisor: 173.33,
  overtime: { hs15: 1.15, hs50: 1.5, hs75: 1.75, hs100: 2.0 },
  overtimeThresholds: { weeklyNormalHours: 40, firstTierHours: 8 },
  seniority: { thresholdYears: 2, startPct: 2, incrementPct: 1, capPct: 25 },
  transportExemptCap: 30000,
  specialAllowanceExemptRate: 0.1,

  cnps: {
    floor: 75000,
    ceiling: 3375000,
    employeeRate: 0.063,
    familyCeiling: 75000,
    familyRate: 0.0575,
    accidentRate: 0.02,
    retirementEmployerRate: 0.077,
  },

  ius: {
    // Réforme 2024 : plus d'abattement, le barème porte sur le brut imposable.
    abatementRate: 0,
    // Barème progressif MENSUEL officiel. `base` = impôt cumulé au seuil bas,
    // recalculé par tranche : 0 ; 165 000×16 % ; +560 000×21 % ; +1 600 000×24 % ;
    // +5 600 000×28 %.
    brackets: [
      { lower: 0, rate: 0, base: 0 },
      { lower: 75000, rate: 0.16, base: 0 },
      { lower: 240000, rate: 0.21, base: 26400 },
      { lower: 800000, rate: 0.24, base: 144000 },
      { lower: 2400000, rate: 0.28, base: 528000 },
      { lower: 8000000, rate: 0.32, base: 2096000 },
    ],
    // RICF mensuelle par nombre de parts (barème DGI). Progression linéaire de
    // 11 000 F par part entière, mais on encode le tableau officiel tel quel.
    ricfByParts: [
      { parts: 1, monthly: 0 },
      { parts: 1.5, monthly: 5500 },
      { parts: 2, monthly: 11000 },
      { parts: 2.5, monthly: 16500 },
      { parts: 3, monthly: 22000 },
      { parts: 3.5, monthly: 27500 },
      { parts: 4, monthly: 33000 },
      { parts: 4.5, monthly: 38500 },
      { parts: 5, monthly: 44000 },
    ],
    maxParts: 5,
  },

  cmuFlat: 1000,
  employerTaxes: {
    ceRateLocal: 0,       // personnel local : CE exonérée
    ceRateExpat: 0.092,   // personnel expatrié : 11,5 % × 0,8
    cnRate: 0.012,        // 1,5 % × 0,8
    apprenticeshipRate: 0.004, // TA 0,4 %
    trainingRate: 0.012,  // TFPC 1,2 %
  },

  stc: {
    referenceMonths: 12,
    congesDivisor: 26,
    licenciementMinTenureYears: 1,
    licenciementBands: [
      { uptoYear: 5, rate: 0.3 }, // 1re à 5e année : 30 %
      { uptoYear: 10, rate: 0.35 }, // 6e à 10e année : 35 %
      { uptoYear: Infinity, rate: 0.4 }, // au-delà : 40 %
    ],
    cddEndRate: 0.06,
    preavisMonthsByCategory: { Ouvrier: 1, Employe: 1, 'Agent de Maitrise': 3, Cadre: 3 },
  },
};

// --- Sénégal — SCAFFOLD (valeurs PLACEHOLDER, NON certifiées) ---------------
// ⚠️ Ces montants NE SONT PAS les barèmes réels du Sénégal : ils démontrent
// l'architecture multi-pays et DOIVENT être remplacés par les vrais taux
// (IPRES, CSS, IR/TRIMF) avant tout usage. Le libellé et la version le signalent
// (le bulletin affiche « À ATTESTER »).
const SN_2024_PLACEHOLDER: PayrollRuleSet = {
  version: 'SN-2024.PLACEHOLDER',
  country: 'SN',
  label: 'Sénégal — Barème PLACEHOLDER (À ATTESTER, non certifié)',
  effectiveFrom: '2024-01-01',
  source: 'À renseigner : IPRES, CSS, IR/TRIMF',

  absenceDivisor: 30,
  hourlyDivisor: 173.33,
  overtime: { hs15: 1.15, hs50: 1.4, hs75: 1.6, hs100: 2.0 },
  overtimeThresholds: { weeklyNormalHours: 40, firstTierHours: 8 },
  seniority: { thresholdYears: 2, startPct: 2, incrementPct: 1, capPct: 25 },
  transportExemptCap: 30000,
  specialAllowanceExemptRate: 0.1,

  cnps: {
    floor: 0, // à attester
    ceiling: 3600000,
    employeeRate: 0.056, // IPRES RG (placeholder)
    familyCeiling: 63000,
    familyRate: 0.07,
    accidentRate: 0.01,
    retirementEmployerRate: 0.084,
  },

  ius: {
    abatementRate: 0,
    brackets: [
      { lower: 0, rate: 0, base: 0 },
      { lower: 50000, rate: 0.2, base: 0 },
      { lower: 250000, rate: 0.3, base: 40000 },
      { lower: 750000, rate: 0.4, base: 190000 },
    ],
    ricfByParts: [{ parts: 1, monthly: 0 }], // placeholder : RICF à attester
    maxParts: 5,
  },

  cmuFlat: 0,
  employerTaxes: { ceRateLocal: 0, ceRateExpat: 0, cnRate: 0, apprenticeshipRate: 0, trainingRate: 0.03 }, // placeholder CFCE, à attester

  stc: CI_2024.stc, // placeholder : réutilise la structure CI en attendant l'attestation
};

// Registre des jeux de règles (ajouter ici les futures versions / pays).
export const RULE_SETS: PayrollRuleSet[] = [CI_2024, SN_2024_PLACEHOLDER];

// Impôt progressif : tranche dont le seuil bas est le plus grand ≤ x.
export function applyProgressive(x: number, brackets: TaxBracket[]): number {
  let chosen = brackets[0];
  for (const b of brackets) {
    if (x >= b.lower) chosen = b;
    else break;
  }
  return chosen.base + (x - chosen.lower) * chosen.rate;
}

/**
 * Résout le jeu de règles applicable à une période (year, month 0-11) pour un
 * pays : le plus récent dont [effectiveFrom, effectiveTo) contient la période.
 * À défaut (période antérieure au plus ancien barème), retombe sur le plus
 * ancien connu du pays — le moteur ne reste jamais sans règles.
 */
export function resolveRuleSet(year: number, month: number, country = 'CI'): PayrollRuleSet {
  const target = new Date(year, month, 1).getTime();
  const forCountry = RULE_SETS.filter((r) => r.country === country).sort(
    (a, b) => new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime(),
  );
  if (forCountry.length === 0) {
    throw new Error(`Aucun jeu de règles de paie pour le pays ${country}.`);
  }
  let chosen = forCountry[0];
  for (const r of forCountry) {
    const from = new Date(r.effectiveFrom).getTime();
    const to = r.effectiveTo ? new Date(r.effectiveTo).getTime() : Infinity;
    if (target >= from && target < to) chosen = r;
  }
  return chosen;
}
