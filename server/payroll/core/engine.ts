import { Employee, MonthlyVariables, PayrollResult } from './types';
import { resolveRuleSet, applyProgressive } from './rules';

/**
 * Calculates tenure in years from the hiring date to the current payroll month/year.
 */
export function calculateTenure(hireDateStr: string, currentYear: number, currentMonth: number): number {
  if (!hireDateStr) return 0;
  const hireDate = new Date(hireDateStr);
  if (isNaN(hireDate.getTime())) return 0;

  const current = new Date(currentYear, currentMonth, 1);
  const diffTime = current.getTime() - hireDate.getTime();
  const diffYears = diffTime / (1000 * 60 * 60 * 24 * 365.25);
  return Math.max(0, diffYears);
}

/**
 * Auto-calculates the quotient familial parts for IGR based on Côte d'Ivoire tax code:
 * - Single (Célibataire / Divorcé / Veuf): 1 part
 * - Married (Marié): 2 parts
 * - Each child adds 0.5 part, up to a maximum of 5 parts total.
 * Note: Single parent with children gets 1.5 parts for the first child, then 0.5 for subsequent.
 * We will use a standard, widely accepted simplified simulation:
 * - Single: 1 part + 0.5 part per child
 * - Married: 2 parts + 0.5 part per child
 * Cap at 5 parts max.
 */
export function calculateIGRParts(status: string, children: number): number {
  let baseParts = 1;
  if (status.startsWith('Marie')) {
    baseParts = 2;
  }
  
  let childParts = children * 0.5;
  
  // Single parents in CI get an extra 0.5 part for the first child
  if (!status.startsWith('Marie') && children > 0) {
    childParts += 0.5;
  }

  const totalParts = baseParts + childParts;
  return Math.min(5, Math.max(1, totalParts));
}

/**
 * Calculates Contribution Nationale (CN) in Côte d'Ivoire
 * Base CN = 80% of Gross Taxable Salary
 * Brackets:
 * - 0 to 50,000 FCFA: 0%
 * - 50,000 to 130,000 FCFA: 1.5%
 * - 130,000 to 250,000 FCFA: 5%
 * - 250,000 to 450,000 FCFA: 10%
 * - Above 450,000 FCFA: 15%
 */
export function calculateCN(baseCN: number): number {
  if (baseCN <= 50000) return 0;
  
  let tax = 0;
  
  if (baseCN <= 130000) {
    tax = (baseCN - 50000) * 0.015;
  } else if (baseCN <= 250000) {
    tax = 1200 + (baseCN - 130000) * 0.05; // 1200 = (130000-50000)*0.015
  } else if (baseCN <= 450000) {
    tax = 7200 + (baseCN - 250000) * 0.10; // 7200 = 1200 + (250000-130000)*0.05
  } else {
    tax = 27200 + (baseCN - 450000) * 0.15; // 27200 = 7200 + (450000-250000)*0.10
  }
  
  return Math.round(tax);
}

/**
 * Calculates Impôt Général sur le Revenu (IGR) per part in Côte d'Ivoire
 * R = Base IGR / Parts
 * Brackets:
 * - 0 to 25,000 FCFA: 0%
 * - 25,000 to 45,000 FCFA: 10% (minus 2500)
 * - 45,000 to 90,000 FCFA: 15% (minus 4750)
 * - 90,000 to 220,000 FCFA: 20% (minus 9250)
 * - 220,000 to 389,000 FCFA: 25% (minus 20250)
 * - 389,000 to 900,000 FCFA: 35% (minus 59150)
 * - Above 900,000 FCFA: 60% (minus 284150)
 */
export function calculateIGRPerPart(R: number): number {
  if (R <= 25000) return 0;
  
  let tax = 0;
  if (R <= 45000) {
    tax = R * 0.10 - 2500;
  } else if (R <= 90000) {
    tax = R * 0.15 - 4750;
  } else if (R <= 220000) {
    tax = R * 0.20 - 9250;
  } else if (R <= 389000) {
    tax = R * 0.25 - 20250;
  } else if (R <= 900000) {
    tax = R * 0.35 - 59150;
  } else {
    tax = R * 0.60 - 284150;
  }
  
  return Math.max(0, tax);
}

/**
 * Full payroll calculations
 */
export function calculatePayroll(employee: Employee, variables: MonthlyVariables, country = 'CI'): PayrollResult {
  // 0. Jeu de règles applicable à la période ET au pays (barèmes datés/versionnés).
  const rules = resolveRuleSet(variables.year, variables.month, country);

  // 1. Core items
  const baseSalary = employee.salaireBase;
  const sursalaire = employee.sursalaire;
  const transportAllowance = employee.indemniteTransport;
  const housingAllowance = employee.indemniteLogement;
  const otherPrimes = employee.autresPrimes;

  // 2. Absences deduction
  // Standard daily rate = (Base + Sursalaire) / diviseur (30)
  const dailyRate = (baseSalary + sursalaire) / rules.absenceDivisor;
  const absenceDeduction = Math.round(dailyRate * variables.joursAbsence);

  const effectiveBaseAndSursalaire = Math.max(0, (baseSalary + sursalaire) - absenceDeduction);

  // 3. Overtime Pay
  // Standard hourly rate = (Base + Sursalaire) / heures mensuelles (173.33)
  const hourlyRate = (baseSalary + sursalaire) / rules.hourlyDivisor;

  const hs15Pay = variables.heuresSup15 * hourlyRate * rules.overtime.hs15;
  const hs50Pay = variables.heuresSup50 * hourlyRate * rules.overtime.hs50;
  const hs75Pay = variables.heuresSup75 * hourlyRate * rules.overtime.hs75;
  const hs100Pay = variables.heuresSup100 * hourlyRate * rules.overtime.hs100;
  const totalOvertimePay = Math.round(hs15Pay + hs50Pay + hs75Pay + hs100Pay);

  // 4. Seniority Bonus (Prime d'Ancienneté)
  // startPct% après thresholdYears ans, +incrementPct%/an, plafonné à capPct%, sur le salaire de base.
  const tenureYears = calculateTenure(employee.dateEmbauche, variables.year, variables.month);
  let seniorityPct = 0;
  if (tenureYears >= rules.seniority.thresholdYears) {
    seniorityPct = rules.seniority.startPct + Math.floor(tenureYears - rules.seniority.thresholdYears) * rules.seniority.incrementPct;
    if (seniorityPct > rules.seniority.capPct) seniorityPct = rules.seniority.capPct;
  }
  const seniorityBonus = Math.round(baseSalary * (seniorityPct / 100));

  // 5. Exemption of Transport Allowance (exonéré jusqu'au plafond, ex. 30 000).
  const maxTransportExempt = rules.transportExemptCap;
  const transportExonere = Math.min(transportAllowance, maxTransportExempt);
  const transportImposable = Math.max(0, transportAllowance - maxTransportExempt);

  // 6. Gross Salary components
  const primesExceptionnelles = variables.primesExceptionnelles;

  // 6 bis. Allocation spéciale « frais inhérents à la fonction ou à l'emploi »
  // (art. 116-1° CGI ; note DGI n° 054/MFB/DGI-DLCD du 08/07/2024).
  // Exonérée « dans la limite du dixième de la rémunération totale, indemnités
  // comprises, hors avantages en nature ». L'assiette des 10 % EXCLUT la prime
  // légale de transport exonérée (et les avantages en nature, non gérés ici) :
  // on la calcule donc sur la rémunération en numéraire, indemnité de fonction
  // comprise, diminuée de la part de transport exonérée.
  // ⚠️ Le plafond est une LIMITE, pas une formule : la note interdit de calculer
  // ces allocations en appliquant un pourcentage au salaire, et exige des
  // justificatifs. Le montant réellement alloué est donc saisi, puis écrêté ici.
  const indemniteFonction = employee.indemniteFonction ?? 0;
  const remunerationTotaleHorsAvantages =
    effectiveBaseAndSursalaire +
    totalOvertimePay +
    seniorityBonus +
    housingAllowance +
    otherPrimes +
    primesExceptionnelles +
    transportImposable +
    indemniteFonction;
  const plafondAllocationSpeciale = remunerationTotaleHorsAvantages * rules.specialAllowanceExemptRate;
  const indemniteFonctionExoneree = Math.round(Math.min(indemniteFonction, plafondAllocationSpeciale));
  const indemniteFonctionImposable = Math.max(0, indemniteFonction - indemniteFonctionExoneree);

  // Total Gross Salary
  const salaireBrutTotal = Math.round(
    effectiveBaseAndSursalaire +
    totalOvertimePay +
    seniorityBonus +
    housingAllowance +
    otherPrimes +
    primesExceptionnelles +
    transportAllowance +
    indemniteFonction
  );

  // Taxable Gross Salary
  const salaireBrutImposable = Math.round(
    effectiveBaseAndSursalaire +
    totalOvertimePay +
    seniorityBonus +
    housingAllowance +
    otherPrimes +
    primesExceptionnelles +
    transportImposable +
    indemniteFonctionImposable
  );

  // 7. Social Contributions (Employee part)
  // Assiette CNPS : PLANCHER toutes branches (75 000 = SMIG) puis plafond de la
  // branche. Communiqué CNPS suite au décret n° 2022-986 (en vigueur 01/01/2023).
  // Le plancher fait que même un salaire partiel cotise sur au moins le SMIG.
  const cnpsCeiling = rules.cnps.ceiling;
  const cnpsFloor = rules.cnps.floor;
  const cnpsTaxableBase = Math.min(Math.max(salaireBrutImposable, cnpsFloor), cnpsCeiling);
  const cnpsSalarial = Math.round(cnpsTaxableBase * rules.cnps.employeeRate);

  // 8. Fiscale Deductions (Taxes)
  // --- IMPÔT SUR LES TRAITEMENTS ET SALAIRES (ITS unifié) — réforme 2024 ---
  // L'ordonnance du 13/09/2023 (note DGI du 03/01/2024) fusionne IS + CN + IGR
  // salarié en un prélèvement unique, SUPPRIME l'abattement forfaitaire, et
  // remplace le quotient familial par une réduction d'impôt pour charges de
  // famille (RICF) exprimée en MONTANT FIXE selon le nombre de parts.
  // Le barème est celui du modèle officiel État 301 (onglet PARAMETRES).
  const baseIUS = salaireBrutImposable * (1 - rules.ius.abatementRate);
  const rawIUS = applyProgressive(baseIUS, rules.ius.brackets);
  const iusBrut = Math.round(rawIUS);

  // RICF : on retient le palier dont le nombre de parts est le plus élevé sans
  // dépasser celui du salarié (les parts sont des multiples de 0,5, plafonnées).
  const parts = Math.min(rules.ius.maxParts, employee.nombrePartsIGR || 1);
  let ricf = 0;
  for (const p of rules.ius.ricfByParts) {
    if (parts >= p.parts) ricf = p.monthly;
    else break;
  }
  // L'impôt ne peut pas devenir négatif : la RICF est écrêtée à l'impôt brut.
  const iusReduction = Math.min(ricf, iusBrut);
  const iusSalarial = iusBrut - iusReduction;

  // For backward compatibility and standard interface integrity:
  // itsSalarial holds the new unified ITS value, while CN and IGR are 0.
  const itsSalarial = iusSalarial;
  const cnSalarial = 0;
  const igrSalarial = 0;

  // CMU (Couverture Maladie Universelle) — cotisation forfaitaire mensuelle.
  const cmuSalarial = rules.cmuFlat;

  // Remboursement d'avance/prêt (échéance du mois, dérivée du registre des avances).
  const remboursementAvance = variables.remboursementAvance ?? 0;

  // 9. Total Retenues
  const totalRetenuesSalariales = Math.round(
    cnpsSalarial +
    itsSalarial +
    cnSalarial +
    igrSalarial +
    cmuSalarial +
    variables.retenuesDiverses +
    variables.acompte +
    remboursementAvance
  );

  // 10. Net Payable
  const salaireNetPaye = Math.max(0, salaireBrutTotal - totalRetenuesSalariales);

  // 11. Employer Social Charges
  // Prestations familiales + maternité (5,75 %) : plancher puis plafond des
  // « autres branches ». Depuis 2023 plancher = plafond = 75 000, donc cette
  // assiette vaut en pratique toujours 75 000.
  const familyCeiling = rules.cnps.familyCeiling;
  const cnpsFamilyBase = Math.min(Math.max(salaireBrutImposable, cnpsFloor), familyCeiling);
  const cnpsFamille = Math.round(cnpsFamilyBase * rules.cnps.familyRate);

  // Accident du travail : accidentRate (2 %) sous le même plafond.
  const cnpsAccident = Math.round(cnpsFamilyBase * rules.cnps.accidentRate);

  // Retraite patronale : retirementEmployerRate (7,7 %) sous plafond retraite.
  const cnpsRetraitePatronal = Math.round(cnpsTaxableBase * rules.cnps.retirementEmployerRate);

  // --- IMPÔTS & TAXES EMPLOYEUR (DGI) — formulaire officiel FUDP, §03.2/03.4 ---
  // Tous sur le revenu brut imposable. La Contribution Employeur (CE) dépend du
  // statut : personnel LOCAL exonéré (0), personnel EXPATRIÉ 9,2 %.
  const et = rules.employerTaxes;
  const isExpat = employee.localExpatrie === 'E';
  const contributionEmployeur = Math.round(salaireBrutImposable * (isExpat ? et.ceRateExpat : et.ceRateLocal));
  const contributionNationale = Math.round(salaireBrutImposable * et.cnRate);
  const taxeApprentissage = Math.round(salaireBrutImposable * et.apprenticeshipRate); // TA 0,4 %
  const formationContinue = Math.round(salaireBrutImposable * et.trainingRate); // TFPC 1,2 %

  const totalChargesPatronales = Math.round(
    cnpsFamille +
    cnpsAccident +
    cnpsRetraitePatronal +
    contributionEmployeur +
    contributionNationale +
    taxeApprentissage +
    formationContinue
  );

  const totalCoutEmployeur = salaireBrutTotal + totalChargesPatronales;

  return {
    salaireBase: baseSalary,
    sursalaire,
    primeAnciennete: seniorityBonus,
    tauxAnciennete: seniorityPct,
    heuresSupMontant: totalOvertimePay,
    primesExceptionnelles,
    indemniteLogement: housingAllowance,
    autresPrimes: otherPrimes,
    transportExonere,
    transportImposable,
    indemniteFonction,
    indemniteFonctionExoneree,
    indemniteFonctionImposable,
    
    salaireBrutTotal,
    salaireBrutImposable,

    cnpsSalarial,
    itsSalarial,
    iusBrut,
    iusReduction,
    cnSalarial,
    igrSalarial,
    cmuSalarial,
    retenuesDiverses: variables.retenuesDiverses,
    acompte: variables.acompte,
    remboursementAvance,
    totalRetenuesSalariales,
    
    salaireNetPaye,

    cnpsFamille,
    cnpsAccident,
    cnpsRetraitePatronal,
    taxeApprentissage,
    formationContinue,
    contributionEmployeur,
    contributionNationale,
    totalChargesPatronales,

    totalCoutEmployeur,

    ruleSetVersion: rules.version,
    ruleSetLabel: rules.label,
  };
}

/**
 * Formate un montant (séparateurs de milliers, sans décimales) SANS devise.
 * La devise (FCFA) n'est volontairement pas ajoutée derrière chaque montant :
 * on l'indiquera une seule fois si besoin. À revoir pour l'international.
 */
export function formatFCFA(value: number): string {
  return new Intl.NumberFormat('fr-CI', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

/**
 * Format month index (0-11) to name in French
 */
export function getMonthName(monthIndex: number): string {
  const months = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
  ];
  return months[monthIndex] || '';
}
