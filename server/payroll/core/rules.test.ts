import { describe, it, expect } from './testkit';
import { resolveRuleSet, applyProgressive, RULE_SETS } from './rules';
import { calculatePayroll } from './engine';
import { Employee, MonthlyVariables } from './types';

describe('Jeu de règles daté/versionné', () => {
  it('résout le barème CI en vigueur (réforme 2024) pour 2026', () => {
    const rs = resolveRuleSet(2026, 5);
    expect(rs.version).toBe('CI-2024.2');
    expect(rs.country).toBe('CI');
    expect(rs.cnps.employeeRate).toBe(0.063);
  });

  it('résout aussi pour 2024 et 2025 (même réforme en vigueur)', () => {
    expect(resolveRuleSet(2024, 0).version).toBe('CI-2024.2');
    expect(resolveRuleSet(2025, 11).version).toBe('CI-2024.2');
  });

  it('résout un pays distinct (Sénégal, placeholder) sans affecter la CI', () => {
    const sn = resolveRuleSet(2026, 5, 'SN');
    expect(sn.country).toBe('SN');
    expect(sn.version).toContain('SN');
    expect(resolveRuleSet(2026, 5).country).toBe('CI'); // défaut inchangé
  });

  it('applyProgressive reproduit le barème ITS officiel (sans abattement)', () => {
    const brackets = RULE_SETS[0].ius.brackets;
    expect(applyProgressive(50000, brackets)).toBe(0); // tranche à 0 %
    // Bornes exactes : impôt cumulé au seuil bas de chaque tranche.
    expect(applyProgressive(240000, brackets)).toBe(26400); // 165 000 × 16 %
    expect(applyProgressive(800000, brackets)).toBe(144000); // + 560 000 × 21 %
    expect(applyProgressive(2400000, brackets)).toBe(528000); // + 1 600 000 × 24 %
    expect(applyProgressive(8000000, brackets)).toBe(2096000); // + 5 600 000 × 28 %
    // Exemple de référence DGI : 500 000 → 81 000.
    expect(applyProgressive(500000, brackets)).toBe(81000);
  });

  it('le calcul estampille la version de règles appliquée', () => {
    const emp: Employee = {
      id: 't', matricule: 'T', nom: 'X', prenoms: 'Y', dateNaissance: '1990-01-01',
      dateEmbauche: '2025-01-01', poste: 'P', categorie: 'Employe',
      statutMatrimonial: 'Celibataire', nombreEnfants: 0, nombrePartsIGR: 1,
      salaireBase: 200000, sursalaire: 0, indemniteTransport: 0, indemniteLogement: 0, autresPrimes: 0,
    };
    const v: MonthlyVariables = {
      employeeId: 't', year: 2026, month: 5,
      heuresSup15: 0, heuresSup50: 0, heuresSup75: 0, heuresSup100: 0,
      joursAbsence: 0, primesExceptionnelles: 0, retenuesDiverses: 0, acompte: 0,
    };
    const r = calculatePayroll(emp, v);
    expect(r.ruleSetVersion).toBe('CI-2024.2');
    expect(r.ruleSetLabel).toContain('2024');
  });
});
