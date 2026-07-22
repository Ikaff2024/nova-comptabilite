import { describe, it, expect } from './testkit';
import { installmentDue, advanceDeductionForMonth, advanceRemaining } from './loans';
import { SalaryAdvance } from './types';

function adv(o: Partial<SalaryAdvance> = {}): SalaryAdvance {
  return {
    id: 'a', employeeId: 'e', type: 'avance', montantTotal: 250000, mensualite: 100000,
    startYear: 2026, startMonth: 3 /* avril */, createdAt: '2026-04-01T00:00:00Z', ...o,
  };
}

describe('Échéancier avance/prêt', () => {
  it('avant le début : rien', () => {
    expect(installmentDue(adv(), 2026, 2)).toBe(0);
  });
  it('échéances pleines puis dernière partielle (250000 / 100000)', () => {
    const a = adv();
    expect(installmentDue(a, 2026, 3)).toBe(100000); // avril
    expect(installmentDue(a, 2026, 4)).toBe(100000); // mai
    expect(installmentDue(a, 2026, 5)).toBe(50000); // juin : reliquat
    expect(installmentDue(a, 2026, 6)).toBe(0); // juillet : soldé
  });
  it('mensualité qui divise juste (300000 / 100000 = 3 pleines)', () => {
    const a = adv({ montantTotal: 300000 });
    expect(installmentDue(a, 2026, 5)).toBe(100000); // 3e (juin)
    expect(installmentDue(a, 2026, 6)).toBe(0);
  });
  it('somme sur plusieurs avances', () => {
    const list = [adv({ id: '1' }), adv({ id: '2', montantTotal: 60000, mensualite: 60000 })];
    expect(advanceDeductionForMonth(list, 2026, 3)).toBe(160000);
    expect(advanceDeductionForMonth(list, 2026, 4)).toBe(100000); // la 2e est soldée
  });
  it('restant dû décroît puis s’annule', () => {
    const a = adv();
    expect(advanceRemaining(a, 2026, 3)).toBe(150000);
    expect(advanceRemaining(a, 2026, 4)).toBe(50000);
    expect(advanceRemaining(a, 2026, 5)).toBe(0);
  });
});
