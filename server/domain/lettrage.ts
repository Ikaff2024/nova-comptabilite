import type { Client } from '../db.js';
import { carryForwardFiscalYears, NOT_CARRY_FORWARD } from './carryforward.js';

// ============================================================================
// Lettrage des comptes de tiers + balance âgée.
// Le lettrage est stocké hors du ledger immuable (tables lettrages/lettrage_lines).
//
// Ces vues raisonnent en POSTES OUVERTS, hors bornes d'exercice : elles écartent
// donc les à-nouveaux de report, qui dupliqueraient les pièces d'origine
// (cf. domain/carryforward.ts). Une facture impayée reste un poste ouvert avec
// sa date et son ancienneté réelles, même après la clôture de son exercice.
// ============================================================================

// Code lettre séquentiel : 1->A, 26->Z, 27->AA…
function letterCode(n: number): string {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Comptes de tiers (classe 4) ayant des mouvements — pour le sélecteur.
export async function tiersAccounts(c: Client, dossierId: string): Promise<any[]> {
  const cf = await carryForwardFiscalYears(c, dossierId);
  const { rows } = await c.query(
    `select a.account_code, a.label,
            count(*) filter (where not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
                               and ${NOT_CARRY_FORWARD(2)}) as open_count
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id and a.class_no = 4
      where l.dossier_id = $1
      group by a.account_code, a.label
      order by a.account_code`,
    [dossierId, cf],
  );
  return rows.map((r: any) => ({ account_code: r.account_code, label: r.label, open_count: Number(r.open_count) }));
}

// Pièces non lettrées d'un compte (open items) + lettrages existants.
export async function accountLettrageView(c: Client, dossierId: string, accountCode: string): Promise<any> {
  const cf = await carryForwardFiscalYears(c, dossierId);
  const { rows: open } = await c.query(
    `select l.id as entry_line_id, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date,
            j.code as journal_code, e.piece_ref, coalesce(l.label, e.description) as label,
            l.amount_debit as debit, l.amount_credit as credit
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id
      where l.dossier_id = $1 and a.account_code = $2
        and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
        and ${NOT_CARRY_FORWARD(3)}
      order by e.entry_date, e.created_at`,
    [dossierId, accountCode, cf],
  );
  const { rows: lettered } = await c.query(
    `select le.id, le.code,
            to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.piece_ref,
            coalesce(l.label, e.description) as label, l.amount_debit as debit, l.amount_credit as credit
       from lettrages le
       join lettrage_lines ll on ll.lettrage_id = le.id
       join entry_lines l on l.id = ll.entry_line_id
       join entries e on e.id = l.entry_id
       join accounts a on a.id = le.account_id
      where le.dossier_id = $1 and a.account_code = $2
      order by le.code, e.entry_date`,
    [dossierId, accountCode],
  );
  return {
    open: open.map((r: any) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) })),
    lettered: lettered.map((r: any) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) })),
  };
}

// Crée un lettrage : les lignes doivent appartenir au compte, non lettrées, et équilibrées.
export async function createLettrage(
  c: Client, dossierId: string, accountCode: string, lineIds: string[],
): Promise<{ id: string; code: string }> {
  if (!lineIds || lineIds.length < 2) throw new Error('Sélectionnez au moins 2 lignes à rapprocher.');
  const { rows: acc } = await c.query('select id from accounts where dossier_id=$1 and account_code=$2', [dossierId, accountCode]);
  if (!acc[0]) throw new Error('Compte introuvable');
  const accountId = acc[0].id;

  const { rows: lines } = await c.query(
    `select l.id, l.amount_debit, l.amount_credit
       from entry_lines l
      where l.id = any($1) and l.dossier_id = $2 and l.account_id = $3
        and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)`,
    [lineIds, dossierId, accountId],
  );
  if (lines.length !== lineIds.length) throw new Error('Certaines lignes sont invalides ou déjà lettrées.');
  const debit = lines.reduce((s: number, l: any) => s + Number(l.amount_debit), 0);
  const credit = lines.reduce((s: number, l: any) => s + Number(l.amount_credit), 0);
  if (Math.abs(debit - credit) > 0.001) throw new Error(`Rapprochement non équilibré (débit ${debit} ≠ crédit ${credit}).`);

  const { rows: cnt } = await c.query('select count(*) n from lettrages where dossier_id=$1 and account_id=$2', [dossierId, accountId]);
  const code = letterCode(Number(cnt[0].n) + 1);

  const { rows: ins } = await c.query(
    'insert into lettrages(dossier_id, account_id, code) values ($1,$2,$3) returning id',
    [dossierId, accountId, code],
  );
  const lettrageId = ins[0].id;
  for (const id of lineIds) {
    await c.query('insert into lettrage_lines(lettrage_id, entry_line_id, dossier_id) values ($1,$2,$3)', [lettrageId, id, dossierId]);
  }
  return { id: lettrageId, code };
}

export async function deleteLettrage(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from lettrages where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Lettrage automatique ----------------------------------------------------
// Rapproche, PAR TIERS, les lignes non lettrées qui s'annulent : paires exactes
// (une facture ↔ un règlement de même montant) et règlements échelonnés
// (une facture ↔ plusieurs règlements dont la somme égale la facture, et inversement).

const round2 = (n: number) => Math.round(n * 100) / 100;

interface OpenLine { id: string; net: number } // net = débit - crédit

// Renvoie les groupes de lignes (ids) qui s'équilibrent au sein d'un tiers.
function matchGroups(lines: OpenLine[]): string[][] {
  const groups: string[][] = [];
  const used = new Set<string>();
  const debits = lines.filter((l) => l.net > 0).sort((a, b) => b.net - a.net);
  const credits = lines.filter((l) => l.net < 0).sort((a, b) => a.net - b.net); // plus négatif d'abord

  // 1) Paires exactes 1:1 (montant identique)
  for (const d of debits) {
    if (used.has(d.id)) continue;
    const m = credits.find((cr) => !used.has(cr.id) && round2(d.net + cr.net) === 0);
    if (m) { used.add(d.id); used.add(m.id); groups.push([d.id, m.id]); }
  }
  // 2) Une facture ↔ plusieurs règlements (et l'inverse) : accumulation exacte
  const accumulate = (anchors: OpenLine[], others: OpenLine[]) => {
    for (const a of anchors) {
      if (used.has(a.id)) continue;
      const target = Math.abs(a.net);
      const picked: string[] = []; let sum = 0;
      for (const o of others) {
        if (used.has(o.id)) continue;
        const v = Math.abs(o.net);
        if (round2(sum + v) > target + 0.005) continue;
        picked.push(o.id); sum = round2(sum + v);
        if (round2(sum) === round2(target)) break;
      }
      if (round2(sum) === round2(target) && picked.length > 0) {
        used.add(a.id); picked.forEach((id) => used.add(id));
        groups.push([a.id, ...picked]);
      }
    }
  };
  accumulate(debits, credits); // facture payée en plusieurs fois
  accumulate(credits, debits); // avoir/acompte imputé sur plusieurs factures
  return groups;
}

export async function autoLettrage(
  c: Client, dossierId: string, accountCode?: string,
): Promise<{ groups: number; linesLettered: number }> {
  const params: any[] = [dossierId];
  let filter = '';
  if (accountCode) { params.push(accountCode); filter = ` and a.account_code = $${params.length}`; }
  params.push(await carryForwardFiscalYears(c, dossierId));
  const { rows } = await c.query(
    `select l.id, a.account_code, l.counterparty_id,
            (l.amount_debit - l.amount_credit) as net
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id and a.class_no = 4
      where l.dossier_id = $1${filter}
        and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
        and ${NOT_CARRY_FORWARD(params.length)}
      order by e.entry_date, e.created_at`,
    params,
  );

  // Partition par (compte, tiers) — on ne lettre jamais entre deux tiers différents.
  const parts = new Map<string, { accountCode: string; lines: OpenLine[] }>();
  for (const r of rows) {
    const net = round2(Number(r.net));
    if (net === 0) continue;
    const key = `${r.account_code}|${r.counterparty_id ?? 'none'}`;
    if (!parts.has(key)) parts.set(key, { accountCode: r.account_code, lines: [] });
    parts.get(key)!.lines.push({ id: r.id, net });
  }

  let groups = 0, linesLettered = 0;
  for (const part of parts.values()) {
    for (const ids of matchGroups(part.lines)) {
      await createLettrage(c, dossierId, part.accountCode, ids);
      groups++; linesLettered += ids.length;
    }
  }
  return { groups, linesLettered };
}

// Balance âgée : encours non lettré par compte de tiers, ventilé par ancienneté.
export async function agedBalance(c: Client, dossierId: string, asOf?: string): Promise<any[]> {
  const ref = asOf || new Date().toISOString().slice(0, 10);
  const cf = await carryForwardFiscalYears(c, dossierId);
  const { rows } = await c.query(
    `with open as (
       select a.account_code, a.label, (l.amount_debit - l.amount_credit) as net,
              ($2::date - coalesce(l.operation_date, e.entry_date)) as age
         from entry_lines l
         join entries e on e.id = l.entry_id and e.status='posted'
         join accounts a on a.id = l.account_id and a.class_no = 4
        where l.dossier_id = $1
          and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)
          and ${NOT_CARRY_FORWARD(3)}
     )
     select account_code, label,
            sum(net) as balance,
            sum(net) filter (where age <= 30) as b0_30,
            sum(net) filter (where age > 30 and age <= 60) as b31_60,
            sum(net) filter (where age > 60 and age <= 90) as b61_90,
            sum(net) filter (where age > 90) as b90_plus
       from open
      group by account_code, label
     having sum(net) <> 0
      order by account_code`,
    [dossierId, ref, cf],
  );
  return rows.map((r: any) => ({
    account_code: r.account_code, label: r.label,
    balance: Number(r.balance), b0_30: Number(r.b0_30 ?? 0), b31_60: Number(r.b31_60 ?? 0),
    b61_90: Number(r.b61_90 ?? 0), b90_plus: Number(r.b90_plus ?? 0),
  }));
}
