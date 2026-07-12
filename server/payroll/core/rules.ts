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

  cnps: {
    ceiling: number; // plafond retraite (3 375 000)
    employeeRate: number; // 6,3 %
    familyCeiling: number; // plafond prestations familiales / accident (70 000)
    familyRate: number; // 5,75 %
    accidentRate: number; // 2 %
    retirementEmployerRate: number; // 7,7 %
  };

  ius: {
    abatementRate: number; // abattement pro (0,30 → base = 70 %)
    brackets: TaxBracket[];
    familySpouseReduction: number; // 10 % conjoint
    familyChildReduction: number; // 10 % / enfant
    familyChildCap: number; // nb d'enfants pris en compte (4)
    reductionCap: number; // plafond de réduction (0,50)
  };

  cmuFlat: number; // CMU forfaitaire (1 000)
  cueRate: number; // Contribution Unique des Employeurs (1,2 %)

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
  version: 'CI-2024.1',
  country: 'CI',
  label: 'Côte d’Ivoire — Réforme IUS/CUE (Loi de finances 2024)',
  effectiveFrom: '2024-01-01',
  source: 'Loi de finances 2024 ; CNPS ; CMU',

  absenceDivisor: 30,
  hourlyDivisor: 173.33,
  overtime: { hs15: 1.15, hs50: 1.5, hs75: 1.75, hs100: 2.0 },
  overtimeThresholds: { weeklyNormalHours: 40, firstTierHours: 8 },
  seniority: { thresholdYears: 2, startPct: 2, incrementPct: 1, capPct: 25 },
  transportExemptCap: 30000,

  cnps: {
    ceiling: 3375000,
    employeeRate: 0.063,
    familyCeiling: 70000,
    familyRate: 0.0575,
    accidentRate: 0.02,
    retirementEmployerRate: 0.077,
  },

  ius: {
    abatementRate: 0.3,
    brackets: [
      { lower: 0, rate: 0, base: 0 },
      { lower: 75000, rate: 0.15, base: 0 },
      { lower: 240000, rate: 0.2, base: 24750 },
      { lower: 800000, rate: 0.25, base: 136750 },
      { lower: 2400000, rate: 0.35, base: 536750 },
    ],
    familySpouseReduction: 0.1,
    familyChildReduction: 0.1,
    familyChildCap: 4,
    reductionCap: 0.5,
  },

  cmuFlat: 1000,
  cueRate: 0.012,

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

  cnps: {
    ceiling: 3600000,
    employeeRate: 0.056, // IPRES RG (placeholder)
    familyCeiling: 63000,
    familyRate: 0.07,
    accidentRate: 0.01,
    retirementEmployerRate: 0.084,
  },

  ius: {
    abatementRate: 0, // le Sénégal n'a pas l'abattement 30% ivoirien
    brackets: [
      { lower: 0, rate: 0, base: 0 },
      { lower: 50000, rate: 0.2, base: 0 },
      { lower: 250000, rate: 0.3, base: 40000 },
      { lower: 750000, rate: 0.4, base: 190000 },
    ],
    familySpouseReduction: 0,
    familyChildReduction: 0,
    familyChildCap: 0,
    reductionCap: 0,
  },

  cmuFlat: 0,
  cueRate: 0.03, // CFCE (placeholder)

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
