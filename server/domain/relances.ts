import type { Client } from '../db.js';
import { tablePdf } from '../documents/pdf.js';
import { carryForwardFiscalYears, NOT_CARRY_FORWARD } from './carryforward.js';

// ============================================================================
// Relances clients : créances échues non réglées (postes non lettrés au débit
// d'un compte 41x), ventilées par ancienneté, avec le niveau de relance atteint.
// ============================================================================

const grp = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const esc = (s: string) => (s || '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] as string));

// Relevé de compte (postes ouverts) d'un client en PDF.
export async function releveClientPdf(c: Client, dossierId: string, counterpartyId: string, asOf?: string): Promise<{ filename: string; buffer: Buffer; letter: any; cur: string }> {
  const { rows: dr } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = dr[0]?.j ?? {};
  const cur = d.base_currency ?? 'XOF';
  const money = (n: number) => `${grp(n)} ${cur}`;
  const letter = await relanceLetter(c, dossierId, counterpartyId, asOf);
  const meta = [`${d.raison_sociale ?? ''}`];
  if (d.tax_id || d.rccm) meta.push([d.tax_id ? `NCC/IFU : ${d.tax_id}` : '', d.rccm ? `RCCM : ${d.rccm}` : ''].filter(Boolean).join(' · '));
  const buffer = await tablePdf({
    title: `Relevé de compte — ${letter.name}`, subtitle: `${d.raison_sociale ?? ''} · au ${letter.asOf}`, meta,
    columns: [{ label: 'Date', width: 62 }, { label: 'Pièce', width: 70 }, { label: 'Libellé', width: 170 }, { label: 'Ancienneté', width: 62, align: 'right' }, { label: 'Montant', width: 82, align: 'right' }],
    rows: letter.open.map((o: any) => [o.date, o.piece_ref ?? '', String(o.label ?? '').slice(0, 46), `${o.age} j`, money(o.amount)]),
    totals: ['', '', '', 'TOTAL DÛ', money(letter.total)],
    footNote: `${letter.open.length} poste(s) ouvert(s). Relevé généré par Nova.`,
  });
  return { filename: `releve-${(letter.auxCode || letter.name || 'client').replace(/\W+/g, '-')}.pdf`, buffer, letter, cur };
}

// Corps d'email de relance, ton selon le niveau (1 rappel · 2 relance · 3+ mise en demeure).
export function relanceEmailBody(letter: any, level: number, cur: string): { subject: string; html: string } {
  const money = (n: number) => `${grp(n)} ${cur}`;
  const intro = level <= 1
    ? "Sauf erreur de notre part, nous constatons que les factures ci-dessous demeurent impayées à ce jour. Nous vous serions reconnaissants de bien vouloir procéder à leur règlement."
    : level === 2
      ? "Malgré notre précédent rappel, les factures ci-dessous restent impayées. Nous vous demandons de régulariser votre situation sans délai."
      : "En dépit de nos relances, votre compte présente toujours les impayés ci-dessous. La présente vaut MISE EN DEMEURE de régler sous huitaine, à défaut de quoi nous serions contraints d'engager les voies de recouvrement.";
  const subject = level <= 1 ? `Rappel — factures échues (${letter.name})` : level === 2 ? `Relance — factures impayées (${letter.name})` : `Mise en demeure — factures impayées (${letter.name})`;
  const rows = letter.open.map((o: any) => `<tr><td style="padding:4px 8px">${o.date}</td><td style="padding:4px 8px">${esc(o.piece_ref ?? '')}</td><td style="padding:4px 8px">${esc(o.label ?? '')}</td><td style="padding:4px 8px;text-align:right">${money(o.amount)}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
    <p>Bonjour,</p>
    <p>${intro}</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#f0f0f0"><th style="padding:4px 8px;text-align:left">Date</th><th style="padding:4px 8px;text-align:left">Pièce</th><th style="padding:4px 8px;text-align:left">Libellé</th><th style="padding:4px 8px;text-align:right">Montant</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="font-weight:bold;border-top:2px solid #ccc"><td colspan="3" style="padding:6px 8px">Total dû au ${letter.asOf}</td><td style="padding:6px 8px;text-align:right">${money(letter.total)}</td></tr></tfoot>
    </table>
    <p>Vous trouverez le relevé de compte détaillé en pièce jointe. Si ce règlement a été effectué entretemps, merci de ne pas tenir compte de ce message.</p>
    <p>Cordialement,<br/>Le service comptable</p>
  </div>`;
  return { subject, html };
}

export async function overdueClients(c: Client, dossierId: string, asOf?: string): Promise<any[]> {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const cf = await carryForwardFiscalYears(c, dossierId);
  const { rows } = await c.query(
    `with open as (
       select l.counterparty_id, (l.amount_debit - l.amount_credit) as net,
              ($2::date - coalesce(l.operation_date, e.entry_date)) as age
         from entry_lines l
         join entries e on e.id = l.entry_id and e.status = 'posted'
         join accounts a on a.id = l.account_id and a.account_code like '41%'
        where l.dossier_id = $1 and l.counterparty_id is not null
          and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
          and ${NOT_CARRY_FORWARD(3)}
     )
     select o.counterparty_id, cp.name, cp.aux_code, cp.email,
            sum(net) as balance,
            coalesce(sum(net) filter (where age <= 30), 0) as b0_30,
            coalesce(sum(net) filter (where age > 30 and age <= 60), 0) as b31_60,
            coalesce(sum(net) filter (where age > 60 and age <= 90), 0) as b61_90,
            coalesce(sum(net) filter (where age > 90), 0) as b90_plus,
            max(age) as oldest_age
       from open o
       join counterparties cp on cp.id = o.counterparty_id
      group by o.counterparty_id, cp.name, cp.aux_code, cp.email
     having sum(net) > 0.005
      order by sum(net) desc`,
    [dossierId, ref, cf],
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
      counterpartyId: r.counterparty_id, name: r.name, auxCode: r.aux_code, email: r.email ?? null,
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
            ($3::date - coalesce(l.operation_date, e.entry_date)) as age
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id and a.account_code like '41%'
      where l.dossier_id = $1 and l.counterparty_id = $2
        and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
        and ${NOT_CARRY_FORWARD(4)}
      order by e.entry_date`,
    [dossierId, counterpartyId, ref, await carryForwardFiscalYears(c, dossierId)],
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
