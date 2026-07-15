import type { Client } from '../db.js';
import { postEntry, resolveCounterparty } from './accounting.js';
import { createLettrage } from './lettrage.js';
import { recordAudit } from './audit.js';

// ============================================================================
// Cycle achats fournisseurs. La comptabilisation génère l'écriture d'achat
// (60x/2x débit + 4452 TVA déductible débit / 401 fournisseur crédit) dans le
// journal AC ; le règlement génère 401 débit / trésorerie crédit et lettre le
// compte fournisseur. Une facture brouillon est modifiable ; comptabilisée,
// elle est verrouillée (rattachée à une écriture immuable).
// ============================================================================

const TVA_DEDUCTIBLE = '4452'; // État, TVA récupérable sur achats
const SUPPLIER_ACCOUNT = '401';

export interface PurchaseLineInput {
  description: string; accountCode?: string; analyticAxis?: string; amountHt: number; vatRate?: number;
}
export interface CreatePurchaseInput {
  supplierName: string; supplierRef?: string; invoiceDate: string; dueDate?: string;
  currency?: string; notes?: string; lines: PurchaseLineInput[];
}

function computeLines(lines: any[]) {
  return lines.map((l, i) => {
    // Tolère camelCase (domaine) et snake_case (client) pour les mêmes champs.
    const ht = Number(l.amountHt ?? l.amount_ht ?? 0);
    const vatRate = Number(l.vatRate ?? l.vat_rate ?? 0);
    return {
      description: l.description,
      accountCode: (l.accountCode || l.account_code || '601').trim(),
      analyticAxis: l.analyticAxis || l.analytic_axis || null,
      amount_ht: ht,
      vat_rate: vatRate,
      amount_tva: Math.round(ht * vatRate * 100) / 100,
      line_no: i + 1,
    };
  });
}

export async function listPurchases(c: Client, dossierId: string, status?: string): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'dossier_id = $1';
  if (status) { params.push(status); where += ` and status = $${params.length}`; }
  const { rows } = await c.query(
    `select id, supplier_name, supplier_ref, to_char(invoice_date,'YYYY-MM-DD') as invoice_date,
            to_char(due_date,'YYYY-MM-DD') as due_date, status, total_ht, total_tva, total_ttc, currency, entry_id, payment_entry_id
       from purchase_invoices where ${where} order by invoice_date desc, created_at desc`,
    params,
  );
  return rows.map((r: any) => ({ ...r, total_ht: Number(r.total_ht), total_tva: Number(r.total_tva), total_ttc: Number(r.total_ttc) }));
}

export async function getPurchase(c: Client, dossierId: string, id: string): Promise<any> {
  const { rows } = await c.query(
    `select id, supplier_name, supplier_ref, counterparty_id, to_char(invoice_date,'YYYY-MM-DD') as invoice_date,
            to_char(due_date,'YYYY-MM-DD') as due_date, status, currency, notes,
            total_ht, total_tva, total_ttc, entry_id, payment_entry_id
       from purchase_invoices where dossier_id=$1 and id=$2`, [dossierId, id]);
  if (!rows[0]) throw new Error('Facture fournisseur introuvable');
  const { rows: lines } = await c.query(
    `select id, line_no, description, account_code, analytic_axis, amount_ht, vat_rate, amount_tva
       from purchase_invoice_lines where purchase_id=$1 order by line_no`, [id]);
  return {
    ...rows[0],
    total_ht: Number(rows[0].total_ht), total_tva: Number(rows[0].total_tva), total_ttc: Number(rows[0].total_ttc),
    lines: lines.map((l: any) => ({ ...l, amount_ht: Number(l.amount_ht), vat_rate: Number(l.vat_rate), amount_tva: Number(l.amount_tva) })),
  };
}

// Détecte les factures fournisseurs ressemblant à un doublon de saisie.
// Deux signaux : (fort) même fournisseur + même n° de facture fournisseur ;
// (probable) même fournisseur + même montant TTC à ±4 jours. On exclut la
// facture en cours d'édition (excludeId) le cas échéant.
export interface DuplicateMatch {
  id: string; supplier_name: string; supplier_ref: string | null; invoice_date: string;
  total_ttc: number; status: string; reason: 'ref' | 'amount';
}
export async function findPurchaseDuplicates(
  c: Client, dossierId: string,
  crit: { supplierName?: string; supplierRef?: string; invoiceDate?: string; totalTtc?: number; excludeId?: string },
): Promise<DuplicateMatch[]> {
  const name = (crit.supplierName ?? '').trim().toLowerCase();
  const ref = (crit.supplierRef ?? '').trim().toLowerCase();
  const ttc = Number(crit.totalTtc ?? 0);
  const date = crit.invoiceDate ?? null;
  if (!name && !ref) return [];
  const { rows } = await c.query(
    `select id, supplier_name, supplier_ref, to_char(invoice_date,'YYYY-MM-DD') as invoice_date,
            total_ttc, status,
            (lower(trim(supplier_ref)) = $3 and $3 <> '') as ref_match,
            (abs(total_ttc - $4) < 0.5 and $4 > 0 and ($5::date is null or abs(invoice_date - $5::date) <= 4)) as amount_match
       from purchase_invoices
      where dossier_id = $1
        and ($6::uuid is null or id <> $6::uuid)
        and status <> 'cancelled'
        and lower(trim(supplier_name)) = $2
        and (
          (lower(trim(supplier_ref)) = $3 and $3 <> '')
          or (abs(total_ttc - $4) < 0.5 and $4 > 0 and ($5::date is null or abs(invoice_date - $5::date) <= 4))
        )
      order by invoice_date desc limit 5`,
    [dossierId, name, ref, ttc, date, crit.excludeId ?? null],
  );
  return rows.map((r: any) => ({
    id: r.id, supplier_name: r.supplier_name, supplier_ref: r.supplier_ref,
    invoice_date: r.invoice_date, total_ttc: Number(r.total_ttc), status: r.status,
    reason: r.ref_match ? 'ref' : 'amount',
  }));
}

export async function createPurchase(c: Client, dossierId: string, input: CreatePurchaseInput): Promise<{ id: string; duplicates?: DuplicateMatch[] }> {
  if (!input.supplierName?.trim()) throw new Error('Fournisseur requis');
  if (!input.lines?.length) throw new Error('Au moins une ligne requise');
  const lines = computeLines(input.lines);
  const totalHt = lines.reduce((s, l) => s + l.amount_ht, 0);
  const totalTva = lines.reduce((s, l) => s + l.amount_tva, 0);
  // Signale (sans bloquer) une éventuelle facture déjà saisie.
  const duplicates = await findPurchaseDuplicates(c, dossierId, {
    supplierName: input.supplierName, supplierRef: input.supplierRef,
    invoiceDate: input.invoiceDate, totalTtc: totalHt + totalTva,
  });
  const { rows } = await c.query(
    `insert into purchase_invoices(dossier_id, supplier_name, supplier_ref, invoice_date, due_date, currency, notes, total_ht, total_tva, total_ttc)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [dossierId, input.supplierName.trim(), input.supplierRef ?? null, input.invoiceDate, input.dueDate ?? null,
     input.currency ?? 'XOF', input.notes ?? null, totalHt, totalTva, totalHt + totalTva],
  );
  const id = rows[0].id;
  for (const l of lines) {
    await c.query(
      `insert into purchase_invoice_lines(purchase_id, dossier_id, line_no, description, account_code, analytic_axis, amount_ht, vat_rate, amount_tva)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, dossierId, l.line_no, l.description, l.accountCode, l.analyticAxis, l.amount_ht, l.vat_rate, l.amount_tva],
    );
  }
  return duplicates.length ? { id, duplicates } : { id };
}

export async function deletePurchase(c: Client, dossierId: string, id: string): Promise<void> {
  const { rows } = await c.query('select status from purchase_invoices where dossier_id=$1 and id=$2', [dossierId, id]);
  if (rows[0] && rows[0].status !== 'draft') throw new Error('Seule une facture brouillon peut être supprimée.');
  await c.query('delete from purchase_invoices where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Comptabilise la facture : 60x/2x (débit, groupé par compte+section) + 4452 TVA
// déductible (débit) / 401 fournisseur (crédit). Verrouille en 'recorded'.
export async function recordPurchase(c: Client, dossierId: string, id: string): Promise<{ entryId: string }> {
  const pur = await getPurchase(c, dossierId, id);
  if (pur.status !== 'draft') throw new Error('Facture déjà comptabilisée.');

  const { rows: fy } = await c.query(
    "select id from fiscal_years where dossier_id=$1 and status<>'closed' and $2 between start_date and end_date order by start_date limit 1",
    [dossierId, pur.invoice_date]);
  if (!fy[0]) throw new Error("Aucun exercice ouvert pour cette date. Initialisez/ouvrez l'exercice.");
  const { rows: ja } = await c.query("select id from journals where dossier_id=$1 and code='AC' limit 1", [dossierId]);
  if (!ja[0]) throw new Error("Journal des achats (AC) absent — initialisez le dossier.");

  const cpId = pur.counterparty_id ?? await resolveCounterparty(c, dossierId, pur.supplier_name, 'fournisseur');
  const ref = pur.supplier_ref ? ` ${pur.supplier_ref}` : '';

  // Regroupe la charge par (compte, section analytique) : deux sections sur un
  // même compte donnent deux lignes d'écriture distinctes, chacune ventilée.
  const byAccount = new Map<string, { code: string; axis: string | null; ht: number }>();
  for (const l of pur.lines) {
    const axis = l.analytic_axis || null;
    const key = `${l.account_code}|${axis ?? ''}`;
    const cur = byAccount.get(key) ?? { code: l.account_code, axis, ht: 0 };
    cur.ht += l.amount_ht;
    byAccount.set(key, cur);
  }

  const entryLines: any[] = [];
  for (const { code, axis, ht } of byAccount.values())
    entryLines.push({ accountCode: code, analyticAxis: axis ?? undefined, debit: ht, label: `Achat${ref} ${pur.supplier_name}` });
  if (pur.total_tva > 0) entryLines.push({ accountCode: TVA_DEDUCTIBLE, debit: pur.total_tva, label: `TVA déductible${ref}` });
  entryLines.push({ accountCode: SUPPLIER_ACCOUNT, counterpartyId: cpId, credit: pur.total_ttc, label: `Facture${ref} ${pur.supplier_name}` });

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy[0].id, journalId: ja[0].id, entryDate: pur.invoice_date,
    description: `Facture fournisseur${ref} — ${pur.supplier_name}`, source: 'manual', counterpartyName: pur.supplier_name, lines: entryLines,
  });

  await c.query("update purchase_invoices set status='recorded', entry_id=$3, counterparty_id=$4 where dossier_id=$1 and id=$2",
    [dossierId, id, entryId, cpId]);
  await recordAudit(c, {
    dossierId, action: 'purchase.recorded', entity: 'purchase_invoice', entityId: id,
    detail: { supplier: pur.supplier_name, ref: pur.supplier_ref, total_ttc: pur.total_ttc, entryId },
  });
  return { entryId };
}

// Règle la facture : 401 fournisseur (débit) / trésorerie (crédit), puis lettre
// le compte fournisseur (facture ↔ règlement). Verrouille en 'paid'.
export async function payPurchase(
  c: Client, dossierId: string, id: string, opts: { paymentDate: string; treasuryCode: string; channel?: string },
): Promise<{ entryId: string }> {
  const pur = await getPurchase(c, dossierId, id);
  if (pur.status !== 'recorded') throw new Error(pur.status === 'paid' ? 'Facture déjà réglée.' : "Comptabilisez la facture avant de la régler.");
  const treasury = (opts.treasuryCode || '521').trim();
  const payDate = opts.paymentDate || new Date().toISOString().slice(0, 10);

  const { rows: fy } = await c.query(
    "select id from fiscal_years where dossier_id=$1 and status<>'closed' and $2 between start_date and end_date order by start_date limit 1",
    [dossierId, payDate]);
  if (!fy[0]) throw new Error(`Aucun exercice ouvert ne couvre le ${payDate}.`);
  const jcode = treasury.startsWith('57') ? 'CA' : 'BQ';
  const { rows: jt } = await c.query("select id from journals where dossier_id=$1 and code=$2 limit 1", [dossierId, jcode]);
  if (!jt[0]) throw new Error(`Journal ${jcode} absent — initialisez le dossier.`);

  const cpId = pur.counterparty_id ?? await resolveCounterparty(c, dossierId, pur.supplier_name, 'fournisseur');
  const ref = pur.supplier_ref ? ` ${pur.supplier_ref}` : '';
  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy[0].id, journalId: jt[0].id, entryDate: payDate,
    description: `Règlement fournisseur${ref} — ${pur.supplier_name}`, source: 'manual', counterpartyName: pur.supplier_name,
    lines: [
      { accountCode: SUPPLIER_ACCOUNT, counterpartyId: cpId, debit: pur.total_ttc, label: `Règlement${ref} ${pur.supplier_name}` },
      { accountCode: treasury, credit: pur.total_ttc, paymentChannel: opts.channel as any, label: `Règlement${ref} ${pur.supplier_name}` },
    ],
  });

  // Lettre la facture (401 crédit) avec le règlement (401 débit).
  try {
    const { rows: ll } = await c.query(
      `select l.id from entry_lines l
         join accounts a on a.id=l.account_id and a.account_code=$3
        where l.dossier_id=$1 and l.entry_id in ($2, $4)
          and not exists (select 1 from lettrage_lines x where x.entry_line_id=l.id)`,
      [dossierId, pur.entry_id, SUPPLIER_ACCOUNT, entryId]);
    if (ll.length === 2) await createLettrage(c, dossierId, SUPPLIER_ACCOUNT, ll.map((r: any) => r.id));
  } catch { /* lettrage best-effort : le règlement reste valide même si non lettré */ }

  await c.query("update purchase_invoices set status='paid', payment_entry_id=$3 where dossier_id=$1 and id=$2",
    [dossierId, id, entryId]);
  await recordAudit(c, {
    dossierId, action: 'purchase.paid', entity: 'purchase_invoice', entityId: id,
    detail: { supplier: pur.supplier_name, total_ttc: pur.total_ttc, treasury, entryId },
  });
  return { entryId };
}

// Données de démonstration : factures fournisseurs réalistes (contexte CI),
// dans des statuts variés pour illustrer le workflow ET la balance âgée
// (une réglée, plusieurs en cours dont des échues, une brouillon).
export async function seedDemoPurchases(c: Client, dossierId: string): Promise<void> {
  const mk = async (
    p: { supplier: string; ref?: string; date: string; due: string; account: string; label: string; ht: number; vat?: number; axis?: string },
    action: 'draft' | 'recorded' | 'paid',
    pay?: { date: string; treasury: string },
  ) => {
    const { id } = await createPurchase(c, dossierId, {
      supplierName: p.supplier, supplierRef: p.ref, invoiceDate: p.date, dueDate: p.due,
      lines: [{ description: p.label, accountCode: p.account, analyticAxis: p.axis, amountHt: p.ht, vatRate: p.vat ?? 0.18 }],
    });
    if (action === 'draft') return;
    await recordPurchase(c, dossierId, id);
    if (action === 'paid' && pay) await payPurchase(c, dossierId, id, { paymentDate: pay.date, treasuryCode: pay.treasury, channel: 'bank' });
  };

  // Réglée (n'apparaît plus dans la balance âgée)
  await mk({ supplier: 'Grossiste Alibaba Adjamé', ref: 'FA-2026-0182', date: '2026-06-18', due: '2026-07-18', account: '601', label: 'Achat marchandises (lot textile)', ht: 850000, axis: 'COCODY' }, 'paid', { date: '2026-07-05', treasury: '521' });
  // En cours, récentes (0-30 j)
  await mk({ supplier: 'SODECI', ref: 'SOD-074512', date: '2026-06-28', due: '2026-07-28', account: '605', label: "Consommation d'eau — boutique", ht: 45000, axis: 'COCODY' }, 'recorded');
  await mk({ supplier: 'Orange Côte d’Ivoire', ref: 'OCI-2026-9931', date: '2026-07-02', due: '2026-08-02', account: '628', label: 'Abonnement fibre + mobile', ht: 35000, axis: 'YOPOUGON' }, 'recorded');
  // Échues (61-90 j / +90 j) — pour montrer l'ancienneté et l'alerte d'échéance
  await mk({ supplier: 'CIE', ref: 'CIE-556201', date: '2026-05-10', due: '2026-06-10', account: '605', label: 'Électricité — atelier', ht: 120000, axis: 'YOPOUGON' }, 'recorded');
  await mk({ supplier: 'Imprimerie Attoban', ref: 'IMP-0521', date: '2026-04-15', due: '2026-05-15', account: '605', label: 'Impression supports commerciaux', ht: 75000, axis: 'COCODY' }, 'recorded');
  // Loyer exonéré de TVA, échu
  await mk({ supplier: 'SCI Les Palmiers (Cocody)', date: '2026-07-01', due: '2026-07-05', account: '622', label: 'Loyer boutique — juillet', ht: 250000, vat: 0, axis: 'COCODY' }, 'recorded');
  // Brouillon (illustre l'étape de saisie / comptabilisation)
  await mk({ supplier: 'Quincaillerie Marcory', ref: 'QM-2211', date: '2026-07-08', due: '2026-08-08', account: '605', label: 'Petit équipement + fournitures', ht: 60000 }, 'draft');
}

// Balance âgée fournisseurs : encours créditeur non lettré des comptes 40x,
// par tiers, ventilé par ancienneté (mêmes tranches que les relances clients).
export async function supplierAging(c: Client, dossierId: string, asOf?: string): Promise<any[]> {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const { rows } = await c.query(
    `with open as (
       select l.counterparty_id, (l.amount_credit - l.amount_debit) as net,
              ($2::date - coalesce(l.operation_date, e.entry_date)) as age
         from entry_lines l
         join entries e on e.id = l.entry_id and e.status='posted'
         join accounts a on a.id = l.account_id and a.account_code like '40%'
        where l.dossier_id=$1 and l.counterparty_id is not null
          and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
     )
     select o.counterparty_id, cp.name, cp.aux_code,
            sum(net) as balance,
            coalesce(sum(net) filter (where age <= 30),0) as b0_30,
            coalesce(sum(net) filter (where age > 30 and age <= 60),0) as b31_60,
            coalesce(sum(net) filter (where age > 60 and age <= 90),0) as b61_90,
            coalesce(sum(net) filter (where age > 90),0) as b90_plus,
            max(age) as oldest_age
       from open o
       join counterparties cp on cp.id = o.counterparty_id
      group by o.counterparty_id, cp.name, cp.aux_code
     having sum(net) > 0.005
      order by sum(net) desc`,
    [dossierId, ref],
  );
  return rows.map((r: any) => ({
    counterpartyId: r.counterparty_id, name: r.name, auxCode: r.aux_code,
    balance: Number(r.balance), b0_30: Number(r.b0_30), b31_60: Number(r.b31_60),
    b61_90: Number(r.b61_90), b90_plus: Number(r.b90_plus), oldestAge: Number(r.oldest_age),
  }));
}
