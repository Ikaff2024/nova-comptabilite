import type { Client } from '../db.js';
import { occurrenceDates, type Frequency } from './recurring.js';
import { createInvoice } from './invoicing.js';

// ============================================================================
// Factures de vente récurrentes (abonnements) : à chaque échéance, génère une
// FACTURE BROUILLON (à émettre par l'humain dans l'onglet Facturation).
// ============================================================================

const iso = (d: Date) => d.toISOString().slice(0, 10);
const FREQ_LABEL: Record<string, string> = { monthly: 'Mensuel', quarterly: 'Trimestriel', yearly: 'Annuel' };
const lineTotal = (l: any) => (Number(l.quantity) || 1) * (Number(l.unit_price) || 0) * (1 + (l.vat_rate != null ? Number(l.vat_rate) : 0.18));

export async function listTemplates(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select t.*, (select count(*) from recurring_invoice_occurrences o where o.template_id=t.id) as generated
       from recurring_invoice_templates t where t.dossier_id=$1 order by t.active desc, t.label`, [dossierId]);
  const today = iso(new Date());
  return rows.map((t: any) => {
    const ttc = (t.lines as any[]).reduce((s, l) => s + lineTotal(l), 0);
    const due = t.active ? Math.max(0, occurrenceDates({ frequency: t.frequency, day_of_month: t.day_of_month, start_date: iso(new Date(t.start_date)), end_date: t.end_date ? iso(new Date(t.end_date)) : null }, today).length - Number(t.generated)) : 0;
    return { id: t.id, label: t.label, clientName: t.client_name, lines: t.lines, frequency: t.frequency, frequencyLabel: FREQ_LABEL[t.frequency], dayOfMonth: t.day_of_month, startDate: iso(new Date(t.start_date)), endDate: t.end_date ? iso(new Date(t.end_date)) : null, active: t.active, montantTtc: Math.round(ttc), generated: Number(t.generated), due };
  });
}

export async function createTemplate(c: Client, dossierId: string, input: any): Promise<{ id: string }> {
  if (!input.clientName?.trim()) throw new Error('Client requis');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error('Au moins une ligne requise');
  const lines = input.lines.map((l: any) => ({ description: String(l.description ?? ''), quantity: Number(l.quantity) || 1, unit_price: Number(l.unit_price) || 0, vat_rate: l.vat_rate != null ? Number(l.vat_rate) : 0.18, account_code: l.account_code || '706' }));
  const { rows } = await c.query(
    `insert into recurring_invoice_templates(dossier_id, label, client_name, lines, frequency, day_of_month, start_date, end_date, active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,true) returning id`,
    [dossierId, String(input.label ?? 'Abonnement').trim(), input.clientName.trim(), JSON.stringify(lines), input.frequency || 'monthly', Number(input.dayOfMonth) || 1, input.startDate, input.endDate || null]);
  return { id: rows[0].id };
}

export async function deleteTemplate(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from recurring_invoice_templates where dossier_id=$1 and id=$2', [dossierId, id]);
}
export async function setActive(c: Client, dossierId: string, id: string, active: boolean): Promise<void> {
  await c.query('update recurring_invoice_templates set active=$3 where dossier_id=$1 and id=$2', [dossierId, id, active]);
}

// Génère les factures brouillons dues d'un modèle.
export async function generateDue(c: Client, dossierId: string, templateId: string, upTo?: string): Promise<{ count: number }> {
  const { rows } = await c.query('select * from recurring_invoice_templates where dossier_id=$1 and id=$2', [dossierId, templateId]);
  const t = rows[0];
  if (!t) throw new Error('Modèle introuvable.');
  const target = upTo || iso(new Date());
  const dates = occurrenceDates({ frequency: t.frequency, day_of_month: t.day_of_month, start_date: iso(new Date(t.start_date)), end_date: t.end_date ? iso(new Date(t.end_date)) : null }, target);
  const { rows: occ } = await c.query('select period_date from recurring_invoice_occurrences where template_id=$1', [templateId]);
  const done = new Set(occ.map((o: any) => iso(new Date(o.period_date))));

  let count = 0;
  for (const date of dates) {
    if (done.has(date)) continue;
    const { id: invoiceId } = await createInvoice(c, dossierId, {
      clientName: t.client_name, invoiceDate: date, docType: 'invoice',
      lines: (t.lines as any[]).map((l) => ({ description: l.description, quantity: Number(l.quantity) || 1, unit_price: Number(l.unit_price) || 0, vat_rate: l.vat_rate != null ? Number(l.vat_rate) : 0.18, account_code: l.account_code || '706' })),
    } as any);
    await c.query('insert into recurring_invoice_occurrences(dossier_id, template_id, period_date, invoice_id) values ($1,$2,$3,$4)', [dossierId, templateId, date, invoiceId]);
    count++;
  }
  return { count };
}

export async function generateAllDue(c: Client, dossierId: string, upTo?: string): Promise<{ count: number; templates: number }> {
  const { rows } = await c.query('select id from recurring_invoice_templates where dossier_id=$1 and active=true', [dossierId]);
  let count = 0, templates = 0;
  for (const t of rows) { const r = await generateDue(c, dossierId, t.id, upTo); if (r.count > 0) templates++; count += r.count; }
  return { count, templates };
}
