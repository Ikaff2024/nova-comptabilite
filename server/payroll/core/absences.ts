import { Absence } from './types';

// Analyse des absences → nombre de jours d'absence NON payée par mois de paie.
// Partagé front (aperçu) ET backend (calcul figé) : une seule règle, zéro
// divergence. Le résultat pilote la déduction au prorata du bulletin.

// Parse une date 'YYYY-MM-DD' en Date LOCALE (évite le décalage UTC/local qui
// fausserait le jour de la semaine près de minuit).
function parseYMD(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Jours ouvrables (dimanche exclu, semaine de 6 jours — standard CI) d'une plage
 * [dateDebut, dateFin] qui tombent dans le mois (year, month 0-11).
 * L'intersection avec le mois gère proprement les absences à cheval sur deux mois.
 */
export function workingDaysInMonth(
  dateDebut: string,
  dateFin: string,
  year: number,
  month: number,
): number {
  const start = parseYMD(dateDebut);
  const end = parseYMD(dateFin);
  if (!start || !end || start > end) return 0;

  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0); // dernier jour du mois
  const from = start > monthStart ? start : monthStart;
  const to = end < monthEnd ? end : monthEnd;
  if (from > to) return 0;

  let count = 0;
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cur <= to) {
    if (cur.getDay() !== 0) count++; // 0 = dimanche
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Somme des jours d'absence NON payée d'un salarié tombant dans le mois donné.
 * Les absences payées (paye = true) sont ignorées : elles n'entament pas le salaire.
 */
export function unpaidAbsenceDaysInMonth(
  absences: Absence[],
  year: number,
  month: number,
): number {
  let total = 0;
  for (const a of absences) {
    if (a.paye) continue;
    total += workingDaysInMonth(a.dateDebut, a.dateFin, year, month);
  }
  return total;
}
