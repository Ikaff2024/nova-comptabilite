import { describe, it, expect } from './testkit';
import {
  calculatePayroll,
  calculateTenure,
  calculateIGRParts,
  calculateCN,
  calculateIGRPerPart,
  formatFCFA,
  getMonthName,
} from './engine';
import { Employee, MonthlyVariables } from './types';

/**
 * GOLDEN TESTS — Moteur de paie IvoirePaie
 * =========================================================================
 *     Ces cas verrouillent le comportement du moteur contre les régressions.
 *
 * 📌  BARÈME ITS : depuis la révision du 21/07/2026, les cas fiscaux sont calés
 *     sur le BARÈME OFFICIEL DGI (0/16/21/24/28/32 %, sans abattement, RICF en
 *     montant fixe par parts) — source : onglet PARAMETRES du modèle officiel
 *     État 301 + note DGI du 03/01/2024.
 *
 * ⚠️  HISTORIQUE : les versions antérieures de ces tests figeaient un barème
 *     ERRONÉ (0/15/20/25/35 % avec abattement 30 % et réduction en pourcentage),
 *     qui sous-évaluait l'impôt d'environ 45 %. Les tests étaient verts : ils
 *     verrouillaient l'erreur. Leçon : un golden test ne prouve pas la
 *     conformité légale, seulement la stabilité.
 *
 * ⚠️  Les valeurs fiscales n'ont PAS été certifiées par un expert-comptable
 *     agréé. Elles reposent sur des sources officielles concordantes.
 * =========================================================================
 */

// Employé de base réutilisable (aucune prime, embauche récente → pas d'ancienneté).
function baseEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'test-emp',
    matricule: 'TEST-001',
    nom: 'TEST',
    prenoms: 'Cas',
    dateNaissance: '1990-01-01',
    dateEmbauche: '2025-01-01', // embauche récente → ancienneté nulle sur 2026
    poste: 'Testeur',
    categorie: 'Employe',
    statutMatrimonial: 'Celibataire',
    nombreEnfants: 0,
    nombrePartsIGR: 1,
    salaireBase: 0,
    sursalaire: 0,
    indemniteTransport: 0,
    indemniteLogement: 0,
    autresPrimes: 0,
    ...overrides,
  };
}

function zeroVariables(overrides: Partial<MonthlyVariables> = {}): MonthlyVariables {
  return {
    employeeId: 'test-emp',
    year: 2026,
    month: 5, // Juin
    heuresSup15: 0,
    heuresSup50: 0,
    heuresSup75: 0,
    heuresSup100: 0,
    joursAbsence: 0,
    primesExceptionnelles: 0,
    retenuesDiverses: 0,
    acompte: 0,
    ...overrides,
  };
}

describe('Golden — cas A : ouvrier célibataire au SMIG (75 000)', () => {
  const emp = baseEmployee({ categorie: 'Ouvrier', salaireBase: 75000 });
  const r = calculatePayroll(emp, zeroVariables());

  it('brut = SMIG, aucune prime', () => {
    expect(r.salaireBrutTotal).toBe(75000);
    expect(r.salaireBrutImposable).toBe(75000);
  });
  it('CNPS salarial = 6,3% de 75 000 = 4 725', () => {
    expect(r.cnpsSalarial).toBe(4725);
  });
  it('IUS = 0 (base abattue 52 500 < seuil 75 000)', () => {
    expect(r.itsSalarial).toBe(0);
    expect(r.cnSalarial).toBe(0);
    expect(r.igrSalarial).toBe(0);
  });
  it('CMU = 1 000', () => {
    expect(r.cmuSalarial).toBe(1000);
  });
  it('net payé = 75 000 - 4 725 - 1 000 = 69 275', () => {
    expect(r.totalRetenuesSalariales).toBe(5725);
    expect(r.salaireNetPaye).toBe(69275);
  });
  it('charges patronales CNPS + DGI (personnel local, base 75 000)', () => {
    // CNPS : autres branches assises sur 75 000 (plancher = plafond depuis 2023).
    expect(r.cnpsFamille).toBe(4313); // 75 000 x 5,75 % (PF 5 % + maternité 0,75 %)
    expect(r.cnpsAccident).toBe(1500); // 75 000 x 2 %
    expect(r.cnpsRetraitePatronal).toBe(5775); // 75 000 x 7,7 %
    // Taxes DGI employeur (§03.2/03.4 du FUDP), personnel local = 2,8 % :
    expect(r.contributionEmployeur).toBe(0); // CE : local exonéré
    expect(r.contributionNationale).toBe(900); // CN 1,2 %
    expect(r.taxeApprentissage).toBe(300); // TA 0,4 %
    expect(r.formationContinue).toBe(900); // TFPC 1,2 %
    // Total : 11 588 CNPS + 2 100 DGI = 13 688
    expect(r.totalChargesPatronales).toBe(13688);
  });
  it('coût total employeur = 75 000 + 13 688 = 88 688', () => {
    expect(r.totalCoutEmployeur).toBe(88688);
  });
});

describe('Golden — cas C : cadre marié 4 enfants au-dessus des plafonds', () => {
  // Base 2 000 000 + sursalaire 1 000 000, transport 50 000 (30 000 exonéré),
  // logement 300 000. Marié + 4 enfants → 2 + 4×0,5 = 4 parts, soit une RICF
  // mensuelle de 33 000 F (barème DGI). Depuis la réforme 2024, c'est le NOMBRE
  // DE PARTS qui pilote la réduction, plus le statut/enfants directement.
  const emp = baseEmployee({
    categorie: 'Cadre',
    statutMatrimonial: 'Marie(e)',
    nombreEnfants: 4,
    nombrePartsIGR: 4,
    salaireBase: 2000000,
    sursalaire: 1000000,
    indemniteTransport: 50000,
    indemniteLogement: 300000,
  });
  const r = calculatePayroll(emp, zeroVariables());

  it('transport : 30 000 exonéré, 20 000 imposable', () => {
    expect(r.transportExonere).toBe(30000);
    expect(r.transportImposable).toBe(20000);
  });
  it('brut total 3 350 000 / brut imposable 3 320 000', () => {
    expect(r.salaireBrutTotal).toBe(3350000);
    expect(r.salaireBrutImposable).toBe(3320000);
  });
  it('CNPS salarial 6,3% sous plafond 3 375 000 = 209 160', () => {
    expect(r.cnpsSalarial).toBe(209160);
  });
  it('ITS brut 785 600 − RICF 33 000 (4 parts) = 752 600', () => {
    // Barème officiel sur 3 320 000 : 165 000×16 % + 560 000×21 %
    //                               + 1 600 000×24 % + 920 000×28 % = 785 600
    expect(r.iusBrut).toBe(785600);
    expect(r.iusReduction).toBe(33000);
    expect(r.itsSalarial).toBe(752600);
  });
  it('retraite patronale 7,7% de 3 320 000 = 255 640', () => {
    expect(r.cnpsRetraitePatronal).toBe(255640);
  });
  it('net payé = 3 350 000 - 962 760 = 2 387 240', () => {
    // 209 160 CNPS + 752 600 ITS + 1 000 CMU = 962 760
    expect(r.totalRetenuesSalariales).toBe(962760);
    expect(r.salaireNetPaye).toBe(2387240);
  });
  it('coût total employeur = 3 704 413', () => {
    // Charges DGI local 2,8 % de 3 320 000 = 92 960 (CN 39 840 + TA 13 280 + TFPC 39 840)
    expect(r.totalCoutEmployeur).toBe(3704413);
  });
});

describe('Golden — cas D : heures sup 15% + absences (célibataire)', () => {
  // Base 150 000 + sursalaire 50 000, 10 h à 15 %, 2 jours d'absence.
  const emp = baseEmployee({ salaireBase: 150000, sursalaire: 50000 });
  const r = calculatePayroll(emp, zeroVariables({ heuresSup15: 10, joursAbsence: 2 }));

  it("déduction d'absence = round((200 000/30) x 2) = 13 333", () => {
    // effectif = 200 000 - 13 333 = 186 667
    // vérifié indirectement via le brut ci-dessous
    expect(r.salaireBrutImposable).toBe(199936);
  });
  it('heures sup 15% : 10 x (200 000/173,33) x 1,15 = 13 269', () => {
    expect(r.heuresSupMontant).toBe(13269);
  });
  it('CNPS salarial = round(199 936 x 6,3%) = 12 596', () => {
    expect(r.cnpsSalarial).toBe(12596);
  });
  it('ITS = 124 936 x 16% = 19 990 (1 part -> RICF nulle)', () => {
    // Barème officiel appliqué au brut imposable, sans abattement :
    // tranche 0-75 000 à 0 %, puis (199 936 - 75 000) x 16 %.
    expect(r.iusBrut).toBe(19990);
    expect(r.iusReduction).toBe(0);
    expect(r.itsSalarial).toBe(19990);
  });
  it('net payé = 199 936 - 33 586 = 166 350', () => {
    expect(r.totalRetenuesSalariales).toBe(33586);
    expect(r.salaireNetPaye).toBe(166350);
  });
});

describe('calculateTenure — ancienneté', () => {
  it('renvoie 0 pour une date vide ou invalide', () => {
    expect(calculateTenure('', 2026, 5)).toBe(0);
    expect(calculateTenure('pas-une-date', 2026, 5)).toBe(0);
  });
  it('~6 ans entre 2020-06 et 2026-06', () => {
    const t = calculateTenure('2020-06-01', 2026, 5);
    expect(t).toBeGreaterThan(5.9);
    expect(t).toBeLessThan(6.1);
  });
  it('ancienneté nulle si embauche postérieure au mois de paie', () => {
    expect(calculateTenure('2030-01-01', 2026, 5)).toBe(0);
  });
});

describe('Prime d\'ancienneté (via moteur)', () => {
  it('2% dès 2 ans révolus, appliqués sur le salaire de base', () => {
    // embauche 2023-06-01, paie juin 2026 → ~3 ans → 3%
    const emp = baseEmployee({ salaireBase: 100000, dateEmbauche: '2023-06-01' });
    const r = calculatePayroll(emp, zeroVariables());
    expect(r.tauxAnciennete).toBe(3);
    expect(r.primeAnciennete).toBe(3000);
  });
  it('plafonnée à 25%', () => {
    const emp = baseEmployee({ salaireBase: 100000, dateEmbauche: '1980-01-01' });
    const r = calculatePayroll(emp, zeroVariables());
    expect(r.tauxAnciennete).toBe(25);
    expect(r.primeAnciennete).toBe(25000);
  });
});

describe('calculateIGRParts (quotient familial — hérité, non utilisé par le moteur IUS)', () => {
  // ⚠️ Depuis la réforme IUS, le moteur n'utilise plus les parts IGR.
  //    On documente le comportement historique pour décider de son sort.
  it('célibataire sans enfant = 1 part', () => {
    expect(calculateIGRParts('Celibataire', 0)).toBe(1);
  });
  it('marié 3 enfants = 3,5 parts', () => {
    expect(calculateIGRParts('Marie(e)', 3)).toBe(3.5);
  });
  it('parent isolé 1 enfant = 2 parts (0,5 supplémentaire)', () => {
    expect(calculateIGRParts('Celibataire', 1)).toBe(2);
  });
  it('plafonné à 5 parts', () => {
    expect(calculateIGRParts('Marie(e)', 20)).toBe(5);
  });
});

describe('Barèmes hérités CN / IGR (code mort — à retirer ou réactiver)', () => {
  // 🔴 Ces fonctions ne sont plus appelées par calculatePayroll (IUS les remplace).
  //    Tests de caractérisation pour tracer une décision explicite, pas une validation.
  it('calculateCN : exonéré sous 50 000', () => {
    expect(calculateCN(40000)).toBe(0);
  });
  it('calculateIGRPerPart : exonéré sous 25 000', () => {
    expect(calculateIGRPerPart(20000)).toBe(0);
  });
});

describe('Formatage', () => {
  it('formatFCFA formate le nombre groupé, sans devise', () => {
    const s = formatFCFA(1234567);
    expect(s).not.toMatch(/FCFA|XOF|F\s?CFA/u);
    // Chiffres groupés uniquement (les séparateurs sont des espaces).
    expect(s.replace(/\s/gu, '')).toBe('1234567');
  });
  it('getMonthName : 5 → Juin', () => {
    expect(getMonthName(5)).toBe('Juin');
  });
});
