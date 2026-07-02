import type { Client } from '../db.js';
import { postEntry, createJournal } from './accounting.js';

// ============================================================================
// Immobilisations & amortissements (SYSCOHADA — amortissement linéaire).
// Le registre des immos et le plan d'amortissement sont AUXILIAIRES (n'altèrent
// pas le ledger). Chaque dotation génère une écriture réelle 681 -> 28x, tracée
// dans fixed_asset_depreciations (une dotation au plus par immo et par exercice).
// ============================================================================

export interface CreateAssetInput {
  label: string;
  assetAccountCode: string;
  amortAccountCode?: string;
  expenseAccountCode?: string;
  acquisitionDate: string;      // 'YYYY-MM-DD'
  commissioningDate?: string;   // défaut = acquisitionDate
  amount: number;
  residualValue?: number;
  durationYears: number;
  counterpartyId?: string;
  notes?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Compte d'amortissement (28x) par défaut, dérivé du compte d'immobilisation.
export function deriveAmortAccount(assetCode: string): string {
  const c = assetCode.replace(/[^0-9]/g, '');
  if (c.startsWith('21')) return '281';
  if (c.startsWith('23')) return '283';
  if (c.startsWith('24')) return '284';
  if (c.startsWith('22')) return '282';
  // fallback générique : 28 + 2e chiffre
  return '28' + (c[1] ?? '4');
}

// Compte de dotation (68x) par défaut : incorporel (6812) vs corporel (6813).
export function deriveExpenseAccount(assetCode: string): string {
  const c = assetCode.replace(/[^0-9]/g, '');
  return c.startsWith('21') ? '6812' : '6813';
}

// --- Plan d'amortissement linéaire (prorata temporis, base commerciale 360j) --

export interface ScheduleRow {
  year: number; rate: number; dotation: number; cumul: number; vnc: number;
}

// Fraction du 1er exercice : jours restants de l'année (base 30j/mois, 360j/an).
function firstYearFraction(commissioning: string): number {
  const d = new Date(commissioning);
  const month = d.getUTCMonth() + 1;      // 1..12
  const day = Math.min(d.getUTCDate(), 30);
  const dayIndex = (month - 1) * 30 + day; // 1..360
  return Math.max(0, Math.min(1, (360 - dayIndex + 1) / 360));
}

export function computeSchedule(a: {
  amount: number; residualValue: number; durationYears: number; commissioningDate: string;
}): ScheduleRow[] {
  const base = round2(a.amount - a.residualValue);
  if (base <= 0 || a.durationYears <= 0) return [];
  const rate = round2(1 / a.durationYears * 100) / 100; // ex. 0.2 pour 5 ans
  const annual = base / a.durationYears;
  const startYear = new Date(a.commissioningDate).getUTCFullYear();

  const rows: ScheduleRow[] = [];
  let cumul = 0;
  let fraction = firstYearFraction(a.commissioningDate);
  let year = startYear;
  while (cumul < base - 0.005 && rows.length < 100) {
    let dot = round2(annual * fraction);
    if (cumul + dot > base) dot = round2(base - cumul); // dernier exercice : solde
    cumul = round2(cumul + dot);
    rows.push({ year, rate, dotation: dot, cumul, vnc: round2(a.amount - cumul) });
    year++;
    fraction = 1; // exercices pleins ensuite
  }
  return rows;
}

// --- CRUD immobilisations ----------------------------------------------------

async function assertAccountExists(c: Client, dossierId: string, code: string, kind: string) {
  const { rows } = await c.query('select 1 from accounts where dossier_id=$1 and account_code=$2', [dossierId, code]);
  if (!rows[0]) throw new Error(`Compte ${kind} ${code} introuvable dans le plan du dossier.`);
}

export async function createAsset(c: Client, dossierId: string, input: CreateAssetInput, userId?: string) {
  const amort = input.amortAccountCode || deriveAmortAccount(input.assetAccountCode);
  const expense = input.expenseAccountCode || deriveExpenseAccount(input.assetAccountCode);
  const commissioning = input.commissioningDate || input.acquisitionDate;
  if (!input.label?.trim()) throw new Error('Libellé requis.');
  if (!(input.amount > 0)) throw new Error('Valeur d\'origine invalide.');
  if (!(input.durationYears > 0)) throw new Error('Durée d\'utilité invalide.');
  await assertAccountExists(c, dossierId, input.assetAccountCode, 'immobilisation');
  await assertAccountExists(c, dossierId, amort, 'amortissement');
  await assertAccountExists(c, dossierId, expense, 'dotation');

  const { rows } = await c.query(
    `insert into fixed_assets(dossier_id, label, asset_account_code, amort_account_code, expense_account_code,
        acquisition_date, commissioning_date, amount, residual_value, duration_years, counterparty_id, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [dossierId, input.label.trim(), input.assetAccountCode, amort, expense,
     input.acquisitionDate, commissioning, input.amount, input.residualValue ?? 0, input.durationYears,
     input.counterpartyId ?? null, input.notes ?? null, userId ?? null],
  );
  return { id: rows[0].id };
}

export async function deleteAsset(c: Client, dossierId: string, id: string) {
  const { rows } = await c.query(
    'select count(*)::int n from fixed_asset_depreciations where dossier_id=$1 and fixed_asset_id=$2', [dossierId, id]);
  if (rows[0].n > 0) throw new Error('Immobilisation avec dotations déjà comptabilisées : contre-passez les dotations avant suppression.');
  await c.query('delete from fixed_assets where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Liste avec synthèse : valeur d'origine, amortissements comptabilisés, VNC, dotations en attente.
export async function listAssets(c: Client, dossierId: string) {
  const { rows: assets } = await c.query(
    `select fa.*, cp.name as counterparty_name
       from fixed_assets fa
       left join counterparties cp on cp.id = fa.counterparty_id
      where fa.dossier_id=$1 order by fa.acquisition_date, fa.label`, [dossierId]);
  const { rows: deps } = await c.query(
    'select fixed_asset_id, period_year, amount from fixed_asset_depreciations where dossier_id=$1', [dossierId]);
  const postedByAsset = new Map<string, Map<number, number>>();
  for (const d of deps) {
    if (!postedByAsset.has(d.fixed_asset_id)) postedByAsset.set(d.fixed_asset_id, new Map());
    postedByAsset.get(d.fixed_asset_id)!.set(Number(d.period_year), Number(d.amount));
  }
  const currentYear = new Date().getUTCFullYear();

  return assets.map((a: any) => {
    const amount = Number(a.amount), residual = Number(a.residual_value), duration = Number(a.duration_years);
    const schedule = computeSchedule({ amount, residualValue: residual, durationYears: duration, commissioningDate: a.commissioning_date });
    const posted = postedByAsset.get(a.id) ?? new Map<number, number>();
    const cumulPosted = round2([...posted.values()].reduce((s, v) => s + v, 0));
    // exercices échus (<= année courante) non encore comptabilisés
    const pendingYears = schedule.filter((r) => r.year <= currentYear && !posted.has(r.year)).map((r) => r.year);
    return {
      id: a.id, label: a.label,
      assetAccountCode: a.asset_account_code, amortAccountCode: a.amort_account_code, expenseAccountCode: a.expense_account_code,
      acquisitionDate: a.acquisition_date, commissioningDate: a.commissioning_date,
      amount, residualValue: residual, durationYears: duration, method: a.method,
      counterpartyName: a.counterparty_name, notes: a.notes, status: a.status,
      cumulPosted, vnc: round2(amount - cumulPosted),
      pendingYears, fullyAmortized: cumulPosted >= round2(amount - residual) - 0.005,
    };
  });
}

// Détail : plan d'amortissement avec l'état (comptabilisé / prévu) par exercice.
export async function assetDetail(c: Client, dossierId: string, id: string) {
  const { rows } = await c.query('select * from fixed_assets where dossier_id=$1 and id=$2', [dossierId, id]);
  const a = rows[0];
  if (!a) throw new Error('Immobilisation introuvable.');
  const { rows: deps } = await c.query(
    'select period_year, amount, entry_id from fixed_asset_depreciations where dossier_id=$1 and fixed_asset_id=$2', [dossierId, id]);
  const postedMap = new Map<number, { amount: number; entryId: string }>(
    deps.map((d: any) => [Number(d.period_year), { amount: Number(d.amount), entryId: d.entry_id }]));
  const schedule = computeSchedule({
    amount: Number(a.amount), residualValue: Number(a.residual_value),
    durationYears: Number(a.duration_years), commissioningDate: a.commissioning_date,
  }).map((r) => ({ ...r, posted: postedMap.has(r.year), entryId: postedMap.get(r.year)?.entryId ?? null }));

  return {
    id: a.id, label: a.label,
    assetAccountCode: a.asset_account_code, amortAccountCode: a.amort_account_code, expenseAccountCode: a.expense_account_code,
    acquisitionDate: a.acquisition_date, commissioningDate: a.commissioning_date,
    amount: Number(a.amount), residualValue: Number(a.residual_value), durationYears: Number(a.duration_years),
    method: a.method, notes: a.notes, status: a.status, schedule,
  };
}

// --- Comptabilisation des dotations -----------------------------------------

async function odJournalId(c: Client, dossierId: string): Promise<string> {
  const { rows } = await c.query("select id from journals where dossier_id=$1 and type='operations_diverses' limit 1", [dossierId]);
  return rows[0]?.id ?? await createJournal(c, dossierId, 'OD', 'Opérations diverses', 'operations_diverses');
}

async function fiscalYearForYear(c: Client, dossierId: string, year: number): Promise<string | null> {
  const { rows } = await c.query(
    'select id from fiscal_years where dossier_id=$1 and extract(year from start_date)=$2 limit 1', [dossierId, year]);
  return rows[0]?.id ?? null;
}

export async function postDepreciation(
  c: Client, dossierId: string, assetId: string, year: number,
): Promise<{ entryId: string; amount: number; year: number }> {
  const { rows } = await c.query('select * from fixed_assets where dossier_id=$1 and id=$2', [dossierId, assetId]);
  const a = rows[0];
  if (!a) throw new Error('Immobilisation introuvable.');

  const schedule = computeSchedule({
    amount: Number(a.amount), residualValue: Number(a.residual_value),
    durationYears: Number(a.duration_years), commissioningDate: a.commissioning_date,
  });
  const row = schedule.find((r) => r.year === year);
  if (!row) throw new Error(`Aucune dotation prévue pour l'exercice ${year}.`);

  const { rows: ex } = await c.query(
    'select 1 from fixed_asset_depreciations where dossier_id=$1 and fixed_asset_id=$2 and period_year=$3', [dossierId, assetId, year]);
  if (ex[0]) throw new Error(`Dotation ${year} déjà comptabilisée pour cette immobilisation.`);

  const fyId = await fiscalYearForYear(c, dossierId, year);
  if (!fyId) throw new Error(`Exercice ${year} introuvable — créez-le d'abord.`);

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fyId, journalId: await odJournalId(c, dossierId), entryDate: `${year}-12-31`,
    description: `Dotation amortissement ${year} — ${a.label}`, source: 'recurring',
    lines: [
      { accountCode: a.expense_account_code, debit: row.dotation, label: `Dotation ${a.label}` },
      { accountCode: a.amort_account_code, credit: row.dotation, label: `Amortissement ${a.label}` },
    ],
  });

  await c.query(
    `insert into fixed_asset_depreciations(dossier_id, fixed_asset_id, fiscal_year_id, period_year, amount, entry_id)
     values ($1,$2,$3,$4,$5,$6)`,
    [dossierId, assetId, fyId, year, row.dotation, entryId]);

  return { entryId, amount: row.dotation, year };
}

// Dotations en lot pour un exercice : toutes les immos actives dont l'exercice est
// prévu et non encore comptabilisé.
export async function postDepreciationForYear(
  c: Client, dossierId: string, year: number,
): Promise<{ count: number; total: number; skipped: number }> {
  const { rows: assets } = await c.query(
    "select id from fixed_assets where dossier_id=$1 and status='active'", [dossierId]);
  let count = 0, total = 0, skipped = 0;
  for (const a of assets) {
    try {
      const r = await postDepreciation(c, dossierId, a.id, year);
      count++; total = round2(total + r.amount);
    } catch { skipped++; }
  }
  return { count, total, skipped };
}
