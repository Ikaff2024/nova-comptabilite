import type { Client } from '../db.js';
import { listEmployees, listAbsences, createAbsence } from './payroll.js';
import { recordAudit } from './audit.js';

// ============================================================================
// Congés : demande → validation → solde. La demande en attente n'impacte RIEN
// (ni paie, ni absentéisme) ; c'est l'APPROBATION qui crée l'absence, laquelle
// alimente ensuite la déduction de paie et la provision congés.
//
// Droit CI retenu : 2,2 jours ouvrables acquis par mois de service — la même
// base que la provision congés de l'analyse RH, pour rester cohérent.
// ============================================================================

const JOURS_PAR_MOIS = 2.2;
const num = (v: any) => Number(v) || 0;
const monthsBetween = (from: Date, to: Date) =>
  Math.max(0, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()));

export const TYPE_LABEL: Record<string, string> = {
  conges_payes: 'Congés payés', maladie: 'Maladie', sans_solde: 'Sans solde', autre: 'Autre',
};

export async function listRequests(c: Client, dossierId: string, statut?: string): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'r.dossier_id = $1';
  if (statut) { params.push(statut); where += ` and r.statut = $${params.length}`; }
  const { rows } = await c.query(
    `select r.id, r.employee_id, e.matricule, e.nom, e.prenoms, r.type, r.statut,
            to_char(r.date_debut,'YYYY-MM-DD') as date_debut,
            to_char(r.date_fin,'YYYY-MM-DD') as date_fin,
            r.jours, r.motif, r.note,
            to_char(r.created_at,'YYYY-MM-DD') as created_at,
            to_char(r.decided_at,'YYYY-MM-DD') as decided_at
       from payroll_leave_requests r
       join payroll_employees e on e.id = r.employee_id
      where ${where}
      order by (r.statut = 'en_attente') desc, r.date_debut desc`, params);
  return rows.map((r: any) => ({ ...r, jours: num(r.jours) }));
}

export async function createRequest(c: Client, dossierId: string, input: any, userId?: string): Promise<{ id: string }> {
  const debut = String(input?.dateDebut ?? '').slice(0, 10);
  const fin = String(input?.dateFin ?? '').slice(0, 10);
  if (!input?.employeeId) throw new Error('Salarié requis.');
  if (!debut || !fin) throw new Error('Dates de début et de fin requises.');
  if (fin < debut) throw new Error('La date de fin ne peut pas précéder la date de début.');
  const jours = num(input?.jours);
  if (jours <= 0) throw new Error('Nombre de jours requis.');
  const type = ['conges_payes', 'maladie', 'sans_solde', 'autre'].includes(input?.type) ? input.type : 'conges_payes';

  const { rows } = await c.query(
    `insert into payroll_leave_requests(dossier_id, employee_id, type, date_debut, date_fin, jours, motif, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [dossierId, input.employeeId, type, debut, fin, jours, input?.motif || null, userId ?? null]);
  return { id: rows[0].id };
}

// Approbation / refus. À l'approbation d'un congé, on crée l'absence
// correspondante : payée et justifiée pour des congés payés, non payée pour un
// congé sans solde (c'est ce couple qui pilote la déduction de paie).
export async function decideRequest(
  c: Client, dossierId: string, id: string, approve: boolean, note?: string, userId?: string,
): Promise<{ statut: string; absenceId?: string }> {
  const { rows } = await c.query(
    'select * from payroll_leave_requests where dossier_id=$1 and id=$2', [dossierId, id]);
  const r = rows[0];
  if (!r) throw new Error('Demande introuvable.');
  if (r.statut !== 'en_attente') throw new Error('Cette demande a déjà été traitée.');

  if (!approve) {
    await c.query("update payroll_leave_requests set statut='refuse', note=$3, decided_by=$4, decided_at=now() where dossier_id=$1 and id=$2",
      [dossierId, id, note ?? null, userId ?? null]);
    await recordAudit(c, { dossierId, action: 'leave.refused', entity: 'leave_request', entityId: id, detail: { note } });
    return { statut: 'refuse' };
  }

  const paye = r.type === 'conges_payes' || r.type === 'maladie';
  const abs = await createAbsence(c, dossierId, {
    employeeId: r.employee_id,
    dateDebut: String(r.date_debut).slice(0, 10),
    dateFin: String(r.date_fin).slice(0, 10),
    jours: num(r.jours),
    justifiee: true,
    paye,
    motif: TYPE_LABEL[r.type] ?? 'Congés',
  });
  await c.query("update payroll_leave_requests set statut='approuve', absence_id=$3, note=$4, decided_by=$5, decided_at=now() where dossier_id=$1 and id=$2",
    [dossierId, id, abs.id, note ?? null, userId ?? null]);
  await recordAudit(c, { dossierId, action: 'leave.approved', entity: 'leave_request', entityId: id, detail: { jours: num(r.jours), type: r.type } });
  return { statut: 'approuve', absenceId: abs.id };
}

export async function cancelRequest(c: Client, dossierId: string, id: string): Promise<void> {
  const { rows } = await c.query('select statut from payroll_leave_requests where dossier_id=$1 and id=$2', [dossierId, id]);
  if (!rows[0]) throw new Error('Demande introuvable.');
  if (rows[0].statut === 'approuve') throw new Error("Une demande approuvée ne s'annule pas ici : supprimez l'absence correspondante dans l'onglet Absences.");
  await c.query("update payroll_leave_requests set statut='annule' where dossier_id=$1 and id=$2", [dossierId, id]);
}

// Solde par salarié : acquis (ancienneté) − pris (absences de congés) − en attente.
export async function balances(c: Client, dossierId: string): Promise<any[]> {
  const emps = (await listEmployees(c, dossierId)).filter((e: any) => e.actif !== false);
  const absences = await listAbsences(c, dossierId);
  const { rows: pend } = await c.query(
    "select employee_id, coalesce(sum(jours),0) as j from payroll_leave_requests where dossier_id=$1 and statut='en_attente' and type='conges_payes' group by employee_id",
    [dossierId]);
  const enAttente = new Map<string, number>(pend.map((p: any) => [p.employee_id, num(p.j)]));

  // « Pris » = absences payées ET justifiées : même convention que la provision
  // congés de l'analyse RH (sinon les deux écrans se contrediraient).
  const pris = new Map<string, number>();
  for (const a of absences) {
    if (a.paye && a.justifiee) pris.set(a.employeeId, (pris.get(a.employeeId) ?? 0) + num(a.jours));
  }

  const today = new Date();
  return emps.map((e: any) => {
    const mois = e.dateEmbauche ? monthsBetween(new Date(`${e.dateEmbauche}T00:00:00Z`), today) : 0;
    const acquis = Math.round(mois * JOURS_PAR_MOIS * 10) / 10;
    const p = Math.round((pris.get(e.id) ?? 0) * 10) / 10;
    const a = Math.round((enAttente.get(e.id) ?? 0) * 10) / 10;
    return {
      employeeId: e.id, matricule: e.matricule, nom: `${e.nom} ${e.prenoms}`.trim(), poste: e.poste || '',
      acquis, pris: p, enAttente: a, solde: Math.round((acquis - p - a) * 10) / 10,
    };
  }).sort((x: any, y: any) => y.solde - x.solde);
}
