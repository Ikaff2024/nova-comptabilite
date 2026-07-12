import type { Client } from '../db.js';
import { calculatePayroll, getMonthName, type Employee, type MonthlyVariables } from '../payroll/core/index.js';
import { postPayrollEntry } from '../payroll/bridge.js';

// ============================================================================
// Paie : salariés + bulletins, branchés sur le moteur porté (payroll/core).
// « Lancer la paie » calcule et stocke les bulletins d'une période ; la
// comptabilisation génère l'OD de paie (pont) et la rattache aux bulletins.
// ============================================================================

const num = (v: any) => (v == null ? 0 : Number(v));

// Ligne DB -> Employee attendu par le moteur (camelCase).
function toEmployee(r: any): Employee {
  return {
    id: r.id, matricule: r.matricule, nom: r.nom, prenoms: r.prenoms,
    dateNaissance: iso(r.date_naissance), dateEmbauche: iso(r.date_embauche), poste: r.poste ?? '',
    categorie: r.categorie, statutMatrimonial: r.statut_matrimonial,
    nombreEnfants: num(r.nombre_enfants), nombrePartsIGR: num(r.nombre_parts_igr),
    salaireBase: num(r.salaire_base), sursalaire: num(r.sursalaire),
    indemniteTransport: num(r.indemnite_transport), indemniteLogement: num(r.indemnite_logement),
    autresPrimes: num(r.autres_primes), email: r.email ?? undefined, telephone: r.telephone ?? undefined,
    typeContrat: r.type_contrat ?? undefined, dateFinContrat: r.date_fin_contrat ? iso(r.date_fin_contrat) : undefined,
    conventionCollective: r.convention_collective ?? undefined, modePaiement: r.mode_paiement ?? undefined,
    rib: r.rib ?? undefined, banque: r.banque ?? undefined,
    mobileMoneyNumero: r.mobile_money_numero ?? undefined, mobileMoneyOperateur: r.mobile_money_operateur ?? undefined,
  };
}
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

const COLS = ['matricule', 'nom', 'prenoms', 'date_naissance', 'date_embauche', 'poste', 'categorie', 'statut_matrimonial',
  'nombre_enfants', 'nombre_parts_igr', 'salaire_base', 'sursalaire', 'indemnite_transport', 'indemnite_logement',
  'autres_primes', 'email', 'telephone', 'type_contrat', 'date_fin_contrat', 'convention_collective', 'mode_paiement',
  'rib', 'banque', 'mobile_money_numero', 'mobile_money_operateur', 'actif'];
const CAMEL: Record<string, string> = {
  matricule: 'matricule', nom: 'nom', prenoms: 'prenoms', date_naissance: 'dateNaissance', date_embauche: 'dateEmbauche',
  poste: 'poste', categorie: 'categorie', statut_matrimonial: 'statutMatrimonial', nombre_enfants: 'nombreEnfants',
  nombre_parts_igr: 'nombrePartsIGR', salaire_base: 'salaireBase', sursalaire: 'sursalaire',
  indemnite_transport: 'indemniteTransport', indemnite_logement: 'indemniteLogement', autres_primes: 'autresPrimes',
  email: 'email', telephone: 'telephone', type_contrat: 'typeContrat', date_fin_contrat: 'dateFinContrat',
  convention_collective: 'conventionCollective', mode_paiement: 'modePaiement', rib: 'rib', banque: 'banque',
  mobile_money_numero: 'mobileMoneyNumero', mobile_money_operateur: 'mobileMoneyOperateur', actif: 'actif',
};

export async function listEmployees(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query('select * from payroll_employees where dossier_id=$1 order by nom, prenoms', [dossierId]);
  return rows.map((r) => ({ ...toEmployee(r), actif: r.actif }));
}

export async function createEmployee(c: Client, dossierId: string, input: any): Promise<{ id: string }> {
  if (!input?.matricule?.trim() || !input?.nom?.trim() || !input?.prenoms?.trim()) throw new Error('Matricule, nom et prénoms requis.');
  if (!input?.dateEmbauche) throw new Error("Date d'embauche requise.");
  // N'insère que les colonnes fournies : les défauts DB s'appliquent au reste.
  const cols = COLS.filter((col) => input[CAMEL[col]] !== undefined && input[CAMEL[col]] !== null);
  const vals = cols.map((col) => input[CAMEL[col]]);
  const ph = cols.map((_, i) => `$${i + 2}`).join(',');
  try {
    const { rows } = await c.query(`insert into payroll_employees(dossier_id, ${cols.join(',')}) values ($1, ${ph}) returning id`, [dossierId, ...vals]);
    return { id: rows[0].id };
  } catch (e: any) {
    if (e.code === '23505') throw new Error('Un salarié avec ce matricule existe déjà.');
    throw e;
  }
}

export async function updateEmployee(c: Client, dossierId: string, id: string, input: any): Promise<void> {
  const set = COLS.filter((col) => input[CAMEL[col]] !== undefined);
  if (set.length === 0) return;
  const clause = set.map((col, i) => `${col}=$${i + 3}`).join(', ');
  const vals = set.map((col) => input[CAMEL[col]]);
  await c.query(`update payroll_employees set ${clause} where dossier_id=$1 and id=$2`, [dossierId, id, ...vals]);
}

export async function deleteEmployee(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from payroll_employees where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Variables mensuelles par défaut (tout à zéro).
function zeroVars(employeeId: string, year: number, month: number, over: Partial<MonthlyVariables> = {}): MonthlyVariables {
  return { employeeId, year, month, heuresSup15: 0, heuresSup50: 0, heuresSup75: 0, heuresSup100: 0, joursAbsence: 0, primesExceptionnelles: 0, retenuesDiverses: 0, acompte: 0, ...over };
}

// Lance la paie d'une période : calcule et stocke un bulletin par salarié actif.
export async function runPayroll(
  c: Client, dossierId: string, year: number, month: number, varsMap: Record<string, Partial<MonthlyVariables>> = {},
): Promise<{ count: number; totalBrut: number; totalNet: number; totalCoutEmployeur: number }> {
  const { rows: posted } = await c.query(
    'select 1 from payroll_payslips where dossier_id=$1 and period_year=$2 and period_month=$3 and entry_id is not null limit 1', [dossierId, year, month]);
  if (posted[0]) throw new Error('Paie déjà comptabilisée pour cette période : contre-passez l\'écriture avant de recalculer.');

  const { rows: emps } = await c.query('select * from payroll_employees where dossier_id=$1 and actif order by nom', [dossierId]);
  let totalBrut = 0, totalNet = 0, totalCout = 0, count = 0;
  for (const e of emps) {
    const v = zeroVars(e.id, year, month, varsMap[e.id] ?? {});
    const calc = calculatePayroll(toEmployee(e), v, 'CI');
    await c.query(
      `insert into payroll_payslips(dossier_id, employee_id, period_year, period_month, variables, calculation)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (dossier_id, employee_id, period_year, period_month)
       do update set variables=$5, calculation=$6, entry_id=null, created_at=now()`,
      [dossierId, e.id, year, month, JSON.stringify(v), JSON.stringify(calc)]);
    totalBrut += calc.salaireBrutTotal; totalNet += calc.salaireNetPaye; totalCout += calc.totalCoutEmployeur; count++;
  }
  return { count, totalBrut: Math.round(totalBrut), totalNet: Math.round(totalNet), totalCoutEmployeur: Math.round(totalCout) };
}

export async function listPayslips(c: Client, dossierId: string, year: number, month: number): Promise<any[]> {
  const { rows } = await c.query(
    `select p.id, p.employee_id, e.matricule, e.nom, e.prenoms, p.calculation, p.entry_id
       from payroll_payslips p join payroll_employees e on e.id=p.employee_id
      where p.dossier_id=$1 and p.period_year=$2 and p.period_month=$3
      order by e.nom, e.prenoms`, [dossierId, year, month]);
  return rows.map((r: any) => ({
    id: r.id, employeeId: r.employee_id, matricule: r.matricule, nom: r.nom, prenoms: r.prenoms,
    brut: r.calculation.salaireBrutTotal, net: r.calculation.salaireNetPaye, cout: r.calculation.totalCoutEmployeur,
    calculation: r.calculation, comptabilise: !!r.entry_id, entryId: r.entry_id,
  }));
}

// Comptabilise l'OD de paie de la période (une seule fois).
export async function postPayroll(
  c: Client, dossierId: string, year: number, month: number, entryDate?: string,
): Promise<{ entryId: string; totalBrut: number; totalNet: number; totalCoutEmployeur: number }> {
  const { rows } = await c.query(
    'select calculation, entry_id from payroll_payslips where dossier_id=$1 and period_year=$2 and period_month=$3', [dossierId, year, month]);
  if (!rows.length) throw new Error('Aucun bulletin pour cette période. Lancez la paie d\'abord.');
  if (rows.some((r: any) => r.entry_id)) throw new Error('Paie déjà comptabilisée pour cette période.');

  const date = entryDate || new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10); // fin de mois
  const periodLabel = `${getMonthName(month)} ${year}`;
  const res = await postPayrollEntry(c, dossierId, { entryDate: date, periodLabel, results: rows.map((r: any) => r.calculation) });
  await c.query('update payroll_payslips set entry_id=$4 where dossier_id=$1 and period_year=$2 and period_month=$3', [dossierId, year, month, res.entryId]);
  return res;
}
