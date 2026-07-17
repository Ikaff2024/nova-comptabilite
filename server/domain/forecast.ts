import type { Client } from '../db.js';
import { occurrenceDates } from './recurring.js';

// ============================================================================
// Prévisionnel de trésorerie : projette le solde de trésorerie sur un horizon,
// à partir de la position actuelle (classe 5), des créances clients et dettes
// fournisseurs non lettrées (attendues à échéance), et des écritures récurrentes.
// Lecture pure — aucune écriture.
// ============================================================================

const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
// Lundi de la semaine d'une date.
function weekStart(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // 0 = lundi
  return addDays(x, -dow);
}

interface Flow { date: string; label: string; amount: number; kind: 'receivable' | 'payable' | 'recurring' }

export async function cashForecast(
  c: Client, dossierId: string, opts: { horizonWeeks?: number; delayDays?: number } = {},
) {
  const horizonWeeks = Math.min(Math.max(opts.horizonWeeks ?? 13, 4), 52);
  const delayDays = opts.delayDays ?? 30;
  const today = new Date();
  const todayISO = iso(today);
  const horizonEnd = addDays(weekStart(today), horizonWeeks * 7);

  // --- Position de trésorerie actuelle (classe 5) ---
  const { rows: bal } = await c.query(
    `select coalesce(sum(l.amount_debit - l.amount_credit),0) as cash
       from entry_lines l
       join entries e on e.id=l.entry_id and e.status='posted'
       join accounts a on a.id=l.account_id and a.class_no=5
      where l.dossier_id=$1`, [dossierId]);
  const currentCash = round2(Number(bal[0].cash));

  const flows: Flow[] = [];

  // --- Créances (41x) & dettes (40x) non lettrées, attendues à échéance ---
  const { rows: open } = await c.query(
    `select a.account_code, coalesce(cp.name, e.description) as name,
            to_char(e.entry_date,'YYYY-MM-DD') as date, (l.amount_debit - l.amount_credit) as net
       from entry_lines l
       join entries e on e.id=l.entry_id and e.status='posted'
       join accounts a on a.id=l.account_id and (a.account_code like '41%' or a.account_code like '40%')
       left join counterparties cp on cp.id=l.counterparty_id
      where l.dossier_id=$1
        and not exists (select 1 from lettrage_lines ll where ll.entry_line_id=l.id)`, [dossierId]);
  for (const r of open) {
    const net = round2(Number(r.net));
    if (net === 0) continue;
    const due = iso(addDays(new Date(r.date), delayDays));
    const date = due < todayISO ? todayISO : due; // en retard -> attendu immédiatement
    const receivable = r.account_code.startsWith('41');
    flows.push({ date, label: `${receivable ? 'Encaissement' : 'Décaissement'} ${r.name ?? ''}`.trim(), amount: net, kind: receivable ? 'receivable' : 'payable' });
  }

  // --- Écritures récurrentes : effet trésorerie des occurrences à venir ---
  const { rows: tpls } = await c.query(
    "select label, frequency, day_of_month, start_date, end_date, lines from recurring_templates where dossier_id=$1 and active=true", [dossierId]);
  for (const t of tpls) {
    const net5 = round2((t.lines as any[]).reduce((s, l) => s + (l.accountCode?.startsWith('5') ? (Number(l.debit) || 0) - (Number(l.credit) || 0) : 0), 0));
    if (net5 === 0) continue;
    for (const d of occurrenceDates(t, iso(horizonEnd))) {
      if (d < todayISO) continue;
      flows.push({ date: d, label: t.label, amount: net5, kind: 'recurring' });
    }
  }

  // --- Événements : obligations déclaratives (sans montant) ---
  const { rows: obs } = await c.query('select label, periodicity, due_day, due_month from obligations where dossier_id=$1 and active=true', [dossierId]);
  const events: { date: string; label: string }[] = [];
  // (échéance calculée simplement : prochaine occurrence du jour dans l'horizon)
  for (const o of obs) {
    let probe = weekStart(today);
    for (let i = 0; i < horizonWeeks * 7 + 31; i++) {
      const d = addDays(probe, i);
      if (d > horizonEnd) break;
      const day = d.getUTCDate(), mon = d.getUTCMonth() + 1;
      const dayOk = day === Math.min(o.due_day, new Date(Date.UTC(d.getUTCFullYear(), mon, 0)).getUTCDate());
      const periodOk = o.periodicity === 'monthly'
        || (o.periodicity === 'quarterly' && [1, 4, 7, 10].includes(mon))
        || (o.periodicity === 'annual' && mon === (o.due_month ?? 1));
      if (dayOk && periodOk && iso(d) >= todayISO) { events.push({ date: iso(d), label: o.label }); break; }
    }
  }

  // --- Agrégation par semaine ---
  const weeks: { weekStart: string; inflows: number; outflows: number; net: number; balance: number }[] = [];
  let running = currentCash;
  let minBalance = currentCash, minWeek = iso(weekStart(today));
  for (let w = 0; w < horizonWeeks; w++) {
    const ws = addDays(weekStart(today), w * 7);
    const we = addDays(ws, 7);
    const wsISO = iso(ws), weISO = iso(we);
    let inflows = 0, outflows = 0;
    for (const f of flows) {
      if (f.date >= wsISO && f.date < weISO) { if (f.amount >= 0) inflows += f.amount; else outflows += f.amount; }
    }
    inflows = round2(inflows); outflows = round2(outflows);
    running = round2(running + inflows + outflows);
    if (running < minBalance) { minBalance = running; minWeek = wsISO; }
    weeks.push({ weekStart: wsISO, inflows, outflows, net: round2(inflows + outflows), balance: running });
  }

  // Prochains mouvements marquants (triés par date)
  const upcoming = flows
    .filter((f) => f.date >= todayISO && new Date(f.date) <= horizonEnd)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 30);

  return {
    currentCash,
    projectedBalance: weeks.length ? weeks[weeks.length - 1].balance : currentCash,
    minBalance: round2(minBalance), minWeek,
    horizonWeeks, delayDays,
    weeks, upcoming, events: events.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// --- Échéancier : créances à encaisser + dettes à payer, par date d'échéance --
// Basé sur les factures (dates d'échéance RÉELLES) non réglées. Calendrier
// actionnable de recouvrement / paiement, distinct de la prévision hebdomadaire.
export async function echeancier(c: Client, dossierId: string): Promise<any> {
  const today = new Date().toISOString().slice(0, 10);
  const { rows: cre } = await c.query(
    `select client_name as tiers, number as piece, to_char(due_date,'YYYY-MM-DD') as echeance,
            to_char(invoice_date,'YYYY-MM-DD') as date, total_ttc as montant
       from invoices where dossier_id=$1 and doc_type='invoice' and status='issued'
      order by due_date nulls last, invoice_date`, [dossierId]);
  const { rows: det } = await c.query(
    `select supplier_name as tiers, supplier_ref as piece, to_char(due_date,'YYYY-MM-DD') as echeance,
            to_char(invoice_date,'YYYY-MM-DD') as date, total_ttc as montant
       from purchase_invoices where dossier_id=$1 and status='recorded'
      order by due_date nulls last, invoice_date`, [dossierId]);
  const enrich = (r: any) => {
    const ech = r.echeance || r.date;
    const jours = ech ? Math.round((new Date(ech + 'T00:00:00Z').getTime() - new Date(today + 'T00:00:00Z').getTime()) / 86400000) : null;
    const statut = jours == null ? 'sans échéance' : jours < 0 ? `échu (+${-jours} j)` : jours === 0 ? "aujourd'hui" : `dans ${jours} j`;
    return { tiers: r.tiers, piece: r.piece || null, date: r.date, echeance: ech, montant: Math.round(Number(r.montant)), jours, statut, echu: jours != null && jours < 0 };
  };
  const creances = cre.map(enrich), dettes = det.map(enrich);
  const sum = (a: any[]) => Math.round(a.reduce((s, x) => s + x.montant, 0));
  const upto = (a: any[], hi: number) => Math.round(a.filter((x) => x.jours != null && x.jours <= hi).reduce((s, x) => s + x.montant, 0));
  return {
    creances, dettes,
    resume: {
      total_a_encaisser: sum(creances), total_a_payer: sum(dettes),
      creances_echues: sum(creances.filter((x: any) => x.echu)), dettes_echues: sum(dettes.filter((x: any) => x.echu)),
      a_encaisser_30j: upto(creances, 30), a_payer_30j: upto(dettes, 30),
      solde_net_30j: upto(creances, 30) - upto(dettes, 30),
    },
  };
}
