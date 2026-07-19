import type { Client } from '../db.js';
import { calculatePayroll, getMonthName, unpaidAbsenceDaysInMonth, advanceDeductionForMonth, advanceRemaining, resolveRuleSet, ventilateOvertime, computeSTC, referenceSalaryFromPayslips, type Employee, type MonthlyVariables, type Absence, type SalaryAdvance, type TimeEntry, type STCInput } from '../payroll/core/index.js';
import { postPayrollEntry } from '../payroll/bridge.js';
import { tablePdf, sectionsPdf, letterPdf } from '../documents/pdf.js';
import { renderPayslipPdf } from '../payroll/payslip-pdf.js';
import { isMonthClosed, monthLabel } from './closures.js';
import { sendEmail, emailEnabled } from '../email/provider.js';
import { toCsv } from '../documents/csv.js';

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

// Lignes DB -> types du moteur (camelCase).
function toAbsence(r: any): Absence {
  return { id: r.id, employeeId: r.employee_id, dateDebut: iso(r.date_debut), dateFin: iso(r.date_fin), jours: num(r.jours), justifiee: !!r.justifiee, paye: !!r.paye, motif: r.motif ?? undefined, createdAt: iso(r.created_at) };
}
function toAdvance(r: any): SalaryAdvance {
  return { id: r.id, employeeId: r.employee_id, type: r.type, montantTotal: num(r.montant_total), mensualite: num(r.mensualite), startYear: Number(r.start_year), startMonth: Number(r.start_month), motif: r.motif ?? undefined, createdAt: iso(r.created_at) };
}
function toTimeEntry(r: any): TimeEntry {
  return { id: r.id, employeeId: r.employee_id, date: iso(r.jour), heuresJour: num(r.heures_jour), heuresNuit: num(r.heures_nuit), ferie: !!r.ferie, createdAt: iso(r.created_at) };
}
async function tableExists(c: Client, name: string): Promise<boolean> {
  const { rows } = await c.query('select to_regclass($1) is not null as ok', [`public.${name}`]);
  return rows[0]?.ok === true;
}

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
  if (await isMonthClosed(c, dossierId, year, month)) throw new Error(`La période ${monthLabel(year, month + 1)} est clôturée : rouvrez-la (Clôtures) pour recalculer la paie.`);

  const { rows: emps } = await c.query('select * from payroll_employees where dossier_id=$1 and actif order by nom', [dossierId]);

  // Registres RH → variables dérivées du mois. Tolérant au schéma : si une table
  // n'est pas encore migrée, on n'échoue pas.
  const [hasAbs, hasAdv, hasTime] = await Promise.all([
    tableExists(c, 'payroll_absences'), tableExists(c, 'payroll_advances'), tableExists(c, 'payroll_time_entries'),
  ]);
  const { rows: absRows } = hasAbs ? await c.query('select * from payroll_absences where dossier_id=$1', [dossierId]) : { rows: [] as any[] };
  const { rows: advRows } = hasAdv ? await c.query('select * from payroll_advances where dossier_id=$1', [dossierId]) : { rows: [] as any[] };
  const { rows: timeRows } = hasTime ? await c.query('select * from payroll_time_entries where dossier_id=$1', [dossierId]) : { rows: [] as any[] };
  const absByEmp = new Map<string, Absence[]>();
  for (const r of absRows) { const a = toAbsence(r); (absByEmp.get(a.employeeId) ?? absByEmp.set(a.employeeId, []).get(a.employeeId)!).push(a); }
  const advByEmp = new Map<string, SalaryAdvance[]>();
  for (const r of advRows) { const a = toAdvance(r); (advByEmp.get(a.employeeId) ?? advByEmp.set(a.employeeId, []).get(a.employeeId)!).push(a); }
  const timeByEmp = new Map<string, TimeEntry[]>();
  for (const r of timeRows) { const t = toTimeEntry(r); (timeByEmp.get(t.employeeId) ?? timeByEmp.set(t.employeeId, []).get(t.employeeId)!).push(t); }
  const ruleSet = resolveRuleSet(year, month, 'CI');

  let totalBrut = 0, totalNet = 0, totalCout = 0, count = 0;
  for (const e of emps) {
    const ot = ventilateOvertime(timeByEmp.get(e.id) ?? [], year, month, ruleSet.overtimeThresholds);
    const derived: Partial<MonthlyVariables> = {
      joursAbsence: unpaidAbsenceDaysInMonth(absByEmp.get(e.id) ?? [], year, month),
      remboursementAvance: advanceDeductionForMonth(advByEmp.get(e.id) ?? [], year, month),
      heuresSup15: ot.hs15, heuresSup50: ot.hs50, heuresSup75: ot.hs75, heuresSup100: ot.hs100,
    };
    // Les variables manuelles éventuelles priment sur le dérivé.
    const v = zeroVars(e.id, year, month, { ...derived, ...(varsMap[e.id] ?? {}) });
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

// Vrai si les tables RH (absences/avances) sont présentes (migration 0046 appliquée).
async function rhTablesReady(c: Client): Promise<boolean> {
  const { rows } = await c.query("select to_regclass('public.payroll_absences') is not null and to_regclass('public.payroll_advances') is not null as ok");
  return rows[0]?.ok === true;
}

// --- Documents PDF (livre de paie) -----------------------------------------
const grp = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // séparateur milliers
export async function livrePaiePdf(c: Client, dossierId: string, year: number, month: number): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { rows: dr } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = dr[0]?.j ?? {};
  const cur = d.base_currency ?? 'XOF';
  const money = (n: number) => `${grp(n)} ${cur}`;
  const slips = await listPayslips(c, dossierId, year, month);
  const period = `${getMonthName(month)} ${year}`;

  const meta = [`Employeur : ${d.raison_sociale ?? '—'}`];
  if (d.tax_id) meta.push(`NCC/IFU : ${d.tax_id}${d.rccm ? ` · RCCM : ${d.rccm}` : ''}`);
  else if (d.rccm) meta.push(`RCCM : ${d.rccm}`);

  const rows = slips.map((p: any) => [p.matricule ?? '', `${p.nom} ${p.prenoms}`, money(p.brut), money(p.net), money(p.cout)]);
  const totals = ['', 'TOTAUX', money(slips.reduce((s: number, p: any) => s + p.brut, 0)), money(slips.reduce((s: number, p: any) => s + p.net, 0)), money(slips.reduce((s: number, p: any) => s + p.cout, 0))];

  const buffer = await tablePdf({
    title: 'Livre de paie',
    subtitle: `${d.raison_sociale ?? ''} · ${period}`,
    meta,
    columns: [
      { label: 'Matricule', width: 60 }, { label: 'Salarié', width: 140 },
      { label: 'Salaire brut', width: 80, align: 'right' }, { label: 'Net à payer', width: 80, align: 'right' }, { label: 'Coût employeur', width: 90, align: 'right' },
    ],
    rows, totals,
    footNote: `${slips.length} bulletin(s). Document généré par Lexa (Nova Comptabilité). Barèmes de paie sous réserve d'attestation.`,
  });
  return { filename: `livre-paie-${year}-${String(month + 1).padStart(2, '0')}.pdf`, buffer, count: slips.length };
}

// Ordre de virement des salaires : liste des bénéficiaires + coordonnées + net à payer.
export async function ordreVirementPdf(c: Client, dossierId: string, year: number, month: number): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, money, meta } = await employerMeta(c, dossierId);
  const period = `${getMonthName(month)} ${year}`;
  const { rows: rr } = await c.query(
    `select e.matricule, e.nom, e.prenoms, e.banque, e.rib, e.mode_paiement,
            e.mobile_money_numero, e.mobile_money_operateur, p.calculation
       from payroll_payslips p join payroll_employees e on e.id = p.employee_id
      where p.dossier_id = $1 and p.period_year = $2 and p.period_month = $3
      order by e.nom, e.prenoms`, [dossierId, year, month]);

  // Coordonnées de règlement affichées selon le mode de paiement.
  const coord = (r: any): string => {
    if (r.rib) return String(r.rib);
    if (r.mobile_money_numero) return `${r.mobile_money_operateur ? r.mobile_money_operateur + ' ' : ''}${r.mobile_money_numero}`;
    return '—';
  };
  const mode = (r: any): string => r.mode_paiement || (r.rib ? 'Virement' : r.mobile_money_numero ? 'Mobile Money' : '—');

  const rows = rr.map((r: any) => [
    `${r.nom} ${r.prenoms}`, r.banque || '—', coord(r), mode(r), money(num(r.calculation?.salaireNetPaye)),
  ]);
  const total = rr.reduce((s: number, r: any) => s + num(r.calculation?.salaireNetPaye), 0);

  // Le compte à débiter (employeur) si renseigné sur le dossier.
  const debit = [d.bank_name ? `Banque : ${d.bank_name}` : '', d.rib ? `Compte à débiter : ${d.rib}` : ''].filter(Boolean).join(' · ');
  const fullMeta = debit ? [...meta, debit] : meta;

  const buffer = await tablePdf({
    title: 'Ordre de virement des salaires',
    subtitle: `${d.raison_sociale ?? ''} · ${period}`,
    meta: fullMeta,
    columns: [
      { label: 'Bénéficiaire', width: 130 }, { label: 'Banque', width: 85 },
      { label: 'RIB / N° compte', width: 135 }, { label: 'Mode', width: 60 },
      { label: 'Net à payer', width: 85, align: 'right' },
    ],
    rows,
    totals: ['', '', '', 'TOTAL', money(total)],
    footNote: `${rr.length} bénéficiaire(s) · ${period}. Ordre de paiement des salaires à transmettre à la banque. Généré par Lexa (Nova Comptabilité) — à vérifier et signer avant exécution.`,
  });
  return { filename: `ordre-virement-salaires-${year}-${String(month + 1).padStart(2, '0')}.pdf`, buffer, count: rr.length };
}

const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const dateFr = (d = new Date()) => `${d.getUTCDate()} ${MOIS_FR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// Courrier en bonne et due forme adressé à la banque, demandant l'exécution des
// virements de salaires du mois. Reprend la liste des bénéficiaires en annexe.
export async function courrierVirementPdf(c: Client, dossierId: string, year: number, month: number): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, money } = await employerMeta(c, dossierId);
  const period = `${getMonthName(month)} ${year}`;
  const { rows: rr } = await c.query(
    `select e.nom, e.prenoms, e.banque, e.rib, e.mode_paiement, e.mobile_money_numero, e.mobile_money_operateur, p.calculation
       from payroll_payslips p join payroll_employees e on e.id = p.employee_id
      where p.dossier_id = $1 and p.period_year = $2 and p.period_month = $3
      order by e.nom, e.prenoms`, [dossierId, year, month]);

  const coord = (r: any): string => r.rib ? String(r.rib)
    : r.mobile_money_numero ? `${r.mobile_money_operateur ? r.mobile_money_operateur + ' ' : ''}${r.mobile_money_numero}` : '—';
  const total = rr.reduce((s: number, r: any) => s + num(r.calculation?.salaireNetPaye), 0);

  const sender = [d.raison_sociale ?? '—'];
  if (d.tax_id) sender.push(`NCC/IFU : ${d.tax_id}`);
  if (d.rccm) sender.push(`RCCM : ${d.rccm}`);

  const recipient = [d.bank_name ? `À l'attention de ${d.bank_name}` : "À l'attention de la Banque"];
  recipient.push('Service des virements');

  const cptDebit = d.rib ? `de notre compte n° ${d.rib}` : 'de notre compte';
  const bodyBefore = [
    'Madame, Monsieur,',
    `Par la présente, nous vous prions de bien vouloir procéder au virement des salaires de notre personnel au titre du mois de ${period}, pour un montant total de ${money(total)}, par le débit ${cptDebit} ouvert dans vos livres.`,
    'Les bénéficiaires ainsi que les montants correspondants sont détaillés dans le tableau ci-dessous :',
  ];
  const bodyAfter = [
    'Nous vous saurions gré de bien vouloir exécuter ces opérations dans les meilleurs délais et de nous en faire parvenir la confirmation.',
    'Nous vous prions d\'agréer, Madame, Monsieur, l\'expression de nos salutations distinguées.',
  ];

  const buffer = await letterPdf({
    sender, recipient, date: dateFr(), subject: `Ordre de virement des salaires — ${period}`,
    bodyBefore,
    table: {
      columns: [
        { label: 'Bénéficiaire', width: 150 }, { label: 'Banque', width: 90 },
        { label: 'RIB / N° compte', width: 150 }, { label: 'Montant', width: 90, align: 'right' },
      ],
      rows: rr.map((r: any) => [`${r.nom} ${r.prenoms}`, r.banque || '—', coord(r), money(num(r.calculation?.salaireNetPaye))]),
      totals: ['', '', 'TOTAL', money(total)],
    },
    bodyAfter,
    signature: ['Pour ' + (d.raison_sociale ?? "l'entreprise"), 'La Direction', '', '(signature et cachet)'],
    footNote: `Document généré par Lexa (Nova Comptabilité) le ${dateFr()} — à vérifier et signer avant transmission à la banque.`,
  });
  return { filename: `courrier-virement-salaires-${year}-${String(month + 1).padStart(2, '0')}.pdf`, buffer, count: rr.length };
}

// Date longue en français à partir d'un ISO 'yyyy-mm-dd' (ou Date).
const dateLongFr = (v: any): string => { const s = iso(v); const [y, m, d] = s.split('-').map(Number); return y && m && d ? `${d} ${MOIS_FR[m - 1]} ${y}` : s; };

// Attestations RH (portées d'Ivoire Paie) : attestation de travail et
// attestation de salaire. Résout le salarié par matricule ou par nom.
export async function attestationPdf(
  c: Client, dossierId: string, who: string, kind: 'travail' | 'salaire',
): Promise<{ filename: string; buffer: Buffer; found: boolean; candidates?: string[] }> {
  const { d, money } = await employerMeta(c, dossierId);
  const emps = await listEmployees(c, dossierId);
  const q = String(who ?? '').trim().toLowerCase();
  const e: any = emps.find((x: any) => String(x.matricule ?? '').toLowerCase() === q)
    ?? emps.find((x: any) => `${x.nom} ${x.prenoms}`.toLowerCase().includes(q))
    ?? emps.find((x: any) => `${x.prenoms} ${x.nom}`.toLowerCase().includes(q));
  if (!e) return { filename: '', buffer: Buffer.alloc(0), found: false, candidates: emps.map((x: any) => `${x.matricule} ${x.nom} ${x.prenoms}`) };

  const civ = e.civilite || (String(e.statutMatrimonial ?? '').toLowerCase().includes('mari') ? '' : '');
  const nomComplet = `${e.prenoms} ${e.nom}`.trim();
  const contrat = e.typeContrat ? String(e.typeContrat).toUpperCase() : 'contrat de travail';
  const embauche = e.dateEmbauche ? dateLongFr(e.dateEmbauche) : '—';

  const sender = [d.raison_sociale ?? '—'];
  if (d.tax_id) sender.push(`NCC/IFU : ${d.tax_id}`);
  if (d.rccm) sender.push(`RCCM : ${d.rccm}`);
  if (d.adresse) sender.push(String(d.adresse));

  const identite = `${civ ? civ + ' ' : ''}${nomComplet}${e.matricule ? `, matricule ${e.matricule},` : ','} ${e.poste ? `exerçant les fonctions de ${e.poste}` : 'salarié(e)'}${e.categorie ? `, catégorie ${e.categorie}` : ''}`;
  const bodyBefore: string[] = [
    `Je soussigné(e), représentant légal de la société ${d.raison_sociale ?? "l'entreprise"}${d.rccm ? ` (RCCM ${d.rccm})` : ''}, atteste par la présente que :`,
    `${identite},`,
    `est employé(e) au sein de notre entreprise depuis le ${embauche}, dans le cadre d'un ${contrat}.`,
  ];

  if (kind === 'salaire') {
    const { rows: pr } = await c.query(
      `select period_year, period_month, calculation from payroll_payslips
        where dossier_id=$1 and employee_id=$2 order by period_year desc, period_month desc limit 1`,
      [dossierId, e.id]);
    const last = pr[0];
    if (last) {
      const brut = num(last.calculation?.salaireBrutTotal);
      const net = num(last.calculation?.salaireNetPaye);
      const periode = `${getMonthName(last.period_month)} ${last.period_year}`;
      bodyBefore.push(`À ce titre, ${civ ? civ + ' ' : ''}${e.nom} perçoit une rémunération brute mensuelle de ${money(brut)}, soit un salaire net mensuel de ${money(net)} (dernier bulletin établi : ${periode}).`);
    } else {
      const brut = num(e.salaireBase) + num(e.sursalaire) + num(e.indemniteLogement) + num(e.autresPrimes);
      bodyBefore.push(`À ce titre, ${civ ? civ + ' ' : ''}${e.nom} perçoit une rémunération brute mensuelle contractuelle de ${money(brut)}. (Aucun bulletin n'ayant encore été établi, ce montant est celui prévu au contrat.)`);
    }
  }

  const bodyAfter = ['La présente attestation est délivrée à l\'intéressé(e) pour servir et valoir ce que de droit.'];
  const titre = kind === 'salaire' ? 'ATTESTATION DE SALAIRE' : 'ATTESTATION DE TRAVAIL';

  const buffer = await letterPdf({
    sender, recipient: [], place: d.ville || undefined, date: dateFr(), subject: titre,
    bodyBefore, bodyAfter,
    signature: ['Pour ' + (d.raison_sociale ?? "l'entreprise"), 'La Direction', '', '(signature et cachet)'],
    footNote: `Document généré par Lexa (Nova Comptabilité) le ${dateFr()} — à vérifier et signer.`,
  });
  const slug = `${kind}-${(e.matricule || nomComplet).toString().replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  return { filename: `attestation-${slug}.pdf`, buffer, found: true };
}

// Fichier de virement des salaires (CSV importable en banque / tableur).
export async function payrollTransferCsv(c: Client, dossierId: string, year: number, month: number): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d } = await employerMeta(c, dossierId);
  const cur = d.base_currency ?? 'XOF';
  const period = `${getMonthName(month)} ${year}`;
  const { rows } = await c.query(
    `select e.matricule, e.nom, e.prenoms, e.banque, e.rib, e.mode_paiement, e.mobile_money_numero, e.mobile_money_operateur, p.calculation
       from payroll_payslips p join payroll_employees e on e.id=p.employee_id
      where p.dossier_id=$1 and p.period_year=$2 and p.period_month=$3 order by e.nom, e.prenoms`, [dossierId, year, month]);
  const coord = (r: any): string => r.rib ? String(r.rib)
    : r.mobile_money_numero ? `${r.mobile_money_operateur ? r.mobile_money_operateur + ' ' : ''}${r.mobile_money_numero}` : '';
  const out: (string | number)[][] = [['Matricule', 'Bénéficiaire', 'Banque', 'RIB / N° compte', 'Mode', 'Montant', 'Devise', 'Motif']];
  for (const r of rows) out.push([r.matricule ?? '', `${r.nom} ${r.prenoms}`, r.banque || '', coord(r), r.mode_paiement || '', num(r.calculation?.salaireNetPaye), cur, `Salaire ${period}`]);
  const total = rows.reduce((s: number, r: any) => s + num(r.calculation?.salaireNetPaye), 0);
  out.push(['', 'TOTAL', '', '', '', total, cur, '']);
  return { filename: `virement-salaires-${year}-${String(month + 1).padStart(2, '0')}.csv`, buffer: toCsv(out), count: rows.length };
}

async function employerMeta(c: Client, dossierId: string): Promise<{ d: any; cur: string; money: (n: number) => string; meta: string[] }> {
  const { rows: dr } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = dr[0]?.j ?? {};
  const cur = d.base_currency ?? 'XOF';
  const money = (n: number) => `${grp(n)} ${cur}`;
  const meta = [`Employeur : ${d.raison_sociale ?? '—'}`];
  if (d.tax_id) meta.push(`NCC/IFU : ${d.tax_id}${d.rccm ? ` · RCCM : ${d.rccm}` : ''}`);
  else if (d.rccm) meta.push(`RCCM : ${d.rccm}`);
  return { d, cur, money, meta };
}

const cnpsPatronal = (c: any) => num(c.cnpsFamille) + num(c.cnpsAccident) + num(c.cnpsRetraitePatronal);

// Déclaration mensuelle CNPS ou DGI (impôts sur salaires) en PDF.
export async function declarationPdf(c: Client, dossierId: string, year: number, month: number, kind: 'cnps' | 'dgi'): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, money, meta } = await employerMeta(c, dossierId);
  const slips = await listPayslips(c, dossierId, year, month);
  const period = `${getMonthName(month)} ${year}`;
  const sum = (f: (x: any) => number) => slips.reduce((s: number, p: any) => s + f(p.calculation), 0);

  let title: string, columns: any[], rows: string[][], totals: string[];
  if (kind === 'cnps') {
    title = 'Bordereau CNPS';
    columns = [{ label: 'Mat.', width: 55 }, { label: 'Salarié', width: 150 }, { label: 'Brut', width: 85, align: 'right' }, { label: 'CNPS salarial', width: 90, align: 'right' }, { label: 'CNPS patronal', width: 90, align: 'right' }, { label: 'Total', width: 90, align: 'right' }];
    rows = slips.map((p: any) => { const x = p.calculation; return [p.matricule ?? '', `${p.nom} ${p.prenoms}`, money(x.salaireBrutTotal), money(x.cnpsSalarial), money(cnpsPatronal(x)), money(num(x.cnpsSalarial) + cnpsPatronal(x))]; });
    totals = ['', 'TOTAUX', money(sum((x) => x.salaireBrutTotal)), money(sum((x) => x.cnpsSalarial)), money(sum(cnpsPatronal)), money(sum((x) => num(x.cnpsSalarial) + cnpsPatronal(x)))];
  } else {
    title = 'Déclaration des impôts sur salaires (DGI)';
    columns = [{ label: 'Mat.', width: 50 }, { label: 'Salarié', width: 130 }, { label: 'Brut impos.', width: 78, align: 'right' }, { label: 'ITS', width: 62, align: 'right' }, { label: 'CN', width: 55, align: 'right' }, { label: 'IGR', width: 62, align: 'right' }, { label: 'CMU', width: 55, align: 'right' }];
    rows = slips.map((p: any) => { const x = p.calculation; return [p.matricule ?? '', `${p.nom} ${p.prenoms}`, money(x.salaireBrutImposable), money(x.itsSalarial), money(x.cnSalarial), money(x.igrSalarial), money(x.cmuSalarial)]; });
    totals = ['', 'TOTAUX', money(sum((x) => x.salaireBrutImposable)), money(sum((x) => x.itsSalarial)), money(sum((x) => x.cnSalarial)), money(sum((x) => x.igrSalarial)), money(sum((x) => x.cmuSalarial))];
  }

  const buffer = await tablePdf({ title, subtitle: `${d.raison_sociale ?? ''} · ${period}`, meta, columns, rows, totals, footNote: `${slips.length} salarié(s). Document généré par Nova. Barèmes sous réserve d'attestation.` });
  return { filename: `declaration-${kind}-${year}-${String(month + 1).padStart(2, '0')}.pdf`, buffer, count: slips.length };
}

// Bulletin de paie individuel en PDF. `who` = matricule ou nom (partiel).
export async function bulletinPdf(c: Client, dossierId: string, who: string, year: number, month: number): Promise<{ filename: string; buffer: Buffer; found: boolean; candidates?: string[] }> {
  const { d, money, meta } = await employerMeta(c, dossierId);
  const slips = await listPayslips(c, dossierId, year, month);
  const q = String(who ?? '').trim().toLowerCase();
  const p: any = slips.find((s: any) => String(s.matricule ?? '').toLowerCase() === q) ?? slips.find((s: any) => `${s.nom} ${s.prenoms}`.toLowerCase().includes(q));
  if (!p) return { filename: '', buffer: Buffer.alloc(0), found: false, candidates: slips.map((s: any) => `${s.matricule} ${s.nom} ${s.prenoms}`) };
  // Récupère les variables du mois + la fiche complète du salarié (le calcul est
  // déjà figé dans p.calculation) pour reproduire le bulletin modèle Ivoire Paie.
  const { rows: er } = await c.query(
    `select p.variables, e.* from payroll_payslips p
       join payroll_employees e on e.id = p.employee_id
      where p.dossier_id=$1 and p.employee_id=$2 and p.period_year=$3 and p.period_month=$4 limit 1`,
    [dossierId, p.employeeId, year, month]);
  const emp = toEmployee(er[0] ?? {});
  const variables: MonthlyVariables = { employeeId: p.employeeId, year, month, heuresSup15: 0, heuresSup50: 0, heuresSup75: 0, heuresSup100: 0, joursAbsence: 0, primesExceptionnelles: 0, retenuesDiverses: 0, acompte: 0, ...(er[0]?.variables ?? {}) };

  // Ancienneté (années) à la fin de la période.
  const periodEnd = new Date(Date.UTC(year, month + 1, 0));
  const embauche = new Date(emp.dateEmbauche || periodEnd);
  const tenureYears = Math.max(0, (periodEnd.getTime() - embauche.getTime()) / (365.25 * 24 * 3600 * 1000));
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const now = new Date();

  const bytes = await renderPayslipPdf({
    employer: {
      name: d.raison_sociale ?? '—',
      adresse: [d.adresse, d.ville].filter(Boolean).join(', ') || undefined,
      telephone: d.telephone ?? undefined,
      numeroCnps: d.numero_cnps ?? undefined,
      numeroCc: d.tax_id ?? undefined,
    },
    employee: {
      matricule: emp.matricule, nom: emp.nom, prenoms: emp.prenoms, poste: emp.poste, categorie: String(emp.categorie ?? ''),
      dateEmbauche: emp.dateEmbauche, statutMatrimonial: String(emp.statutMatrimonial ?? ''),
      nombrePartsIGR: emp.nombrePartsIGR, nombreEnfants: emp.nombreEnfants,
      salaireBase: emp.salaireBase, sursalaire: emp.sursalaire, indemniteLogement: emp.indemniteLogement, autresPrimes: emp.autresPrimes,
    },
    period: { month, year },
    numBulletin: `${emp.matricule}/${year}${pad2(month + 1)}`,
    dateEdition: `${pad2(now.getUTCDate())}/${pad2(now.getUTCMonth() + 1)}/${now.getUTCFullYear()}`,
    tenureYears,
    variables,
    calc: p.calculation,
  });
  return { filename: `bulletin-${p.matricule}-${year}-${pad2(month + 1)}.pdf`, buffer: Buffer.from(bytes), found: true };
}

// --- Déclarations annuelles (DISA CNPS, récap impôts) ----------------------
export async function payrollYear(c: Client, dossierId: string, year: number): Promise<any> {
  const { rows: dr } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = dr[0]?.j ?? {};
  const employer = { raisonSociale: d.raison_sociale ?? '—', taxId: d.tax_id ?? null, rccm: d.rccm ?? null, country: d.country ?? 'CI' };

  const { rows } = await c.query(
    `select p.employee_id, e.matricule, e.nom, e.prenoms, p.calculation
       from payroll_payslips p join payroll_employees e on e.id=p.employee_id
      where p.dossier_id=$1 and p.period_year=$2
      order by e.nom, e.prenoms`, [dossierId, year]);

  const byEmp = new Map<string, any>();
  const cnpsPat = (c: any) => num(c.cnpsFamille) + num(c.cnpsAccident) + num(c.cnpsRetraitePatronal);
  for (const r of rows) {
    const c = r.calculation ?? {};
    let a = byEmp.get(r.employee_id);
    if (!a) { a = { employeeId: r.employee_id, matricule: r.matricule, nom: r.nom, prenoms: r.prenoms, mois: 0, brut: 0, brutImposable: 0, cnpsSalarial: 0, cnpsPatronal: 0, its: 0, cn: 0, igr: 0, cmu: 0, net: 0 }; byEmp.set(r.employee_id, a); }
    a.mois += 1;
    a.brut += num(c.salaireBrutTotal); a.brutImposable += num(c.salaireBrutImposable);
    a.cnpsSalarial += num(c.cnpsSalarial); a.cnpsPatronal += cnpsPat(c);
    a.its += num(c.itsSalarial); a.cn += num(c.cnSalarial); a.igr += num(c.igrSalarial); a.cmu += num(c.cmuSalarial);
    a.net += num(c.salaireNetPaye);
  }
  const annual = [...byEmp.values()].map((a) => { for (const k of Object.keys(a)) if (typeof a[k] === 'number' && k !== 'mois') a[k] = Math.round(a[k]); return a; });
  const sum = (k: string) => annual.reduce((s, a) => s + (a[k] || 0), 0);
  const totals = { brut: sum('brut'), brutImposable: sum('brutImposable'), cnpsSalarial: sum('cnpsSalarial'), cnpsPatronal: sum('cnpsPatronal'), its: sum('its'), cn: sum('cn'), igr: sum('igr'), cmu: sum('cmu'), net: sum('net') };
  return { employer, year, annual, totals };
}

// État 301 — état nominatif annuel des salaires (récapitulatif DGI de fin
// d'exercice : par salarié, cumuls brut / imposable / retenues / net). Porté
// d'Ivoire Paie. Document paysage.
export async function etatAnnuelSalairesPdf(c: Client, dossierId: string, year: number): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const { d, money, meta } = await employerMeta(c, dossierId);
  const data = await payrollYear(c, dossierId, year);
  const a: any[] = data.annual ?? [];
  const t: any = data.totals ?? {};
  const columns: any[] = [
    { label: 'Mat.', width: 46 }, { label: 'Nom & prénoms', width: 132 }, { label: 'Mois', width: 34, align: 'right' },
    { label: 'Brut', width: 78, align: 'right' }, { label: 'Brut impos.', width: 78, align: 'right' },
    { label: 'CNPS sal.', width: 66, align: 'right' }, { label: 'ITS', width: 60, align: 'right' },
    { label: 'CN', width: 52, align: 'right' }, { label: 'IGR', width: 60, align: 'right' },
    { label: 'CMU', width: 50, align: 'right' }, { label: 'Net payé', width: 82, align: 'right' },
  ];
  const rows = a.map((x) => [x.matricule ?? '', `${x.nom} ${x.prenoms}`, String(x.mois ?? 0), money(x.brut), money(x.brutImposable), money(x.cnpsSalarial), money(x.its), money(x.cn), money(x.igr), money(x.cmu), money(x.net)]);
  const totals = ['', 'TOTAUX', '', money(t.brut), money(t.brutImposable), money(t.cnpsSalarial), money(t.its), money(t.cn), money(t.igr), money(t.cmu), money(t.net)];
  const buffer = await tablePdf({
    title: `État 301 — État nominatif annuel des salaires ${year}`,
    subtitle: `${d.raison_sociale ?? ''} · Exercice ${year}`,
    meta, landscape: true, columns, rows, totals,
    footNote: `${a.length} salarié(s). Récapitulatif des salaires et retenues (ITS, CN, IGR, CMU, CNPS) versés sur l'exercice ${year}. Document généré par Nova — à vérifier avant dépôt à la DGI.`,
  });
  return { filename: `etat-301-salaires-${year}.pdf`, buffer, count: a.length };
}

// Distribution des bulletins : envoie à chaque salarié (qui a un email en fiche)
// son bulletin de paie du mois en pièce jointe PDF. Renvoie le détail envoyés /
// ignorés (sans email). Porté de la logique RH d'Ivoire Paie.
export async function distributePayslips(c: Client, dossierId: string, year: number, month: number): Promise<{
  enabled: boolean; period: string; sent: { nom: string; email: string }[]; skipped: { nom: string; raison: string }[];
}> {
  const period = `${getMonthName(month)} ${year}`;
  if (!emailEnabled()) return { enabled: false, period, sent: [], skipped: [] };
  const { d } = await employerMeta(c, dossierId);
  const slips = await listPayslips(c, dossierId, year, month);
  if (slips.length === 0) throw new Error(`Aucun bulletin pour ${period} : lancez d'abord la paie.`);
  const { rows: emps } = await c.query('select id, matricule, nom, prenoms, email from payroll_employees where dossier_id=$1', [dossierId]);
  const byId = new Map<string, any>(emps.map((e: any) => [e.id, e]));

  const sent: { nom: string; email: string }[] = [];
  const skipped: { nom: string; raison: string }[] = [];
  for (const p of slips) {
    const e = byId.get(p.employeeId);
    const nom = `${p.nom} ${p.prenoms}`.trim();
    const email = String(e?.email ?? '').trim();
    if (!email || !email.includes('@')) { skipped.push({ nom, raison: "pas d'email en fiche" }); continue; }
    const pdf = await bulletinPdf(c, dossierId, p.matricule || nom, year, month);
    if (!pdf.found) { skipped.push({ nom, raison: 'bulletin introuvable' }); continue; }
    const html = `<p>Bonjour ${p.prenoms},</p>
      <p>Veuillez trouver ci-joint votre bulletin de paie du mois de <strong>${period}</strong>.</p>
      <p>Cordialement,<br/>${(d.raison_sociale ?? 'La Direction')}</p>
      <p style="color:#888;font-size:12px">Envoyé automatiquement via Nova.</p>`;
    try {
      await sendEmail({ to: email, subject: `Votre bulletin de paie — ${period}`, html, attachments: [{ filename: pdf.filename, content: pdf.buffer.toString('base64') }] });
      sent.push({ nom, email });
    } catch { skipped.push({ nom, raison: "échec de l'envoi" }); }
  }
  return { enabled: true, period, sent, skipped };
}

// --- Registre des absences -------------------------------------------------
export async function listAbsences(c: Client, dossierId: string): Promise<any[]> {
  if (!(await rhTablesReady(c))) return [];
  const { rows } = await c.query(
    `select a.*, e.nom, e.prenoms, e.matricule from payroll_absences a
       join payroll_employees e on e.id=a.employee_id
      where a.dossier_id=$1 order by a.date_debut desc`, [dossierId]);
  return rows.map((r: any) => ({
    id: r.id, employeeId: r.employee_id, nom: r.nom, prenoms: r.prenoms, matricule: r.matricule,
    dateDebut: iso(r.date_debut), dateFin: iso(r.date_fin), jours: num(r.jours), justifiee: !!r.justifiee, paye: !!r.paye, motif: r.motif ?? null,
  }));
}
export async function createAbsence(c: Client, dossierId: string, input: any): Promise<{ id: string }> {
  const d0 = String(input.dateDebut ?? '');
  const y = Number(d0.slice(0, 4)), m0 = Number(d0.slice(5, 7)) - 1;
  if (y && m0 >= 0 && await isMonthClosed(c, dossierId, y, m0)) throw new Error(`La période ${monthLabel(y, m0 + 1)} est clôturée : impossible d'enregistrer une absence sur ce mois.`);
  const { rows } = await c.query(
    `insert into payroll_absences(dossier_id, employee_id, date_debut, date_fin, jours, justifiee, paye, motif)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [dossierId, input.employeeId, input.dateDebut, input.dateFin, num(input.jours), !!input.justifiee, !!input.paye, input.motif || null]);
  return { id: rows[0].id };
}
export async function deleteAbsence(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from payroll_absences where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Avances & prêts sur salaire -------------------------------------------
export async function listAdvances(c: Client, dossierId: string): Promise<any[]> {
  if (!(await rhTablesReady(c))) return [];
  const now = new Date();
  const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  const { rows } = await c.query(
    `select a.*, e.nom, e.prenoms, e.matricule from payroll_advances a
       join payroll_employees e on e.id=a.employee_id
      where a.dossier_id=$1 order by a.created_at desc`, [dossierId]);
  return rows.map((r: any) => {
    const adv = toAdvance(r);
    return {
      id: r.id, employeeId: r.employee_id, nom: r.nom, prenoms: r.prenoms, matricule: r.matricule,
      type: adv.type, montantTotal: adv.montantTotal, mensualite: adv.mensualite,
      startYear: adv.startYear, startMonth: adv.startMonth, motif: adv.motif ?? null,
      restant: Math.round(advanceRemaining(adv, y, m)), // restant dû au mois courant
    };
  });
}
export async function createAdvance(c: Client, dossierId: string, input: any): Promise<{ id: string }> {
  const { rows } = await c.query(
    `insert into payroll_advances(dossier_id, employee_id, type, montant_total, mensualite, start_year, start_month, motif)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [dossierId, input.employeeId, input.type === 'pret' ? 'pret' : 'avance', num(input.montantTotal), num(input.mensualite), Number(input.startYear), Number(input.startMonth), input.motif || null]);
  return { id: rows[0].id };
}
export async function deleteAdvance(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from payroll_advances where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Pointage (heures) ------------------------------------------------------
export async function listTimeEntries(c: Client, dossierId: string): Promise<any[]> {
  if (!(await tableExists(c, 'payroll_time_entries'))) return [];
  const { rows } = await c.query(
    `select t.*, e.nom, e.prenoms, e.matricule from payroll_time_entries t
       join payroll_employees e on e.id=t.employee_id
      where t.dossier_id=$1 order by t.jour desc`, [dossierId]);
  return rows.map((r: any) => ({
    id: r.id, employeeId: r.employee_id, nom: r.nom, prenoms: r.prenoms, matricule: r.matricule,
    jour: iso(r.jour), heuresJour: num(r.heures_jour), heuresNuit: num(r.heures_nuit), ferie: !!r.ferie,
  }));
}
export async function createTimeEntry(c: Client, dossierId: string, input: any): Promise<{ id: string }> {
  const { rows } = await c.query(
    `insert into payroll_time_entries(dossier_id, employee_id, jour, heures_jour, heures_nuit, ferie)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [dossierId, input.employeeId, input.jour, num(input.heuresJour), num(input.heuresNuit), !!input.ferie]);
  return { id: rows[0].id };
}
export async function deleteTimeEntry(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from payroll_time_entries where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Solde de tout compte (STC) — calcul à la demande ----------------------
export async function runSTC(c: Client, dossierId: string, input: any): Promise<any> {
  const { rows } = await c.query('select * from payroll_employees where dossier_id=$1 and id=$2', [dossierId, input.employeeId]);
  const e = rows[0];
  if (!e) throw new Error('Salarié introuvable.');
  const monthlySalary = num(e.salaire_base) + num(e.sursalaire);
  const embauche = new Date(iso(e.date_embauche)); const rupture = new Date(input.ruptureDate);
  const tenureYears = Math.max(0, (rupture.getTime() - embauche.getTime()) / (365.25 * 24 * 3600 * 1000));

  // Salaire de référence : moyenne des 12 derniers bulletins, à défaut le salaire courant.
  const { rows: ps } = await c.query('select period_year, period_month, calculation from payroll_payslips where dossier_id=$1 and employee_id=$2', [dossierId, input.employeeId]);
  const saved = ps.map((r: any) => ({ employeeId: input.employeeId, year: r.period_year, month: r.period_month, variables: {}, calculation: r.calculation, createdAt: '' }));
  const refHist = referenceSalaryFromPayslips(saved as any, input.employeeId, 12);
  const referenceSalary = refHist > 0 ? refHist : monthlySalary;

  const stcInput: STCInput = {
    ruptureType: input.ruptureType, ruptureDate: input.ruptureDate, tenureYears, referenceSalary, monthlySalary,
    joursCongesNonPris: num(input.joursCongesNonPris), preavisEffectue: !!input.preavisEffectue, categorie: e.categorie,
    cddTotalGross: input.cddTotalGross != null ? num(input.cddTotalGross) : undefined,
    salaireMoisDu: input.salaireMoisDu != null ? num(input.salaireMoisDu) : undefined,
  };
  const result = computeSTC(stcInput);
  return { ...result, tenureYears: Math.round(tenureYears * 10) / 10, referenceSalary, employee: { nom: e.nom, prenoms: e.prenoms, matricule: e.matricule, categorie: e.categorie } };
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
