import type { Client } from '../db.js';

// ============================================================================
// Comptabilité auxiliaire : plan des tiers, balance tiers, grand livre tiers.
// ============================================================================

export async function listCounterparties(c: Client, dossierId: string, type?: string): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'cp.dossier_id = $1';
  if (type) { params.push(type); where += ` and cp.type = $${params.length}`; }
  const { rows } = await c.query(
    `select cp.id, cp.type, cp.name, cp.aux_code, cp.tax_id, cp.email,
            a.account_code as collective
       from counterparties cp
       left join accounts a on a.id = cp.account_id
      where ${where}
      order by cp.type, cp.name`,
    params,
  );
  return rows;
}

const COLL: Record<string, string> = { client: '411', fournisseur: '401', salarie: '421' };

export async function createCounterparty(
  c: Client, dossierId: string, input: { type: string; name: string; auxCode?: string; taxId?: string; email?: string },
): Promise<any> {
  const type = input.type || 'client';
  if (!input.name?.trim()) throw new Error('Nom requis');
  const collCode = COLL[type] ?? null;
  let accId: string | null = null;
  if (collCode) {
    const { rows } = await c.query('select id from accounts where dossier_id=$1 and account_code=$2', [dossierId, collCode]);
    accId = rows[0]?.id ?? null;
  }
  let aux = input.auxCode?.trim();
  if (!aux) {
    const { rows: cnt } = await c.query('select count(*) n from counterparties where dossier_id=$1 and type=$2', [dossierId, type]);
    aux = (collCode ?? 'TIER') + String(Number(cnt[0].n) + 1).padStart(4, '0');
  }
  const { rows } = await c.query(
    'insert into counterparties(dossier_id, type, name, aux_code, tax_id, email, account_id) values ($1,$2,$3,$4,$5,$6,$7) returning id, type, name, aux_code, tax_id, email',
    [dossierId, type, input.name.trim(), aux, input.taxId ?? null, input.email?.trim() || null, accId],
  );
  return rows[0];
}

export async function updateCounterparty(
  c: Client, dossierId: string, id: string, input: { name?: string; auxCode?: string; taxId?: string; email?: string },
): Promise<void> {
  await c.query(
    `update counterparties set
       name = coalesce($3, name),
       aux_code = coalesce($4, aux_code),
       tax_id = coalesce($5, tax_id),
       email = coalesce($6, email)
     where dossier_id=$1 and id=$2`,
    [dossierId, id, input.name ?? null, input.auxCode ?? null, input.taxId ?? null, input.email ?? null],
  );
}

export async function deleteCounterparty(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from counterparties where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Balance auxiliaire : un solde par tiers.
export async function auxiliaryBalance(c: Client, dossierId: string, type?: string): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'cp.dossier_id = $1';
  if (type) { params.push(type); where += ` and cp.type = $${params.length}`; }
  const { rows } = await c.query(
    `select cp.id, cp.aux_code, cp.name, cp.type, coalesce(a.account_code, '') as collective,
            coalesce(sum(l.amount_debit)  filter (where e.id is not null), 0) as debit,
            coalesce(sum(l.amount_credit) filter (where e.id is not null), 0) as credit,
            coalesce(sum(l.amount_debit - l.amount_credit) filter (where e.id is not null), 0) as balance
       from counterparties cp
       left join entry_lines l on l.counterparty_id = cp.id
       left join entries e on e.id = l.entry_id and e.status = 'posted'
       left join accounts a on a.id = cp.account_id
      where ${where}
      group by cp.id, cp.aux_code, cp.name, cp.type, a.account_code
      order by cp.type, cp.name`,
    params,
  );
  return rows.map((r: any) => ({
    id: r.id, aux_code: r.aux_code, name: r.name, type: r.type, collective: r.collective,
    debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.balance),
  }));
}

// Grand livre auxiliaire : mouvements d'un tiers.
export async function auxiliaryLedger(c: Client, dossierId: string, counterpartyId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, j.code as journal_code, e.piece_ref,
            a.account_code, coalesce(l.label, e.description) as label,
            l.amount_debit as debit, l.amount_credit as credit
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id
      where l.dossier_id = $1 and l.counterparty_id = $2
      order by e.entry_date, e.created_at`,
    [dossierId, counterpartyId],
  );
  return rows.map((r: any) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) }));
}
