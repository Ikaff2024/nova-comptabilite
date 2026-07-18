import type { Client } from '../db.js';
import { listEmployees, listPayslips, listAbsences } from './payroll.js';

// ============================================================================
// Analyse RH — tableau de bord de pilotage social (effectif, masse salariale,
// taux de charges, absentéisme, provision congés payés, pyramide d'ancienneté).
// Porté du module Ivoire Paie, calculé à partir des données paie de Nova.
// ============================================================================

const num = (v: any) => Number(v) || 0;
const cnpsPatronal = (c: any) => num(c?.cnpsFamille) + num(c?.cnpsAccident) + num(c?.cnpsRetraitePatronal);
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const yearsBetween = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / (365.25 * 86400000));
const monthsBetween = (from: Date, to: Date) => Math.max(0, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()));

// Jours d'absence tombant dans le mois (approx. par la date de début).
function absenceDaysInMonth(absences: any[], year: number, month0: number, onlyEmp?: string): number {
  let total = 0;
  for (const a of absences) {
    if (onlyEmp && a.employeeId !== onlyEmp) continue;
    const d = new Date(a.dateDebut + 'T00:00:00Z');
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month0) total += num(a.jours);
  }
  return total;
}

export async function rhAnalysis(c: Client, dossierId: string, year: number, month0: number): Promise<any> {
  const { rows: dr } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
  const devise = dr[0]?.base_currency ?? 'XOF';

  const emps = (await listEmployees(c, dossierId)).filter((e: any) => e.actif !== false);
  const slips = await listPayslips(c, dossierId, year, month0);
  const prevM = month0 === 0 ? 11 : month0 - 1, prevY = month0 === 0 ? year - 1 : year;
  const slipsPrev = await listPayslips(c, dossierId, prevY, prevM);
  const absences = await listAbsences(c, dossierId);

  const periodEnd = new Date(Date.UTC(year, month0 + 1, 0));
  const effectif = emps.length;

  const anc = emps.map((e: any) => yearsBetween(new Date((e.dateEmbauche || `${year}-01-01`) + 'T00:00:00Z'), periodEnd));
  const ancienneteMoy = anc.length ? anc.reduce((s, x) => s + x, 0) / anc.length : 0;

  const brutList = slips.map((s: any) => num(s.calculation?.salaireBrutTotal)).filter((x) => x > 0);
  const masse = brutList.reduce((s, x) => s + x, 0);
  const brutMoyen = brutList.length ? masse / brutList.length : 0;
  const brutMedian = median(brutList);
  const cnpsPat = slips.reduce((s: number, p: any) => s + cnpsPatronal(p.calculation), 0);
  const tauxCharges = masse ? cnpsPat / masse : 0;
  const massePrev = slipsPrev.reduce((s: number, p: any) => s + num(p.calculation?.salaireBrutTotal), 0);
  const variationMasse = massePrev ? (masse - massePrev) / massePrev : null;

  // Absentéisme : jours d'absence du mois / (effectif × 26 jours ouvrables).
  const joursAbs = absenceDaysInMonth(absences, year, month0);
  const joursTheoriques = effectif * 26;
  const absenteisme = joursTheoriques ? joursAbs / joursTheoriques : 0;

  // Provision congés payés (estimation) : droit CI ≈ 2,2 jours ouvrables acquis
  // par mois de service, moins les congés payés déjà pris (absences payées &
  // justifiées, proxy), valorisés à brut mensuel de référence / 26.
  const brutByEmp = new Map<string, number>();
  for (const s of slips) brutByEmp.set(s.employeeId, num(s.calculation?.salaireBrutTotal));
  const congesPrisByEmp = new Map<string, number>();
  for (const a of absences) if (a.paye && a.justifiee) congesPrisByEmp.set(a.employeeId, (congesPrisByEmp.get(a.employeeId) ?? 0) + num(a.jours));

  const provision = emps.map((e: any) => {
    const mois = monthsBetween(new Date((e.dateEmbauche || `${year}-01-01`) + 'T00:00:00Z'), periodEnd);
    const acquis = mois * 2.2;
    const restants = Math.max(0, acquis - (congesPrisByEmp.get(e.id) ?? 0));
    const brutRef = brutByEmp.get(e.id) || (num(e.salaireBase) + num(e.sursalaire));
    return { nom: `${e.nom} ${e.prenoms}`, poste: e.poste || '', joursRestants: Math.round(restants * 10) / 10, provision: Math.round(restants * (brutRef / 26)) };
  }).sort((a: any, b: any) => b.provision - a.provision);
  const provisionTotale = provision.reduce((s: number, p: any) => s + p.provision, 0);

  // Pyramide d'ancienneté.
  const tranches = [
    { label: '< 1 an', min: 0, max: 1 }, { label: '1 à 3 ans', min: 1, max: 3 },
    { label: '3 à 5 ans', min: 3, max: 5 }, { label: '5 à 10 ans', min: 5, max: 10 }, { label: '10 ans et +', min: 10, max: 1e9 },
  ];
  const pyramide = tranches.map((t) => ({ label: t.label, count: anc.filter((a) => a >= t.min && a < t.max).length }));

  return {
    periode: { year, month: month0 + 1 }, devise, effectif,
    ancienneteMoy: Math.round(ancienneteMoy * 10) / 10,
    brutMedian, brutMoyen: Math.round(brutMoyen), masse, variationMasse, tauxCharges,
    absenteisme, joursAbs, joursTheoriques,
    provisionTotale, provision, pyramide,
    bulletins: slips.length,
  };
}
