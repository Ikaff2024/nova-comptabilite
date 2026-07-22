// Types du domaine « paie » — source de vérité partagée entre le front et le
// backend (le moteur de calcul et les entités qu'il manipule).

export type SocioProCategory = 'Ouvrier' | 'Employe' | 'Agent de Maitrise' | 'Cadre';

export type MaritalStatus = 'Celibataire' | 'Marie(e)' | 'Divorce(e)' | 'Veuf/Veuve';

export type ContractType = 'CDI' | 'CDD' | 'Stage' | 'Interim';

export type PaymentMode = 'Virement' | 'Mobile Money' | 'Espèces';

export interface Employee {
  id: string;
  matricule: string; // ID card / internal ID
  nom: string;
  prenoms: string;
  dateNaissance: string;
  dateEmbauche: string;
  poste: string;
  categorie: SocioProCategory;
  statutMatrimonial: MaritalStatus;
  nombreEnfants: number;
  nombrePartsIGR: number; // Auto-calculated or manual override
  salaireBase: number;
  sursalaire: number;
  indemniteTransport: number; // Tax-exempt up to 30,000 FCFA
  indemniteLogement: number;
  autresPrimes: number;
  // Allocation spéciale couvrant les frais inhérents à la fonction ou à l'emploi
  // (indemnité de fonction / de représentation, frais d'emploi). Exonérée dans la
  // limite de 10 % de la rémunération totale — art. 116-1° CGI. Voir engine.ts.
  indemniteFonction?: number;
  email?: string;
  telephone?: string;
  // Volet contractuel (optionnels : rétro-compatibles avec les fiches existantes).
  typeContrat?: ContractType;
  dateFinContrat?: string; // YYYY-MM-DD — pour les CDD
  conventionCollective?: string;
  // Coordonnées de paiement (pour les fichiers de virement / Mobile Money).
  modePaiement?: PaymentMode;
  rib?: string; // compte bancaire / IBAN (virement)
  banque?: string;
  mobileMoneyNumero?: string;
  mobileMoneyOperateur?: string; // Orange | MTN | Moov | Wave
  // Hiérarchie : responsable direct (organigramme + workflow d'approbation congés).
  managerId?: string;
  // --- Informations déclaratives officielles (CNPS, État 301) ---
  // Optionnelles : les fiches existantes restent valides, l'export signale les
  // manques. Codes imposés par les formulaires DGI/CNPS.
  numeroCnps?: string;              // immatriculation CNPS DU SALARIÉ
  sexe?: 'M' | 'F';
  nationalite?: NationaliteCode;
  localExpatrie?: 'L' | 'E';
  codeEmploi?: CodeEmploi;          // à défaut : dérivé de la catégorie
}

/** Nationalité au sens de l'État 301 (DGI). */
export type NationaliteCode = 'I' | 'AA' | 'F' | 'SL' | 'A';

/** Code emploi au sens de l'État 301 (DGI). */
export type CodeEmploi = 'DR' | 'CS' | 'AM' | 'CM' | 'EQ' | 'EN' | 'OQ' | 'ON' | 'A';

export interface MonthlyVariables {
  employeeId: string;
  year: number;
  month: number; // 0 (Jan) - 11 (Dec)
  heuresSup15: number; // 15% rate
  heuresSup50: number; // 50% rate
  heuresSup75: number; // 75% rate (night)
  heuresSup100: number; // 100% rate (Sunday/Holiday)
  joursAbsence: number;
  primesExceptionnelles: number;
  retenuesDiverses: number;
  acompte: number;
  remboursementAvance?: number; // dérivé serveur : échéance d'avance/prêt du mois
}

export interface PayrollResult {
  // Gross components
  salaireBase: number;
  sursalaire: number;
  primeAnciennete: number;
  tauxAnciennete: number; // percentage (e.g. 5 for 5%)
  heuresSupMontant: number;
  primesExceptionnelles: number;
  indemniteLogement: number;
  autresPrimes: number;
  transportExonere: number; // up to 30000
  transportImposable: number; // portion above 30000
  // Allocation spéciale (art. 116-1° CGI) : part exonérée plafonnée à 10 % de la
  // rémunération totale hors avantages en nature, le surplus étant imposable.
  indemniteFonction: number;
  indemniteFonctionExoneree: number;
  indemniteFonctionImposable: number;

  salaireBrutTotal: number;
  salaireBrutImposable: number; // base for taxes

  // Employee Deductions
  cnpsSalarial: number; // 6.3%, capped at 3,375,000 FCFA (retirement)
  itsSalarial: number;  // 1.2% of Brut Imposable
  // Détail IUS pour l'État 301 (déclare l'impôt BRUT et la réduction pour
  // charges de famille séparément). Optionnels : absents des bulletins figés
  // avant leur introduction — l'export retombe alors sur itsSalarial.
  iusBrut?: number;
  iusReduction?: number;
  cnSalarial: number;   // Progressive Contribution Nationale
  igrSalarial: number;  // Impôt Général sur le Revenu
  cmuSalarial: number;  // 1000 FCFA per month per person
  retenuesDiverses: number;
  acompte: number;
  remboursementAvance: number; // échéance d'avance/prêt retenue ce mois
  totalRetenuesSalariales: number;

  // Net payments
  salaireNetPaye: number; // Net amount received by employee

  // Employer Charges
  cnpsFamille: number; // 5.75% up to 70k ceiling
  cnpsAccident: number; // 2% up to 70k ceiling
  cnpsRetraitePatronal: number; // 7.7% up to 3,375,000 ceiling
  taxeApprentissage: number; // TA 0,4 %
  formationContinue: number; // TFPC 1,2 %
  // Contributions employeur DGI (réforme 2024). CE = 0 (local) / 9,2 % (expatrié).
  contributionEmployeur?: number;
  contributionNationale?: number; // CN 1,2 %
  totalChargesPatronales: number;

  totalCoutEmployeur: number; // Gross Total + Employer Charges

  // Traçabilité du jeu de règles appliqué (socle veille légale / versioning).
  ruleSetVersion?: string; // ex. 'CI-2024.1'
  ruleSetLabel?: string; // libellé lisible
}

export interface SavedPayslip {
  id: string; // employeeId_year_month
  employeeId: string;
  year: number;
  month: number;
  variables: MonthlyVariables;
  calculation: PayrollResult;
  createdAt: string;
}

// Absence enregistrée au registre. Source de vérité de la déduction pour absence
// sur le bulletin : le moteur dérive `joursAbsence` des absences NON payées du
// mois (voir unpaidAbsenceDaysInMonth). `justifiee` est informatif ; c'est `paye`
// qui pilote la déduction (paye = false → déduit au prorata).
// Pointage journalier. Alimente la ventilation automatique des heures
// supplémentaires (voir overtime.ts) : jour ouvrable / nuit / dimanche-férié.
export interface TimeEntry {
  id: string;
  employeeId: string;
  date: string; // YYYY-MM-DD
  heuresJour: number; // heures de jour travaillées ce jour
  heuresNuit: number; // heures de nuit travaillées ce jour
  ferie: boolean; // jour férié ?
  createdAt: string;
}

// Avance ou prêt sur salaire, remboursé par échéances mensuelles automatiquement
// retenues sur les bulletins (voir loans.ts). L'échéancier est déterministe :
// aucun état mutable « restant dû » à maintenir, tout se recalcule.
export interface SalaryAdvance {
  id: string;
  employeeId: string;
  type: 'avance' | 'pret';
  montantTotal: number;
  mensualite: number;
  startYear: number;
  startMonth: number; // 0-11
  motif?: string;
  createdAt: string;
}

export interface Absence {
  id: string;
  employeeId: string;
  dateDebut: string; // YYYY-MM-DD
  dateFin: string; // YYYY-MM-DD
  jours: number; // jours ouvrables concernés (saisis / recalculés)
  justifiee: boolean; // absence couverte par un justificatif ?
  paye: boolean; // true → maintenue au salaire (pas de déduction)
  motif?: string;
  createdAt: string;
}
