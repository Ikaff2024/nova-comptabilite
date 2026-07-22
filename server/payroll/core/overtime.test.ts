import { describe, it, expect } from './testkit';
import { ventilateOvertime, hasTimeEntriesForMonth } from './overtime';
import { TimeEntry } from './types';

// Juin 2026 : 07 & 14 = dimanches ; 08→12 = Lun→Ven.
const TH = { weeklyNormalHours: 40, firstTierHours: 8 };

function te(date: string, heuresJour: number, heuresNuit = 0, ferie = false): TimeEntry {
  return { id: date, employeeId: 'e', date, heuresJour, heuresNuit, ferie, createdAt: '2026-06-01T00:00:00Z' };
}

describe('ventilateOvertime', () => {
  it('semaine à 45h de jour → 5h sup à 15%', () => {
    const entries = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12'].map((d) => te(d, 9));
    expect(ventilateOvertime(entries, 2026, 5, TH)).toEqual({ hs15: 5, hs50: 0, hs75: 0, hs100: 0 });
  });

  it('semaine à 50h → 8h à 15% + 2h à 50%', () => {
    const entries = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12'].map((d) => te(d, 10));
    expect(ventilateOvertime(entries, 2026, 5, TH)).toEqual({ hs15: 8, hs50: 2, hs75: 0, hs100: 0 });
  });

  it('heures de nuit en jour ouvrable → 75%', () => {
    expect(ventilateOvertime([te('2026-06-09', 0, 3)], 2026, 5, TH)).toEqual({ hs15: 0, hs50: 0, hs75: 3, hs100: 0 });
  });

  it('dimanche → 100% (jour + nuit)', () => {
    expect(ventilateOvertime([te('2026-06-07', 6, 2)], 2026, 5, TH)).toEqual({ hs15: 0, hs50: 0, hs75: 0, hs100: 8 });
  });

  it('jour férié → 100%', () => {
    expect(ventilateOvertime([te('2026-06-10', 8, 0, true)], 2026, 5, TH)).toEqual({ hs15: 0, hs50: 0, hs75: 0, hs100: 8 });
  });

  it('semaine à 40h pile → aucune heure sup', () => {
    const entries = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12'].map((d) => te(d, 8));
    expect(ventilateOvertime(entries, 2026, 5, TH)).toEqual({ hs15: 0, hs50: 0, hs75: 0, hs100: 0 });
  });

  it('ignore les entrées hors du mois', () => {
    expect(ventilateOvertime([te('2026-05-30', 20)], 2026, 5, TH).hs15).toBe(0);
  });
});

describe('hasTimeEntriesForMonth', () => {
  it('détecte la présence de pointage', () => {
    expect(hasTimeEntriesForMonth([te('2026-06-09', 8)], 2026, 5)).toBe(true);
    expect(hasTimeEntriesForMonth([te('2026-06-09', 8)], 2026, 4)).toBe(false);
  });
});
