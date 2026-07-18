import type { Client } from '../db.js';
import { recordAudit } from './audit.js';
import { tableExists } from '../schema-cache.js';

// ============================================================================
// Clôtures mensuelles. Clôturer un mois verrouille toute écriture datée de ce
// mois ou d'un mois antérieur (contrôle appliqué dans postEntry). On ne peut
// rouvrir que le dernier mois clôturé (la borne recule d'un cran).
// ============================================================================

const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const monthLabel = (year: number, month: number) => `${MOIS_FR[month - 1] ?? month} ${year}`;

// Renvoie true si la date (YYYY-MM-DD) tombe dans une période clôturée.
export async function isDateClosed(c: Client, dossierId: string, date: string): Promise<boolean> {
  if (!(await tableExists('period_closures'))) return false;
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7));
  if (!y || !m) return false;
  const { rows } = await c.query(
    'select 1 from period_closures where dossier_id=$1 and (year*12 + month) >= ($2*12 + $3) limit 1',
    [dossierId, y, m]);
  return !!rows[0];
}

// Vrai si le mois (month0 = 0-11) est clôturé (ou couvert par une clôture
// postérieure). Pratique pour la paie et les registres RH indexés par mois.
export async function isMonthClosed(c: Client, dossierId: string, year: number, month0: number): Promise<boolean> {
  return isDateClosed(c, dossierId, `${year}-${String(month0 + 1).padStart(2, '0')}-15`);
}

// Liste des mois clôturés (récents d'abord) + la borne « clôturé jusqu'à ».
export async function listClosures(c: Client, dossierId: string): Promise<{ closures: any[]; closedThrough: { year: number; month: number; label: string } | null }> {
  if (!(await tableExists('period_closures'))) return { closures: [], closedThrough: null };
  const { rows } = await c.query(
    `select year, month, to_char(closed_at,'YYYY-MM-DD') as closed_at
       from period_closures where dossier_id=$1 order by year desc, month desc`, [dossierId]);
  const closures = rows.map((r: any) => ({ year: r.year, month: r.month, label: monthLabel(r.year, r.month), closed_at: r.closed_at }));
  return { closures, closedThrough: closures[0] ? { year: closures[0].year, month: closures[0].month, label: closures[0].label } : null };
}

// Clôture un mois. Refuse de « sauter » : le mois clôturé doit être postérieur
// à la borne actuelle (on ne reclôture pas un mois déjà couvert).
export async function closePeriod(c: Client, dossierId: string, year: number, month: number, userId?: string): Promise<void> {
  if (!(await tableExists('period_closures'))) throw new Error('Les clôtures mensuelles ne sont pas encore disponibles (mise à jour de la base requise).');
  if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) throw new Error('Période invalide.');
  const { rows: mx } = await c.query('select max(year*12 + month) as b from period_closures where dossier_id=$1', [dossierId]);
  const boundary = mx[0]?.b ? Number(mx[0].b) : 0;
  if (year * 12 + month <= boundary) throw new Error(`La période ${monthLabel(year, month)} est déjà couverte par la clôture en cours.`);
  await c.query('insert into period_closures(dossier_id, year, month, closed_by) values ($1,$2,$3,$4) on conflict (dossier_id, year, month) do nothing', [dossierId, year, month, userId ?? null]);
  await recordAudit(c, { dossierId, action: 'period.closed', entity: 'period_closure', entityId: `${year}-${month}`, detail: { year, month } });
}

// Rouvre un mois. On ne peut rouvrir que le DERNIER mois clôturé (la borne).
export async function reopenPeriod(c: Client, dossierId: string, year: number, month: number): Promise<void> {
  if (!(await tableExists('period_closures'))) throw new Error('Aucune période clôturée.');
  const { rows: mx } = await c.query('select year, month from period_closures where dossier_id=$1 order by year desc, month desc limit 1', [dossierId]);
  if (!mx[0]) throw new Error('Aucune période clôturée.');
  if (Number(mx[0].year) !== Number(year) || Number(mx[0].month) !== Number(month)) {
    throw new Error(`On ne peut rouvrir que le dernier mois clôturé (${monthLabel(mx[0].year, mx[0].month)}).`);
  }
  await c.query('delete from period_closures where dossier_id=$1 and year=$2 and month=$3', [dossierId, year, month]);
  await recordAudit(c, { dossierId, action: 'period.reopened', entity: 'period_closure', entityId: `${year}-${month}`, detail: { year, month } });
}
