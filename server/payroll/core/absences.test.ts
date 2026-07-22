import { describe, it, expect } from './testkit';
import { workingDaysInMonth, unpaidAbsenceDaysInMonth } from './absences';
import { Absence } from './types';

// Repères juin 2026 : 01=Lun, 07=Dim, 08=Lun, 12=Ven, 14=Dim.

function abs(o: Partial<Absence>): Absence {
  return {
    id: 'a', employeeId: 'e', dateDebut: '2026-06-08', dateFin: '2026-06-12',
    jours: 5, justifiee: false, paye: false, createdAt: '2026-06-01T00:00:00Z', ...o,
  };
}

describe('workingDaysInMonth', () => {
  it('semaine ouvrée sans dimanche : Lun→Ven = 5', () => {
    expect(workingDaysInMonth('2026-06-08', '2026-06-12', 2026, 5)).toBe(5);
  });
  it('exclut les dimanches : 01→14 juin = 14 jours - 2 dimanches = 12', () => {
    expect(workingDaysInMonth('2026-06-01', '2026-06-14', 2026, 5)).toBe(12);
  });
  it('à cheval sur deux mois : ne compte que le mois cible', () => {
    // 28 mai → 02 juin, côté juin = 01 (Lun) + 02 (Mar) = 2.
    expect(workingDaysInMonth('2026-05-28', '2026-06-02', 2026, 5)).toBe(2);
  });
  it('hors du mois cible = 0', () => {
    expect(workingDaysInMonth('2026-06-08', '2026-06-12', 2026, 4)).toBe(0);
  });
  it('dates invalides ou inversées = 0', () => {
    expect(workingDaysInMonth('', '2026-06-12', 2026, 5)).toBe(0);
    expect(workingDaysInMonth('2026-06-12', '2026-06-08', 2026, 5)).toBe(0);
  });
});

describe('unpaidAbsenceDaysInMonth', () => {
  it('ignore les absences payées', () => {
    const list = [abs({ paye: true })];
    expect(unpaidAbsenceDaysInMonth(list, 2026, 5)).toBe(0);
  });
  it('somme les absences non payées du mois', () => {
    const list = [
      abs({ id: '1', dateDebut: '2026-06-08', dateFin: '2026-06-12' }), // 5
      abs({ id: '2', dateDebut: '2026-06-01', dateFin: '2026-06-01' }), // 1 (Lun)
      abs({ id: '3', dateDebut: '2026-06-07', dateFin: '2026-06-07', paye: true }), // payée → 0
    ];
    expect(unpaidAbsenceDaysInMonth(list, 2026, 5)).toBe(6);
  });
});
