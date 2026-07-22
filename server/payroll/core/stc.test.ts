import { describe, it, expect } from './testkit';
import { computeSTC, referenceSalaryFromPayslips, STCInput } from './stc';
import { SavedPayslip } from './types';

function baseInput(o: Partial<STCInput> = {}): STCInput {
  return {
    ruptureType: 'licenciement',
    ruptureDate: '2026-06-30',
    tenureYears: 3,
    referenceSalary: 400000,
    monthlySalary: 300000,
    joursCongesNonPris: 5,
    preavisEffectue: false,
    categorie: 'Cadre', // préavis 3 mois
    ...o,
  };
}

const amount = (r: ReturnType<typeof computeSTC>, key: string) => r.lines.find((l) => l.key === key)?.amount ?? 0;

describe('computeSTC — matrice des droits', () => {
  it('licenciement 3 ans : congés + préavis (3 mois) + indemnité (0,30×3)', () => {
    const r = computeSTC(baseInput({ tenureYears: 3 }));
    expect(amount(r, 'conges')).toBe(Math.round(5 * (400000 / 26))); // 76 923
    expect(amount(r, 'preavis')).toBe(3 * 300000); // 900 000
    expect(amount(r, 'licenciement')).toBe(Math.round(400000 * 0.9)); // 360 000
    expect(r.total).toBe(amount(r, 'conges') + 900000 + 360000);
    expect(r.ruleSetVersion).toBe('CI-2024.2');
  });

  it('barème par tranches : 8 ans → 0,30×5 + 0,35×3 = 2,55', () => {
    const r = computeSTC(baseInput({ tenureYears: 8, preavisEffectue: true }));
    expect(amount(r, 'licenciement')).toBe(Math.round(400000 * 2.55)); // 1 020 000
  });

  it('barème par tranches : 12 ans → 1,5 + 1,75 + 0,8 = 4,05', () => {
    const r = computeSTC(baseInput({ tenureYears: 12, preavisEffectue: true }));
    expect(amount(r, 'licenciement')).toBe(Math.round(400000 * 4.05)); // 1 620 000
  });

  it('ancienneté < 1 an : pas d’indemnité de licenciement', () => {
    const r = computeSTC(baseInput({ tenureYears: 0.5, preavisEffectue: true }));
    expect(amount(r, 'licenciement')).toBe(0);
  });

  it('préavis effectué : pas d’indemnité compensatrice de préavis', () => {
    const r = computeSTC(baseInput({ preavisEffectue: true }));
    expect(amount(r, 'preavis')).toBe(0);
  });

  it('fin de CDD : indemnité 6 % du brut total, ni préavis ni licenciement', () => {
    const r = computeSTC(baseInput({ ruptureType: 'fin_cdd', cddTotalGross: 3600000 }));
    expect(amount(r, 'fin_cdd')).toBe(Math.round(3600000 * 0.06)); // 216 000
    expect(amount(r, 'preavis')).toBe(0);
    expect(amount(r, 'licenciement')).toBe(0);
  });

  it('faute lourde : uniquement salaire + congés', () => {
    const r = computeSTC(baseInput({ ruptureType: 'faute_lourde', salaireMoisDu: 150000 }));
    expect(amount(r, 'salaire')).toBe(150000);
    expect(amount(r, 'conges')).toBeGreaterThan(0);
    expect(amount(r, 'preavis')).toBe(0);
    expect(amount(r, 'licenciement')).toBe(0);
  });

  it('démission : pas d’indemnité de licenciement ni de préavis à verser', () => {
    const r = computeSTC(baseInput({ ruptureType: 'demission' }));
    expect(amount(r, 'licenciement')).toBe(0);
    expect(amount(r, 'preavis')).toBe(0);
    expect(amount(r, 'conges')).toBeGreaterThan(0);
  });
});

describe('referenceSalaryFromPayslips', () => {
  const mk = (year: number, month: number, brut: number): SavedPayslip => ({
    id: `e_${year}_${month}`, employeeId: 'e', year, month,
    variables: {} as SavedPayslip['variables'],
    calculation: { salaireBrutTotal: brut } as SavedPayslip['calculation'],
    createdAt: '2026-01-01T00:00:00Z',
  });

  it('moyenne des N derniers bulletins', () => {
    const payslips = [mk(2026, 5, 300000), mk(2026, 4, 300000), mk(2026, 3, 360000)];
    expect(referenceSalaryFromPayslips(payslips, 'e', 12)).toBe(320000);
  });

  it('aucun historique → 0', () => {
    expect(referenceSalaryFromPayslips([], 'e', 12)).toBe(0);
  });
});
