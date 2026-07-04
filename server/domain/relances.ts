import type { Client } from '../db.js';

// ============================================================================
// Relances clients : créances échues non réglées (postes non lettrés au débit
// d'un compte 41x), ventilées par ancienneté, avec le niveau de relance atteint.
// ============================================================================

export async function overdueClients(c: Client, dossierId: string, asOf?: string): Promise<any[]> {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const { rows } = await c.query(
    `with open as (
       select l.counterparty_id, (l.amount_debit - l.amount_credit) as net,
              ($2::date - e.entry_date) as age
         from entry_lines l
         join entries e on e.id = l.entry_id and e.status = 'posted'
         join accounts a on a.id = l.account_id and a.account_code like '41%'
        where l.dossier_id = $1 and l.counterparty_id is not null
          and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
     )
     select o.counterparty_id, cp.name, cp.aux_code,
            sum(net) as balance,
            coalesce(sum(net) filter (where age <= 30), 0) as b0_30,
            coalesce(sum(net) filter (where age > 30 and age <= 60), 0) as b31_60,
            coalesce(sum(net) filter (where age > 60 and age <= 90), 0) as b61_90,
            coalesce(sum(net) filter (where age > 90), 0) as b90_plus,
            max(age) as oldest_age
       from open o
       join counterparties cp on cp.id = o.counterparty_id
      group by o.counterparty_id, cp.name, cp.aux_code
     having sum(net) > 0.005
      order by sum(net) desc`,
    [dossierId, ref],
  );

  const { rows: rel } = await c.query(
    `select distinct on (counterparty_id) counterparty_id, level, to_char(sent_at,'YYYY-MM-DD') as sent_at
       from relances where dossier_id = $1 order by counterparty_id, sent_at desc`,
    [dossierId],
  );
  const relMap = new Map(rel.map((r: any) => [r.counterparty_id, r]));

  return rows.map((r: any) => {
    const last: any = relMap.get(r.counterparty_id);
    return {
      counterpartyId: r.counterparty_id, name: r.name, auxCode: r.aux_code,
      balance: Number(r.balance), b0_30: Number(r.b0_30), b31_60: Number(r.b31_60),
      b61_90: Number(r.b61_90), b90_plus: Number(r.b90_plus), oldestAge: Number(r.oldest_age),
      lastLevel: last ? Number(last.level) : 0, lastSentAt: last ? last.sent_at : null,
    };
  });
}

// Détail pour la lettre de relance : postes ouverts d'un client + niveau suggéré.
export async function relanceLetter(c: Client, dossierId: string, counterpartyId: string, asOf?: string): Promise<any> {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const { rows: cp } = await c.query('select name, aux_code from counterparties where dossier_id=$1 and id=$2', [dossierId, counterpartyId]);
  if (!cp[0]) throw new Error('Client introuvable.');

  const { rows: items } = await c.query(
    `select to_char(e.entry_date,'YYYY-MM-DD') as date, e.piece_ref,
            coalesce(l.label, e.description) as label,
            (l.amount_debit - l.amount_credit) as net,
            ($3::date - e.entry_date) as age
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id and a.account_code like '41%'
      where l.dossier_id = $1 and l.counterparty_id = $2
        and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
      order by e.entry_date`,
    [dossierId, counterpartyId, ref],
  );
  const open = items.map((r: any) => ({ date: r.date, piece_ref: r.piece_ref, label: r.label, amount: Number(r.net), age: Number(r.age) }))
    .filter((r: any) => Math.abs(r.amount) > 0.005);
  const total = open.reduce((s: number, r: any) => s + r.amount, 0);

  const { rows: rel } = await c.query(
    'select level from relances where dossier_id=$1 and counterparty_id=$2 order by sent_at desc limit 1', [dossierId, counterpartyId]);
  const suggestedLevel = (rel[0] ? Number(rel[0].level) : 0) + 1;

  return { name: cp[0].name, auxCode: cp[0].aux_code, asOf: ref, open, total: Math.round(total * 100) / 100, suggestedLevel };
}

export async function recordRelance(
  c: Client, dossierId: string, counterpartyId: string, level: number, amount: number, asOf?: string, note?: string,
): Promise<{ id: string; level: number }> {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const { rows } = await c.query(
    `insert into relances(dossier_id, counterparty_id, level, amount, as_of, note, created_by)
     values ($1,$2,$3,$4,$5,$6, app_current_user_id()) returning id, level`,
    [dossierId, counterpartyId, level, amount, ref, note ?? null],
  );
  return { id: rows[0].id, level: Number(rows[0].level) };
}
