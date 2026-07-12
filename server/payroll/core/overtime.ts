import { TimeEntry } from './types';

// Ventilation automatique des heures supplémentaires depuis le pointage, selon
// les règles CI (⚠️ seuils à ATTESTER, versionnés dans rules.ts) :
//   • dimanche / jour férié  → 100 %  (toutes les heures)
//   • nuit (jour ouvrable)   → 75 %
//   • jour ouvrable, au-delà de la durée hebdo normale (40 h) :
//        - les `firstTierHours` (8) premières heures sup de la semaine → 15 %
//        - au-delà → 50 %
// Partagé front (aperçu) et backend (calcul figé).

function parseYMD(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// Clé de la semaine (lundi) contenant la date — pour regrouper les heures sup.
function weekKey(d: Date): string {
  const day = d.getDay(); // 0 = dimanche … 6 = samedi
  const toMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + toMonday);
  return `${monday.getFullYear()}-${monday.getMonth()}-${monday.getDate()}`;
}

export interface OvertimeBuckets { hs15: number; hs50: number; hs75: number; hs100: number }

export function ventilateOvertime(
  entries: TimeEntry[],
  year: number,
  month: number,
  thresholds: { weeklyNormalHours: number; firstTierHours: number },
): OvertimeBuckets {
  let hs75 = 0;
  let hs100 = 0;
  const weekdayDayByWeek = new Map<string, number>();

  for (const e of entries) {
    const d = parseYMD(e.date);
    if (!d || d.getFullYear() !== year || d.getMonth() !== month) continue;
    const jour = Math.max(0, e.heuresJour || 0);
    const nuit = Math.max(0, e.heuresNuit || 0);
    const isSundayOrFerie = d.getDay() === 0 || e.ferie;

    if (isSundayOrFerie) {
      hs100 += jour + nuit;
    } else {
      hs75 += nuit; // heures de nuit en jour ouvrable
      const k = weekKey(d);
      weekdayDayByWeek.set(k, (weekdayDayByWeek.get(k) ?? 0) + jour);
    }
  }

  let hs15 = 0;
  let hs50 = 0;
  for (const total of weekdayDayByWeek.values()) {
    const overtime = Math.max(0, total - thresholds.weeklyNormalHours);
    hs15 += Math.min(overtime, thresholds.firstTierHours);
    hs50 += Math.max(0, overtime - thresholds.firstTierHours);
  }

  const r = (n: number) => Math.round(n * 100) / 100;
  return { hs15: r(hs15), hs50: r(hs50), hs75: r(hs75), hs100: r(hs100) };
}

// Y a-t-il du pointage pour ce salarié sur ce mois ? (→ HS dérivées, pas saisies)
export function hasTimeEntriesForMonth(entries: TimeEntry[], year: number, month: number): boolean {
  return entries.some((e) => {
    const d = parseYMD(e.date);
    return d && d.getFullYear() === year && d.getMonth() === month;
  });
}
