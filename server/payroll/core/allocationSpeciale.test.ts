import { describe, it, expect } from './testkit';
import { calculatePayroll } from './engine';
import type { Employee, MonthlyVariables } from './types';

/**
 * Allocations spéciales « frais inhérents à la fonction ou à l'emploi »
 * — art. 116-1° du Code général des Impôts
 * — note de service DGI n° 054/MFB/DGI-DLCD du 08 juillet 2024
 *
 * Règle : exonérées « dans la limite du dixième de la rémunération totale,
 * indemnités comprises, hors avantages en nature ». La prime légale de transport
 * exonérée est EXCLUE de l'assiette des 10 %.
 */

// Embauche récente → prime d'ancienneté nulle, pour isoler la règle testée.
function emp(over: Partial<Employee> = {}): Employee {
  return {
    id: 'e1', matricule: 'M1', nom: 'TEST', prenoms: 'Cas', dateNaissance: '1990-01-01',
    dateEmbauche: '2025-06-01', poste: 'Cadre', categorie: 'Cadre',
    statutMatrimonial: 'Celibataire', nombreEnfants: 0, nombrePartsIGR: 1,
    salaireBase: 500000, sursalaire: 0, indemniteTransport: 50000,
    indemniteLogement: 0, autresPrimes: 0, ...over,
  };
}

const vars: MonthlyVariables = {
  employeeId: 'e1', year: 2026, month: 0,
  heuresSup15: 0, heuresSup50: 0, heuresSup75: 0, heuresSup100: 0,
  joursAbsence: 0, primesExceptionnelles: 0, retenuesDiverses: 0, acompte: 0,
};

describe('Allocation spéciale — plafond de 10 % (art. 116-1° CGI)', () => {
  it('sans indemnité de fonction, le calcul est inchangé (rétrocompatibilité)', () => {
    const r = calculatePayroll(emp(), vars);
    expect(r.indemniteFonction).toBe(0);
    expect(r.indemniteFonctionExoneree).toBe(0);
    expect(r.indemniteFonctionImposable).toBe(0);
    // base 500 000 + transport imposable 20 000
    expect(r.salaireBrutImposable).toBe(520000);
  });

  it('en dessous du plafond : intégralement exonérée', () => {
    // Assiette = 500 000 + 20 000 (transport imposable) + 40 000 = 560 000 → plafond 56 000
    const r = calculatePayroll(emp({ indemniteFonction: 40000 }), vars);
    expect(r.indemniteFonctionExoneree).toBe(40000);
    expect(r.indemniteFonctionImposable).toBe(0);
    // L'indemnité n'entre PAS dans l'assiette imposable…
    expect(r.salaireBrutImposable).toBe(520000);
    // …mais elle est bien versée (brut total).
    expect(r.salaireBrutTotal).toBe(590000);
  });

  it('au-dessus du plafond : le surplus devient imposable', () => {
    // Assiette = 500 000 + 20 000 + 100 000 = 620 000 → plafond 62 000
    const r = calculatePayroll(emp({ indemniteFonction: 100000 }), vars);
    expect(r.indemniteFonctionExoneree).toBe(62000);
    expect(r.indemniteFonctionImposable).toBe(38000);
    expect(r.salaireBrutImposable).toBe(520000 + 38000);
    expect(r.salaireBrutTotal).toBe(650000);
  });

  it("l'assiette des 10 % inclut l'indemnité elle-même (« indemnités comprises »)", () => {
    // Si l'assiette excluait l'indemnité, le plafond serait 52 000 (10 % de 520 000)
    // et non 62 000. On vérifie que c'est bien 62 000.
    const r = calculatePayroll(emp({ indemniteFonction: 100000 }), vars);
    expect(r.indemniteFonctionExoneree).toBe(62000);
    expect(r.indemniteFonctionExoneree).not.toBe(52000);
  });

  it("l'assiette des 10 % EXCLUT la prime légale de transport exonérée", () => {
    // Deux salariés identiques, l'un sans transport, l'autre avec 30 000 (100 %
    // exonérés). Le plafond doit être le MÊME : le transport exonéré ne gonfle
    // pas l'assiette.
    const sansTransport = calculatePayroll(emp({ indemniteTransport: 0, indemniteFonction: 100000 }), vars);
    const avecTransport = calculatePayroll(emp({ indemniteTransport: 30000, indemniteFonction: 100000 }), vars);
    expect(sansTransport.indemniteFonctionExoneree).toBe(60000); // 10 % de 600 000
    expect(avecTransport.indemniteFonctionExoneree).toBe(60000); // inchangé
  });

  it('la part exonérée échappe à la CNPS et à l\'IUS', () => {
    const sans = calculatePayroll(emp(), vars);
    const avec = calculatePayroll(emp({ indemniteFonction: 40000 }), vars);
    // Assiette imposable identique → mêmes cotisations et même impôt,
    // alors que le salarié perçoit 40 000 de plus.
    expect(avec.cnpsSalarial).toBe(sans.cnpsSalarial);
    expect(avec.itsSalarial).toBe(sans.itsSalarial);
    expect(avec.salaireNetPaye).toBe(sans.salaireNetPaye + 40000);
  });
});

/**
 * Plancher et plafonds CNPS — communiqué officiel CNPS suite au décret
 * n° 2022-986 du 21/12/2022 (SMIG 75 000), en vigueur au 01/01/2023 :
 *   • plancher toutes branches confondues : 75 000
 *   • plafond branche retraite            : 3 375 000
 *   • plafond autres branches (PF/AT/mat.) : 75 000
 */
describe('Assiettes CNPS — plancher et plafonds officiels', () => {
  it('un salaire SOUS le plancher cotise quand même sur 75 000', () => {
    const r = calculatePayroll(emp({ salaireBase: 40000, indemniteTransport: 0 }), vars);
    expect(r.salaireBrutImposable).toBe(40000);
    expect(r.cnpsSalarial).toBe(4725);          // 75 000 x 6,3 %, pas 40 000
    expect(r.cnpsRetraitePatronal).toBe(5775);  // 75 000 x 7,7 %
  });

  it('la retraite est plafonnée à 3 375 000', () => {
    const r = calculatePayroll(emp({ salaireBase: 5000000, indemniteTransport: 0 }), vars);
    expect(r.cnpsSalarial).toBe(212625);         // 3 375 000 x 6,3 %
    expect(r.cnpsRetraitePatronal).toBe(259875); // 3 375 000 x 7,7 %
  });

  it('les autres branches sont assises sur 75 000 quel que soit le salaire', () => {
    const bas = calculatePayroll(emp({ salaireBase: 40000, indemniteTransport: 0 }), vars);
    const haut = calculatePayroll(emp({ salaireBase: 5000000, indemniteTransport: 0 }), vars);
    for (const r of [bas, haut]) {
      expect(r.cnpsFamille).toBe(4313);  // 75 000 x 5,75 %
      expect(r.cnpsAccident).toBe(1500); // 75 000 x 2 %
    }
  });
});

/**
 * Impôts & taxes employeur (DGI) — formulaire officiel de déclaration (FUDP),
 * sections 03.2 (CE, CN) et 03.4 (TA, TFPC), taux effectifs sur le brut imposable :
 *   Personnel LOCAL    = 2,8 % (CE 0 + CN 1,2 + TA 0,4 + TFPC 1,2)
 *   Personnel EXPATRIÉ = 12 %  (CE 9,2 + CN 1,2 + TA 0,4 + TFPC 1,2)
 */
describe('Taxes employeur DGI — local 2,8 % / expatrié 12 %', () => {
  const base = () => emp({ salaireBase: 1000000, indemniteTransport: 0 }); // brut imposable 1 000 000
  it('personnel local : CE nulle, total DGI = 2,8 %', () => {
    const r = calculatePayroll(base(), vars); // localExpatrie non renseigné → local
    expect(r.contributionEmployeur).toBe(0);
    expect(r.contributionNationale).toBe(12000); // 1,2 %
    expect(r.taxeApprentissage).toBe(4000);      // 0,4 %
    expect(r.formationContinue).toBe(12000);     // 1,2 %
    // total DGI = 28 000 = 2,8 % de 1 000 000
    expect(r.contributionEmployeur! + r.contributionNationale! + r.taxeApprentissage + r.formationContinue).toBe(28000);
  });
  it('personnel expatrié : CE 9,2 %, total DGI = 12 %', () => {
    const r = calculatePayroll(emp({ salaireBase: 1000000, indemniteTransport: 0, localExpatrie: 'E' }), vars);
    expect(r.contributionEmployeur).toBe(92000); // 9,2 %
    expect(r.contributionEmployeur! + r.contributionNationale! + r.taxeApprentissage + r.formationContinue).toBe(120000); // 12 %
  });
});
