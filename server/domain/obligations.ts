import type { Client } from '../db.js';

// ============================================================================
// Échéancier des obligations déclaratives. La prochaine échéance est calculée à
// partir de la périodicité, du jour (et du mois pour l'annuel).
// ============================================================================

type Periodicity = 'monthly' | 'quarterly' | 'annual';

function clampDay(year: number, monthIndex: number, day: number): Date {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, last)));
}

function nextDue(periodicity: Periodicity, dueDay: number, dueMonth: number | null, today: Date): string {
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  const at0 = new Date(Date.UTC(y, m, today.getUTCDate()));
  if (periodicity === 'monthly') {
    let d = clampDay(y, m, dueDay);
    if (d < at0) d = clampDay(y, m + 1, dueDay);
    return d.toISOString().slice(0, 10);
  }
  if (periodicity === 'quarterly') {
    const months = [0, 3, 6, 9]; // jan, avr, juil, oct
    for (let i = 0; i < 8; i++) {
      const mi = months[i % 4] + (i >= 4 ? 12 : 0);
      const d = clampDay(y, mi, dueDay);
      if (d >= at0) return d.toISOString().slice(0, 10);
    }
  }
  // annual
  const mo = (dueMonth ?? 1) - 1;
  let d = clampDay(y, mo, dueDay);
  if (d < at0) d = clampDay(y + 1, mo, dueDay);
  return d.toISOString().slice(0, 10);
}

export async function listObligations(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    'select id, label, periodicity, due_day, due_month, active from obligations where dossier_id=$1 order by active desc, label', [dossierId]);
  const today = new Date();
  return rows.map((r: any) => {
    const due = r.active ? nextDue(r.periodicity, r.due_day, r.due_month, today) : null;
    const daysLeft = due ? Math.round((new Date(due).getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000) : null;
    return { id: r.id, label: r.label, periodicity: r.periodicity, dueDay: r.due_day, dueMonth: r.due_month, active: r.active, nextDue: due, daysLeft };
  }).sort((a: any, b: any) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
}

export async function createObligation(c: Client, dossierId: string, input: { label: string; periodicity: Periodicity; dueDay: number; dueMonth?: number | null }): Promise<{ id: string }> {
  if (!input.label?.trim()) throw new Error('Libellé requis.');
  const { rows } = await c.query(
    'insert into obligations(dossier_id, label, periodicity, due_day, due_month) values ($1,$2,$3,$4,$5) returning id',
    [dossierId, input.label.trim(), input.periodicity, input.dueDay || 15, input.periodicity === 'annual' ? (input.dueMonth ?? 1) : null]);
  return { id: rows[0].id };
}

export async function deleteObligation(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from obligations where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Modèle Côte d'Ivoire : obligations courantes (à ajuster selon le régime).
const CI_DEFAULTS: { label: string; periodicity: Periodicity; dueDay: number; dueMonth?: number }[] = [
  { label: 'Déclaration TVA', periodicity: 'monthly', dueDay: 15 },
  { label: 'Impôt sur les traitements et salaires (ITS)', periodicity: 'monthly', dueDay: 15 },
  { label: 'Cotisations CNPS', periodicity: 'monthly', dueDay: 15 },
  { label: 'Acompte IS / BIC', periodicity: 'quarterly', dueDay: 20 },
  { label: 'Patente', periodicity: 'annual', dueDay: 15, dueMonth: 3 },
  { label: 'DSF (États financiers annuels)', periodicity: 'annual', dueDay: 30, dueMonth: 6 },
];

export async function seedDefaults(c: Client, dossierId: string): Promise<{ added: number }> {
  const { rows: ex } = await c.query('select count(*)::int n from obligations where dossier_id=$1', [dossierId]);
  if (ex[0].n > 0) return { added: 0 };
  for (const o of CI_DEFAULTS) {
    await c.query('insert into obligations(dossier_id, label, periodicity, due_day, due_month) values ($1,$2,$3,$4,$5)',
      [dossierId, o.label, o.periodicity, o.dueDay, o.dueMonth ?? null]);
  }
  return { added: CI_DEFAULTS.length };
}
