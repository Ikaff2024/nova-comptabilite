import type { Client } from '../db.js';
import { postEntry, type EntryLineInput } from './accounting.js';

// ============================================================================
// Écritures récurrentes / abonnements. Un modèle décrit une écriture périodique ;
// generateDue comptabilise les échéances dues (source 'recurring') sans doublon.
// ============================================================================

export type Frequency = 'monthly' | 'quarterly' | 'yearly';
const STEP: Record<Frequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };

export interface RecurringLine { accountCode: string; debit?: number; credit?: number; label?: string }

export interface CreateTemplateInput {
  label: string;
  journalId: string;
  frequency: Frequency;
  dayOfMonth?: number;
  startDate: string;         // 'YYYY-MM-DD'
  endDate?: string | null;
  counterpartyName?: string;
  lines: RecurringLine[];
  notes?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function clampDay(year: number, monthIndex: number, day: number): string {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const d = Math.min(day, last);
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Dates d'échéance du modèle jusqu'à `upTo` (incluses), pas selon la fréquence.
export function occurrenceDates(t: {
  frequency: Frequency; day_of_month: number; start_date: string; end_date: string | null;
}, upTo: string): string[] {
  const start = new Date(t.start_date);
  const end = t.end_date ? new Date(t.end_date) : null;
  const upToD = new Date(upTo);
  const step = STEP[t.frequency];
  const out: string[] = [];
  let y = start.getUTCFullYear(), mi = start.getUTCMonth();
  for (let i = 0; i < 600; i++) {
    const dateStr = clampDay(y, mi, t.day_of_month);
    const d = new Date(dateStr);
    if (d > upToD) break;
    if (!end || d <= end) out.push(dateStr);
    mi += step; while (mi > 11) { mi -= 12; y++; }
  }
  return out;
}

function assertBalanced(lines: RecurringLine[]) {
  if (!lines || lines.length < 2) throw new Error('Le modèle exige au moins 2 lignes (partie double).');
  const d = round2(lines.reduce((s, l) => s + (l.debit ?? 0), 0));
  const c = round2(lines.reduce((s, l) => s + (l.credit ?? 0), 0));
  if (d !== c) throw new Error(`Modèle déséquilibré : débit ${d} ≠ crédit ${c}.`);
  if (d === 0) throw new Error('Montants nuls : renseignez les débits/crédits.');
}

export async function createTemplate(c: Client, dossierId: string, input: CreateTemplateInput, userId?: string) {
  if (!input.label?.trim()) throw new Error('Libellé requis.');
  assertBalanced(input.lines);
  // Vérifie l'existence des comptes.
  const codes = [...new Set(input.lines.map((l) => l.accountCode))];
  const { rows } = await c.query('select account_code from accounts where dossier_id=$1 and account_code = any($2)', [dossierId, codes]);
  const known = new Set(rows.map((r: any) => r.account_code));
  for (const code of codes) if (!known.has(code)) throw new Error(`Compte ${code} introuvable dans le plan.`);

  const { rows: ins } = await c.query(
    `insert into recurring_templates(dossier_id, label, journal_id, frequency, day_of_month, start_date, end_date, counterparty_name, lines, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) returning id`,
    [dossierId, input.label.trim(), input.journalId, input.frequency, input.dayOfMonth ?? new Date(input.startDate).getUTCDate(),
     input.startDate, input.endDate ?? null, input.counterpartyName ?? null, JSON.stringify(input.lines), input.notes ?? null, userId ?? null]);
  return { id: ins[0].id };
}

export async function deleteTemplate(c: Client, dossierId: string, id: string) {
  await c.query('delete from recurring_templates where dossier_id=$1 and id=$2', [dossierId, id]);
}

export async function setActive(c: Client, dossierId: string, id: string, active: boolean) {
  await c.query('update recurring_templates set active=$3 where dossier_id=$1 and id=$2', [dossierId, id, active]);
}

const FREQ_LABEL: Record<Frequency, string> = { monthly: 'Mensuel', quarterly: 'Trimestriel', yearly: 'Annuel' };

export async function listTemplates(c: Client, dossierId: string) {
  const { rows } = await c.query(
    `select t.*, j.code as journal_code,
            (select count(*) from recurring_occurrences o where o.template_id=t.id) as generated
       from recurring_templates t join journals j on j.id=t.journal_id
      where t.dossier_id=$1 order by t.active desc, t.label`, [dossierId]);
  const today = iso(new Date());
  return rows.map((t: any) => {
    const amount = round2((t.lines as any[]).reduce((s, l) => s + (l.debit ?? 0), 0));
    const due = t.active ? occurrenceDates(t, today).length - Number(t.generated) : 0;
    return {
      id: t.id, label: t.label, journalCode: t.journal_code, frequency: t.frequency, frequencyLabel: FREQ_LABEL[t.frequency as Frequency],
      dayOfMonth: t.day_of_month, startDate: t.start_date, endDate: t.end_date, counterpartyName: t.counterparty_name,
      lines: t.lines, amount, active: t.active, generated: Number(t.generated), due: Math.max(0, due),
    };
  });
}

async function fiscalYearForDate(c: Client, dossierId: string, date: string): Promise<string | null> {
  const { rows } = await c.query(
    "select id from fiscal_years where dossier_id=$1 and $2 between start_date and end_date order by start_date limit 1", [dossierId, date]);
  return rows[0]?.id ?? null;
}

// Génère les échéances dues d'un modèle jusqu'à `upTo` (défaut : aujourd'hui).
export async function generateDue(
  c: Client, dossierId: string, templateId: string, upTo?: string,
): Promise<{ count: number; total: number; skipped: number }> {
  const { rows } = await c.query('select * from recurring_templates where dossier_id=$1 and id=$2', [dossierId, templateId]);
  const t = rows[0];
  if (!t) throw new Error('Modèle introuvable.');
  const target = upTo || iso(new Date());
  const dates = occurrenceDates(t, target);

  const { rows: occ } = await c.query('select period_date from recurring_occurrences where template_id=$1', [templateId]);
  const done = new Set(occ.map((o: any) => iso(new Date(o.period_date))));

  const lines: EntryLineInput[] = (t.lines as RecurringLine[]).map((l) => ({
    accountCode: l.accountCode, debit: l.debit ?? 0, credit: l.credit ?? 0, label: l.label,
  }));

  let count = 0, total = 0, skipped = 0;
  for (const date of dates) {
    if (done.has(date)) continue;
    const fyId = await fiscalYearForDate(c, dossierId, date);
    if (!fyId) { skipped++; continue; }  // pas d'exercice pour cette période
    const { id: entryId } = await postEntry(c, {
      dossierId, fiscalYearId: fyId, journalId: t.journal_id, entryDate: date,
      description: `${t.label} — ${date.slice(0, 7)}`, source: 'recurring',
      counterpartyName: t.counterparty_name ?? undefined, lines,
    });
    await c.query('insert into recurring_occurrences(dossier_id, template_id, period_date, entry_id) values ($1,$2,$3,$4)',
      [dossierId, templateId, date, entryId]);
    count++; total = round2(total + lines.reduce((s, l) => s + (l.debit ?? 0), 0));
  }
  return { count, total, skipped };
}

export async function generateAllDue(
  c: Client, dossierId: string, upTo?: string,
): Promise<{ count: number; total: number; templates: number }> {
  const { rows } = await c.query("select id from recurring_templates where dossier_id=$1 and active=true", [dossierId]);
  let count = 0, total = 0, templates = 0;
  for (const t of rows) {
    const r = await generateDue(c, dossierId, t.id, upTo);
    if (r.count > 0) templates++;
    count += r.count; total = round2(total + r.total);
  }
  return { count, total, templates };
}
