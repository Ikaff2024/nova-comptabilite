import type { Client } from '../db.js';
import { postEntry, createJournal } from './accounting.js';

// ============================================================================
// Immobilisations & amortissements (SYSCOHADA — linéaire, prorata temporis).
// Cadence 'annual' (par exercice) ou 'monthly' (clôtures mensuelles). Le registre
// est AUXILIAIRE ; chaque dotation génère une écriture réelle 681 -> 28x, tracée
// dans fixed_asset_depreciations par DATE de période (une dotation au plus).
// ============================================================================

export type DepreciationPeriod = 'annual' | 'monthly';
export type DepreciationMethod = 'linear' | 'degressive';

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
  depreciationPeriod?: DepreciationPeriod;
  depreciationMethod?: DepreciationMethod;
  counterpartyId?: string;
  notes?: string;
  // Reprise d'antériorité : cumul déjà amorti avant la bascule + date de reprise.
  repriseCumul?: number;
  repriseDate?: string;
}

// Coefficient dégressif selon la durée d'utilité (usage OHADA courant).
function degressiveCoef(duration: number): number {
  if (duration <= 4) return 1.5;
  if (duration <= 6) return 2;
  return 2.5;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

// Compte d'amortissement (28x) par défaut, dérivé du compte d'immobilisation.
export function deriveAmortAccount(assetCode: string): string {
  const c = assetCode.replace(/[^0-9]/g, '');
  if (c.startsWith('21')) return '281';
  if (c.startsWith('23')) return '283';
  if (c.startsWith('24')) return '284';
  if (c.startsWith('22')) return '282';
  return '28' + (c[1] ?? '4');
}

// Compte de dotation (68x) par défaut : incorporel (6812) vs corporel (6813).
export function deriveExpenseAccount(assetCode: string): string {
  const c = assetCode.replace(/[^0-9]/g, '');
  return c.startsWith('21') ? '6812' : '6813';
}

// --- Plan d'amortissement linéaire (prorata temporis, base commerciale 30/360) --

export interface ScheduleRow {
  periodDate: string;  // fin de période (YYYY-MM-DD) = clé de suivi
  label: string;       // '2026' (annuel) ou '2026-07' (mensuel)
  rate: number;
  dotation: number;
  cumul: number;
  vnc: number;
}

// Fraction de la 1re période depuis la mise en service (base 30j/mois, 360j/an).
function firstFraction(commissioning: string, period: DepreciationPeriod): number {
  const d = new Date(commissioning);
  const day = Math.min(d.getUTCDate(), 30);
  if (period === 'monthly') return Math.max(0, Math.min(1, (30 - day + 1) / 30));
  const month = d.getUTCMonth() + 1;
  const dayIndex = (month - 1) * 30 + day;               // 1..360
  return Math.max(0, Math.min(1, (360 - dayIndex + 1) / 360));
}

export function computeSchedule(a: {
  amount: number; residualValue: number; durationYears: number; commissioningDate: string;
  depreciationPeriod?: DepreciationPeriod; depreciationMethod?: DepreciationMethod;
  repriseCumul?: number; repriseDate?: string;
}): ScheduleRow[] {
  const base = round2(a.amount - a.residualValue);
  if (base <= 0 || a.durationYears <= 0) return [];

  // --- Reprise d'antériorité : n'amortit que le FUTUR, à partir du cumul repris.
  // Les dotations passées ont déjà été pratiquées (cumul repris via l'à-nouveau) ;
  // on répartit le reliquat (base - cumul repris) linéairement sur les périodes
  // postérieures à la date de reprise, sans re-comptabiliser le passé.
  if (a.repriseCumul && a.repriseCumul > 0 && a.repriseDate) {
    const period: DepreciationPeriod = a.depreciationPeriod === 'monthly' ? 'monthly' : 'annual';
    const perStep = period === 'monthly' ? base / (a.durationYears * 12) : base / a.durationYears;
    const rate = round2(1 / a.durationYears * 100) / 100;
    const rows: ScheduleRow[] = [];
    let cumul = round2(Math.min(a.repriseCumul, base));
    const rd = new Date(a.repriseDate);
    let year = rd.getUTCFullYear();
    let mi = rd.getUTCMonth();
    // Positionne sur la 1re période dont la fin est STRICTEMENT après la date de reprise.
    if (period === 'annual') {
      if (a.repriseDate >= `${year}-12-31`) year++;
    } else {
      if (a.repriseDate >= `${year}-${pad2(mi + 1)}-${pad2(lastDay(year, mi))}`) { mi++; if (mi > 11) { mi = 0; year++; } }
    }
    const maxRows = period === 'monthly' ? 1000 : 100;
    while (cumul < base - 0.005 && rows.length < maxRows) {
      let dot = round2(perStep);
      if (cumul + dot > base) dot = round2(base - cumul);
      cumul = round2(cumul + dot);
      if (period === 'monthly') {
        rows.push({ periodDate: `${year}-${pad2(mi + 1)}-${pad2(lastDay(year, mi))}`, label: `${year}-${pad2(mi + 1)}`, rate, dotation: dot, cumul, vnc: round2(a.amount - cumul) });
        mi++; if (mi > 11) { mi = 0; year++; }
      } else {
        rows.push({ periodDate: `${year}-12-31`, label: String(year), rate, dotation: dot, cumul, vnc: round2(a.amount - cumul) });
        year++;
      }
    }
    return rows;
  }

  // --- Dégressif (annuel) : taux dégressif, bascule en linéaire quand avantageux ---
  if (a.depreciationMethod === 'degressive') {
    const dRate = round2(degressiveCoef(a.durationYears) / a.durationYears * 100) / 100;
    const startYear = new Date(a.commissioningDate).getUTCFullYear();
    const rows: ScheduleRow[] = [];
    let cumul = 0, year = startYear, yearsLeft = a.durationYears;
    let fraction = firstFraction(a.commissioningDate, 'annual');
    let switched = false;
    while (cumul < base - 0.005 && rows.length < 100) {
      const remaining = base - cumul;
      const linRate = 1 / Math.max(yearsLeft, 0.0001);
      if (!switched && linRate >= dRate) switched = true;
      const rate = switched ? linRate : dRate;
      let dot = round2(remaining * rate * fraction);
      if (cumul + dot > base) dot = round2(base - cumul);
      cumul = round2(cumul + dot);
      rows.push({ periodDate: `${year}-12-31`, label: String(year), rate: switched ? round2(linRate * 100) / 100 : dRate, dotation: dot, cumul, vnc: round2(a.amount - cumul) });
      year++; yearsLeft -= fraction; fraction = 1;
    }
    return rows;
  }

  const period: DepreciationPeriod = a.depreciationPeriod === 'monthly' ? 'monthly' : 'annual';
  const rate = round2(1 / a.durationYears * 100) / 100;   // taux annuel (ex. 0.2)
  const perStep = period === 'monthly' ? base / (a.durationYears * 12) : base / a.durationYears;

  const start = new Date(a.commissioningDate);
  let year = start.getUTCFullYear();
  let mi = start.getUTCMonth();                            // 0..11 (pour le mensuel)

  const rows: ScheduleRow[] = [];
  let cumul = 0;
  let fraction = firstFraction(a.commissioningDate, period);
  const maxRows = period === 'monthly' ? 1000 : 100;
  while (cumul < base - 0.005 && rows.length < maxRows) {
    let dot = round2(perStep * fraction);
    if (cumul + dot > base) dot = round2(base - cumul);   // dernière période : solde
    cumul = round2(cumul + dot);
    if (period === 'monthly') {
      rows.push({ periodDate: `${year}-${pad2(mi + 1)}-${pad2(lastDay(year, mi))}`, label: `${year}-${pad2(mi + 1)}`, rate, dotation: dot, cumul, vnc: round2(a.amount - cumul) });
      mi++; if (mi > 11) { mi = 0; year++; }
    } else {
      rows.push({ periodDate: `${year}-12-31`, label: String(year), rate, dotation: dot, cumul, vnc: round2(a.amount - cumul) });
      year++;
    }
    fraction = 1;
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
  const period: DepreciationPeriod = input.depreciationPeriod === 'monthly' ? 'monthly' : 'annual';
  if (!input.label?.trim()) throw new Error('Libellé requis.');
  if (!(input.amount > 0)) throw new Error('Valeur d\'origine invalide.');
  if (!(input.durationYears > 0)) throw new Error('Durée d\'utilité invalide.');
  await assertAccountExists(c, dossierId, input.assetAccountCode, 'immobilisation');
  await assertAccountExists(c, dossierId, amort, 'amortissement');
  await assertAccountExists(c, dossierId, expense, 'dotation');

  const method: DepreciationMethod = input.depreciationMethod === 'degressive' ? 'degressive' : 'linear';
  const base = round2(input.amount - (input.residualValue ?? 0));
  const repriseCumul = round2(Math.max(0, input.repriseCumul ?? 0));
  if (repriseCumul > 0 && !input.repriseDate) throw new Error('Date de reprise requise lorsqu\'un cumul amorti est indiqué.');
  if (repriseCumul > base + 0.01) throw new Error(`Cumul amorti repris (${repriseCumul}) supérieur à la base amortissable (${base}).`);
  const { rows } = await c.query(
    `insert into fixed_assets(dossier_id, label, asset_account_code, amort_account_code, expense_account_code,
        acquisition_date, commissioning_date, amount, residual_value, duration_years, depreciation_period, method, counterparty_id, notes, created_by, reprise_cumul, reprise_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
    [dossierId, input.label.trim(), input.assetAccountCode, amort, expense,
     input.acquisitionDate, commissioning, input.amount, input.residualValue ?? 0, input.durationYears, period, method,
     input.counterpartyId ?? null, input.notes ?? null, userId ?? null, repriseCumul, repriseCumul > 0 ? input.repriseDate : null],
  );
  return { id: rows[0].id };
}

export async function deleteAsset(c: Client, dossierId: string, id: string) {
  const { rows } = await c.query(
    'select count(*)::int n from fixed_asset_depreciations where dossier_id=$1 and fixed_asset_id=$2', [dossierId, id]);
  if (rows[0].n > 0) throw new Error('Immobilisation avec dotations déjà comptabilisées : contre-passez les dotations avant suppression.');
  await c.query('delete from fixed_assets where dossier_id=$1 and id=$2', [dossierId, id]);
}

function scheduleFor(a: any): ScheduleRow[] {
  return computeSchedule({
    amount: Number(a.amount), residualValue: Number(a.residual_value), durationYears: Number(a.duration_years),
    commissioningDate: a.commissioning_date, depreciationPeriod: a.depreciation_period, depreciationMethod: a.method,
    repriseCumul: a.reprise_cumul != null ? Number(a.reprise_cumul) : 0, repriseDate: a.reprise_date ? isoDate(a.reprise_date) : undefined,
  });
}
const isoDate = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Liste avec synthèse : valeur d'origine, amortissements comptabilisés, VNC, dotations dues.
export async function listAssets(c: Client, dossierId: string) {
  const { rows: assets } = await c.query(
    `select fa.*, cp.name as counterparty_name
       from fixed_assets fa
       left join counterparties cp on cp.id = fa.counterparty_id
      where fa.dossier_id=$1 order by fa.acquisition_date, fa.label`, [dossierId]);
  const { rows: deps } = await c.query(
    'select fixed_asset_id, period_date, amount from fixed_asset_depreciations where dossier_id=$1', [dossierId]);
  const postedByAsset = new Map<string, Map<string, number>>();
  for (const d of deps) {
    if (!postedByAsset.has(d.fixed_asset_id)) postedByAsset.set(d.fixed_asset_id, new Map());
    postedByAsset.get(d.fixed_asset_id)!.set(isoDate(d.period_date), Number(d.amount));
  }
  const today = new Date().toISOString().slice(0, 10);

  return assets.map((a: any) => {
    const amount = Number(a.amount), residual = Number(a.residual_value), duration = Number(a.duration_years);
    const repris = round2(Number(a.reprise_cumul ?? 0));
    const schedule = scheduleFor(a);
    const posted = postedByAsset.get(a.id) ?? new Map<string, number>();
    // Le cumul repris (amortissements antérieurs à la bascule) compte comme déjà pratiqué.
    const cumulPosted = round2(repris + [...posted.values()].reduce((s, v) => s + v, 0));
    const pendingRows = schedule.filter((r) => r.periodDate <= today && !posted.has(r.periodDate));
    const pending = pendingRows.length;
    const pendingAmount = round2(pendingRows.reduce((s, r) => s + r.dotation, 0));
    return {
      id: a.id, label: a.label,
      assetAccountCode: a.asset_account_code, amortAccountCode: a.amort_account_code, expenseAccountCode: a.expense_account_code,
      acquisitionDate: a.acquisition_date, commissioningDate: a.commissioning_date,
      amount, residualValue: residual, durationYears: duration, method: a.method, depreciationPeriod: a.depreciation_period,
      counterpartyName: a.counterparty_name, notes: a.notes, status: a.status,
      repriseCumul: repris, repriseDate: a.reprise_date ? isoDate(a.reprise_date) : null,
      cumulPosted, vnc: round2(amount - cumulPosted),
      pending: a.status === 'disposed' ? 0 : pending, pendingAmount: a.status === 'disposed' ? 0 : pendingAmount, fullyAmortized: cumulPosted >= round2(amount - residual) - 0.005,
      disposalDate: a.disposal_date, salePrice: a.sale_price != null ? Number(a.sale_price) : null,
      plusValue: a.plus_value != null ? Number(a.plus_value) : null,
    };
  });
}

// Détail : plan d'amortissement avec l'état (comptabilisé / prévu) par période.
export async function assetDetail(c: Client, dossierId: string, id: string) {
  const { rows } = await c.query('select * from fixed_assets where dossier_id=$1 and id=$2', [dossierId, id]);
  const a = rows[0];
  if (!a) throw new Error('Immobilisation introuvable.');
  const { rows: deps } = await c.query(
    'select period_date, amount, entry_id from fixed_asset_depreciations where dossier_id=$1 and fixed_asset_id=$2', [dossierId, id]);
  const postedMap = new Map<string, { entryId: string }>(deps.map((d: any) => [isoDate(d.period_date), { entryId: d.entry_id }]));
  const schedule = scheduleFor(a).map((r) => ({ ...r, posted: postedMap.has(r.periodDate), entryId: postedMap.get(r.periodDate)?.entryId ?? null }));

  return {
    id: a.id, label: a.label,
    assetAccountCode: a.asset_account_code, amortAccountCode: a.amort_account_code, expenseAccountCode: a.expense_account_code,
    acquisitionDate: a.acquisition_date, commissioningDate: a.commissioning_date,
    amount: Number(a.amount), residualValue: Number(a.residual_value), durationYears: Number(a.duration_years),
    method: a.method, depreciationPeriod: a.depreciation_period, notes: a.notes, status: a.status,
    repriseCumul: round2(Number(a.reprise_cumul ?? 0)), repriseDate: a.reprise_date ? isoDate(a.reprise_date) : null,
    schedule,
  };
}

// --- Comptabilisation des dotations -----------------------------------------

async function odJournalId(c: Client, dossierId: string): Promise<string> {
  const { rows } = await c.query("select id from journals where dossier_id=$1 and type='operations_diverses' limit 1", [dossierId]);
  return rows[0]?.id ?? await createJournal(c, dossierId, 'OD', 'Opérations diverses', 'operations_diverses');
}

async function fiscalYearForDate(c: Client, dossierId: string, date: string): Promise<string | null> {
  const { rows } = await c.query(
    'select id from fiscal_years where dossier_id=$1 and $2 between start_date and end_date order by start_date limit 1', [dossierId, date]);
  return rows[0]?.id ?? null;
}

// Comptabilise UNE dotation (période identifiée par sa date de fin).
export async function postDepreciation(
  c: Client, dossierId: string, assetId: string, periodDate: string,
): Promise<{ entryId: string; amount: number; periodDate: string }> {
  const { rows } = await c.query('select * from fixed_assets where dossier_id=$1 and id=$2', [dossierId, assetId]);
  const a = rows[0];
  if (!a) throw new Error('Immobilisation introuvable.');

  const row = scheduleFor(a).find((r) => r.periodDate === periodDate);
  if (!row) throw new Error(`Aucune dotation prévue au ${periodDate}.`);

  const { rows: ex } = await c.query(
    'select 1 from fixed_asset_depreciations where fixed_asset_id=$1 and period_date=$2', [assetId, periodDate]);
  if (ex[0]) throw new Error(`Dotation ${row.label} déjà comptabilisée pour cette immobilisation.`);

  const fyId = await fiscalYearForDate(c, dossierId, periodDate);
  if (!fyId) throw new Error(`Aucun exercice ne couvre le ${periodDate} — créez-le d'abord.`);

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fyId, journalId: await odJournalId(c, dossierId), entryDate: periodDate,
    description: `Dotation amortissement ${row.label} — ${a.label}`, source: 'recurring',
    lines: [
      { accountCode: a.expense_account_code, debit: row.dotation, label: `Dotation ${a.label}` },
      { accountCode: a.amort_account_code, credit: row.dotation, label: `Amortissement ${a.label}` },
    ],
  });

  await c.query(
    `insert into fixed_asset_depreciations(dossier_id, fixed_asset_id, fiscal_year_id, period_year, period_date, amount, entry_id)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [dossierId, assetId, fyId, Number(periodDate.slice(0, 4)), periodDate, row.dotation, entryId]);

  return { entryId, amount: row.dotation, periodDate };
}

// Toutes les dotations dues d'une immo jusqu'à `upTo` (défaut aujourd'hui).
export async function postAssetDue(
  c: Client, dossierId: string, assetId: string, upTo?: string,
): Promise<{ count: number; total: number; skipped: number }> {
  const target = upTo || new Date().toISOString().slice(0, 10);
  const { rows } = await c.query('select * from fixed_assets where dossier_id=$1 and id=$2', [dossierId, assetId]);
  const a = rows[0];
  if (!a) throw new Error('Immobilisation introuvable.');
  const { rows: deps } = await c.query('select period_date from fixed_asset_depreciations where fixed_asset_id=$1', [assetId]);
  const done = new Set(deps.map((d: any) => isoDate(d.period_date)));

  let count = 0, total = 0, skipped = 0;
  for (const r of scheduleFor(a)) {
    if (r.periodDate > target || done.has(r.periodDate)) continue;
    try { const p = await postDepreciation(c, dossierId, assetId, r.periodDate); count++; total = round2(total + p.amount); }
    catch { skipped++; }
  }
  return { count, total, skipped };
}

// --- Cession / sortie d'immobilisation --------------------------------------

export interface DisposeInput {
  disposalDate: string;
  salePrice?: number;      // 0 = mise au rebut
  cashAccount?: string;    // compte d'encaissement (521 par défaut) ou 485/411
}

export async function disposeAsset(
  c: Client, dossierId: string, assetId: string, input: DisposeInput,
): Promise<{ entryId: string; vnc: number; plusValue: number; salePrice: number }> {
  const { rows } = await c.query('select * from fixed_assets where dossier_id=$1 and id=$2', [dossierId, assetId]);
  const a = rows[0];
  if (!a) throw new Error('Immobilisation introuvable.');
  if (a.status === 'disposed') throw new Error('Immobilisation déjà cédée.');

  const gross = round2(Number(a.amount));
  const { rows: dr } = await c.query(
    'select coalesce(sum(amount),0) as cumul from fixed_asset_depreciations where dossier_id=$1 and fixed_asset_id=$2', [dossierId, assetId]);
  // Cumul total = amortissements comptabilisés dans Nova + cumul repris (déjà en 28x via l'à-nouveau).
  const cumul = round2(Number(dr[0].cumul) + Number(a.reprise_cumul ?? 0));
  const vnc = round2(gross - cumul);
  const salePrice = round2(input.salePrice ?? 0);
  const isIncorp = String(a.asset_account_code).startsWith('21');
  const vceac = isIncorp ? '811' : '812';   // valeur comptable des cessions (HAO, charge)
  const pcea = isIncorp ? '821' : '822';    // produits des cessions (HAO, produit)
  const cash = (input.cashAccount || '521').trim();

  await assertAccountExists(c, dossierId, a.amort_account_code, 'amortissement');
  await assertAccountExists(c, dossierId, a.asset_account_code, 'immobilisation');
  await assertAccountExists(c, dossierId, vceac, 'valeur comptable (VCEAC)');
  await assertAccountExists(c, dossierId, pcea, 'produit de cession (PCEA)');
  if (salePrice > 0) await assertAccountExists(c, dossierId, cash, 'encaissement');

  const fyId = await fiscalYearForDate(c, dossierId, input.disposalDate);
  if (!fyId) throw new Error(`Aucun exercice ne couvre le ${input.disposalDate}.`);

  const lines: any[] = [];
  // Sortie de l'actif : reprise des amortissements + VNC en charge, contre valeur brute.
  if (cumul > 0) lines.push({ accountCode: a.amort_account_code, debit: cumul, label: `Reprise amort. ${a.label}` });
  if (vnc > 0) lines.push({ accountCode: vceac, debit: vnc, label: `VCEAC ${a.label}` });
  lines.push({ accountCode: a.asset_account_code, credit: gross, label: `Sortie ${a.label}` });
  // Prix de cession.
  if (salePrice > 0) {
    lines.push({ accountCode: cash, debit: salePrice, paymentChannel: cash.startsWith('5') ? 'bank' as const : 'none' as const, label: `Cession ${a.label}` });
    lines.push({ accountCode: pcea, credit: salePrice, label: `PCEA ${a.label}` });
  }

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fyId, journalId: await odJournalId(c, dossierId), entryDate: input.disposalDate,
    description: `Cession ${a.label}${salePrice > 0 ? ` (prix ${salePrice})` : ' (mise au rebut)'}`, source: 'manual', lines,
  });

  const plusValue = round2(salePrice - vnc);
  await c.query(
    "update fixed_assets set status='disposed', disposal_date=$3, sale_price=$4, plus_value=$5, disposal_entry_id=$6 where dossier_id=$1 and id=$2",
    [dossierId, assetId, input.disposalDate, salePrice, plusValue, entryId]);

  return { entryId, vnc, plusValue, salePrice };
}

// Dotations dues en lot pour toutes les immos actives, jusqu'à `upTo`.
export async function postDepreciationDue(
  c: Client, dossierId: string, upTo?: string,
): Promise<{ count: number; total: number; skipped: number }> {
  const { rows: assets } = await c.query("select id from fixed_assets where dossier_id=$1 and status='active'", [dossierId]);
  let count = 0, total = 0, skipped = 0;
  for (const a of assets) {
    const r = await postAssetDue(c, dossierId, a.id, upTo);
    count += r.count; total = round2(total + r.total); skipped += r.skipped;
  }
  return { count, total, skipped };
}
