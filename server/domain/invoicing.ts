import type { Client } from '../db.js';
import { postEntry, resolveCounterparty } from './accounting.js';
import { certifyInvoice, fneProvider } from '../fne/provider.js';
import { recordAudit } from './audit.js';

// ============================================================================
// Facturation de vente. L'émission génère l'écriture (411 / 70x / 443) et
// permet la certification FNE. Une facture brouillon est modifiable ; émise,
// elle est verrouillée (rattachée à une écriture comptable immuable).
// ============================================================================

export interface InvoiceLineInput {
  description: string; quantity: number; unitPrice: number; vatRate: number; accountCode?: string;
}
export type DocType = 'invoice' | 'quote' | 'credit_note';
export interface CreateInvoiceInput {
  clientName: string; counterpartyId?: string; invoiceDate: string; dueDate?: string;
  currency?: string; notes?: string; docType?: DocType; lines: InvoiceLineInput[];
}
const PREFIX: Record<DocType, string> = { invoice: 'FV', quote: 'DEV', credit_note: 'AV' };
const DOC_LABEL: Record<DocType, string> = { invoice: 'Facture', quote: 'Devis', credit_note: 'Avoir' };

async function nextNumber(c: Client, dossierId: string, docType: DocType, year: string): Promise<string> {
  const p = PREFIX[docType];
  const { rows } = await c.query(
    "select count(*) n from invoices where dossier_id=$1 and number is not null and number like $2", [dossierId, `${p}-${year}-%`]);
  return `${p}-${year}-${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}

function computeLines(lines: any[]) {
  return lines.map((l, i) => {
    // Tolère camelCase (domaine) et snake_case (client) pour les mêmes champs.
    const unitPrice = Number(l.unitPrice ?? l.unit_price ?? 0);
    const vatRate = Number(l.vatRate ?? l.vat_rate ?? 0);
    const accountCode = l.accountCode || l.account_code || '701';
    const ht = Number(l.quantity) * unitPrice;
    const tva = ht * vatRate;
    return { description: l.description, quantity: Number(l.quantity), unitPrice, vatRate, accountCode, amount_ht: ht, amount_tva: tva, line_no: i + 1 };
  });
}

export async function listInvoices(c: Client, dossierId: string, status?: string, docType?: string): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'dossier_id = $1';
  if (status) { params.push(status); where += ` and status = $${params.length}`; }
  params.push(docType || 'invoice'); where += ` and doc_type = $${params.length}`;
  const { rows } = await c.query(
    `select id, number, client_name, to_char(invoice_date,'YYYY-MM-DD') as invoice_date, status, doc_type,
            total_ht, total_tva, total_ttc, fne_status, fne_reference, currency, source_document_id
       from invoices where ${where} order by created_at desc`,
    params,
  );
  return rows.map((r: any) => ({ ...r, total_ht: Number(r.total_ht), total_tva: Number(r.total_tva), total_ttc: Number(r.total_ttc) }));
}

export async function getInvoice(c: Client, dossierId: string, id: string): Promise<any> {
  const { rows } = await c.query(
    `select id, number, client_name, counterparty_id, to_char(invoice_date,'YYYY-MM-DD') as invoice_date,
            to_char(due_date,'YYYY-MM-DD') as due_date, status, doc_type, source_document_id, currency,
            total_ht, total_tva, total_ttc, entry_id, fne_status, fne_reference, fne_qr, notes
       from invoices where dossier_id=$1 and id=$2`, [dossierId, id]);
  if (!rows[0]) throw new Error('Document introuvable');
  const { rows: lines } = await c.query(
    `select id, line_no, description, quantity, unit_price, vat_rate, account_code, amount_ht, amount_tva
       from invoice_lines where invoice_id=$1 order by line_no`, [id]);
  return {
    ...rows[0],
    total_ht: Number(rows[0].total_ht), total_tva: Number(rows[0].total_tva), total_ttc: Number(rows[0].total_ttc),
    lines: lines.map((l: any) => ({ ...l, quantity: Number(l.quantity), unit_price: Number(l.unit_price), vat_rate: Number(l.vat_rate), amount_ht: Number(l.amount_ht), amount_tva: Number(l.amount_tva) })),
  };
}

export async function createInvoice(c: Client, dossierId: string, input: CreateInvoiceInput): Promise<{ id: string }> {
  if (!input.clientName?.trim()) throw new Error('Client requis');
  if (!input.lines?.length) throw new Error('Au moins une ligne requise');
  const lines = computeLines(input.lines);
  const totalHt = lines.reduce((s, l) => s + l.amount_ht, 0);
  const totalTva = lines.reduce((s, l) => s + l.amount_tva, 0);
  const { rows } = await c.query(
    `insert into invoices(dossier_id, client_name, counterparty_id, invoice_date, due_date, currency, notes, doc_type, total_ht, total_tva, total_ttc)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [dossierId, input.clientName.trim(), input.counterpartyId ?? null, input.invoiceDate, input.dueDate ?? null,
     input.currency ?? 'XOF', input.notes ?? null, input.docType ?? 'invoice', totalHt, totalTva, totalHt + totalTva],
  );
  const id = rows[0].id;
  for (const l of lines) {
    await c.query(
      `insert into invoice_lines(invoice_id, dossier_id, line_no, description, quantity, unit_price, vat_rate, account_code, amount_ht, amount_tva)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, dossierId, l.line_no, l.description, l.quantity, l.unitPrice, l.vatRate, l.accountCode, l.amount_ht, l.amount_tva],
    );
  }
  return { id };
}

export async function deleteInvoice(c: Client, dossierId: string, id: string): Promise<void> {
  const { rows } = await c.query('select status from invoices where dossier_id=$1 and id=$2', [dossierId, id]);
  if (rows[0] && rows[0].status !== 'draft') throw new Error('Seule une facture brouillon peut être supprimée.');
  await c.query('delete from invoices where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Émission : numérote, comptabilise (facture 411/70x/443 ; avoir = écriture inverse),
// verrouille en 'issued'. Un devis ne s'émet pas : il se convertit.
export async function issueInvoice(c: Client, dossierId: string, id: string): Promise<{ number: string; entryId: string }> {
  const inv = await getInvoice(c, dossierId, id);
  const docType: DocType = inv.doc_type ?? 'invoice';
  if (docType === 'quote') throw new Error("Un devis se convertit en facture, il ne s'émet pas.");
  if (inv.status !== 'draft') throw new Error(`${DOC_LABEL[docType]} déjà émis(e).`);

  const year = inv.invoice_date.slice(0, 4);
  const number = await nextNumber(c, dossierId, docType, year);
  const isCredit = docType === 'credit_note';

  const { rows: fy } = await c.query(
    "select id from fiscal_years where dossier_id=$1 and status<>'closed' and $2 between start_date and end_date order by start_date limit 1",
    [dossierId, inv.invoice_date]);
  if (!fy[0]) throw new Error("Aucun exercice ouvert pour cette date. Initialisez/ouvrez l'exercice.");
  const { rows: jv } = await c.query("select id from journals where dossier_id=$1 and code='VE' limit 1", [dossierId]);
  if (!jv[0]) throw new Error("Journal des ventes (VE) absent — initialisez le dossier.");

  const cpId = inv.counterparty_id ?? await resolveCounterparty(c, dossierId, inv.client_name, 'client');
  const byAccount = new Map<string, number>();
  for (const l of inv.lines) byAccount.set(l.account_code, (byAccount.get(l.account_code) ?? 0) + l.amount_ht);

  // Avoir : sens inverse de la facture (crédit 411, débit 70x, débit 443).
  const entryLines: any[] = [{
    accountCode: '411', counterpartyId: cpId,
    [isCredit ? 'credit' : 'debit']: inv.total_ttc, label: `${DOC_LABEL[docType]} ${number} ${inv.client_name}`,
  }];
  for (const [code, ht] of byAccount) entryLines.push({ accountCode: code, [isCredit ? 'debit' : 'credit']: ht, label: `${isCredit ? 'Avoir ventes' : 'Ventes'} ${number}` });
  if (inv.total_tva > 0) entryLines.push({ accountCode: '443', [isCredit ? 'debit' : 'credit']: inv.total_tva, label: `TVA ${isCredit ? 'sur avoir' : 'facturée'} ${number}` });

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy[0].id, journalId: jv[0].id, entryDate: inv.invoice_date,
    description: `${DOC_LABEL[docType]} ${number} — ${inv.client_name}`, source: 'manual', counterpartyName: inv.client_name, lines: entryLines,
  });

  await c.query("update invoices set status='issued', number=$3, entry_id=$4, counterparty_id=$5 where dossier_id=$1 and id=$2",
    [dossierId, id, number, entryId, cpId]);
  await recordAudit(c, {
    dossierId, action: isCredit ? 'creditnote.issued' : 'invoice.issued', entity: 'invoice', entityId: id,
    detail: { number, client: inv.client_name, total_ttc: inv.total_ttc, entryId },
  });
  return { number, entryId };
}

// Convertit un devis accepté en facture (brouillon), en recopiant ses lignes.
export async function convertQuote(c: Client, dossierId: string, quoteId: string): Promise<{ id: string }> {
  const q = await getInvoice(c, dossierId, quoteId);
  if (q.doc_type !== 'quote') throw new Error("Seul un devis se convertit en facture.");
  if (q.status === 'converted') throw new Error('Devis déjà converti.');
  const { id } = await createInvoice(c, dossierId, {
    clientName: q.client_name, counterpartyId: q.counterparty_id ?? undefined,
    invoiceDate: new Date().toISOString().slice(0, 10), currency: q.currency, notes: q.notes ?? undefined, docType: 'invoice',
    lines: q.lines.map((l: any) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price, vatRate: l.vat_rate, accountCode: l.account_code })),
  });
  await c.query('update invoices set source_document_id=$3 where dossier_id=$1 and id=$2', [dossierId, id, quoteId]);
  await c.query("update invoices set status='converted' where dossier_id=$1 and id=$2", [dossierId, quoteId]);
  return { id };
}

// Crée un avoir (brouillon) à partir d'une facture émise, en recopiant ses lignes.
export async function creditNoteFromInvoice(c: Client, dossierId: string, invoiceId: string): Promise<{ id: string }> {
  const inv = await getInvoice(c, dossierId, invoiceId);
  if (inv.doc_type !== 'invoice') throw new Error('Un avoir se crée à partir d\'une facture.');
  if (inv.status === 'draft') throw new Error('Émettez la facture avant d\'établir un avoir.');
  const { id } = await createInvoice(c, dossierId, {
    clientName: inv.client_name, counterpartyId: inv.counterparty_id ?? undefined,
    invoiceDate: new Date().toISOString().slice(0, 10), currency: inv.currency, docType: 'credit_note',
    notes: `Avoir sur facture ${inv.number}`,
    lines: inv.lines.map((l: any) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price, vatRate: l.vat_rate, accountCode: l.account_code })),
  });
  await c.query('update invoices set source_document_id=$3 where dossier_id=$1 and id=$2', [dossierId, id, invoiceId]);
  return { id };
}

export async function certifyInvoiceFne(c: Client, dossierId: string, id: string): Promise<{ reference: string; provider: string }> {
  const inv = await getInvoice(c, dossierId, id);
  if (inv.status === 'draft') throw new Error("Émettez la facture avant de la certifier.");
  if (inv.fne_status === 'certified') throw new Error('Facture déjà certifiée.');
  const r = await certifyInvoice({
    number: inv.number, date: inv.invoice_date, clientName: inv.client_name,
    totalHt: inv.total_ht, totalTva: inv.total_tva, totalTtc: inv.total_ttc, currency: inv.currency,
  });
  await c.query("update invoices set fne_status='certified', fne_reference=$3, fne_qr=$4 where dossier_id=$1 and id=$2",
    [dossierId, id, r.reference, r.qr]);
  await recordAudit(c, {
    dossierId, action: 'invoice.certified', entity: 'invoice', entityId: id,
    detail: { number: inv.number, reference: r.reference, provider: fneProvider() },
  });
  return { reference: r.reference, provider: fneProvider() };
}
