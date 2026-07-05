import type { Client } from '../db.js';

// ============================================================================
// Dossier de révision : justification des comptes. Liste les comptes ayant un
// solde (par exercice) avec leur statut de révision (à réviser / justifié) et une
// note. Aide le cabinet à boucler son dossier de travail.
// ============================================================================

// Cycles de révision par classe (regroupement usuel en cabinet).
function cycleOf(classNo: number): string {
  switch (classNo) {
    case 1: return 'Capitaux propres & dettes financières';
    case 2: return 'Immobilisations';
    case 3: return 'Stocks';
    case 4: return 'Tiers';
    case 5: return 'Trésorerie';
    case 6: return 'Charges';
    case 7: return 'Produits';
    default: return 'Autres';
  }
}

export async function revisionReport(c: Client, dossierId: string, fiscalYearId: string) {
  const { rows } = await c.query(
    `select a.account_code, a.label, a.class_no,
            coalesce(sum(l.amount_debit - l.amount_credit), 0) as balance
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted' and e.fiscal_year_id=$2
       join accounts a on a.id = l.account_id
      where l.dossier_id = $1
      group by a.account_code, a.label, a.class_no
     having coalesce(sum(l.amount_debit - l.amount_credit), 0) <> 0
      order by a.account_code`,
    [dossierId, fiscalYearId]);

  const { rows: revs } = await c.query(
    'select account_code, status, note from account_reviews where dossier_id=$1 and fiscal_year_id=$2', [dossierId, fiscalYearId]);
  const revMap = new Map(revs.map((r: any) => [r.account_code, r]));

  const accounts = rows.map((r: any) => {
    const rev: any = revMap.get(r.account_code);
    return {
      account_code: r.account_code, label: r.label, classNo: r.class_no, cycle: cycleOf(r.class_no),
      balance: Number(r.balance), status: rev?.status ?? 'todo', note: rev?.note ?? null,
    };
  });

  const reviewed = accounts.filter((a) => a.status === 'reviewed').length;
  return { accounts, progress: { total: accounts.length, reviewed } };
}

export async function setReview(
  c: Client, dossierId: string, fiscalYearId: string, accountCode: string, patch: { status?: string; note?: string },
): Promise<void> {
  await c.query(
    `insert into account_reviews(dossier_id, fiscal_year_id, account_code, status, note, reviewed_at, reviewed_by)
     values ($1,$2,$3, coalesce($4,'todo'), $5, case when $4='reviewed' then now() else null end, app_current_user_id())
     on conflict (dossier_id, fiscal_year_id, account_code) do update set
       status = coalesce($4, account_reviews.status),
       note = coalesce($5, account_reviews.note),
       reviewed_at = case when $4='reviewed' then now() when $4='todo' then null else account_reviews.reviewed_at end,
       reviewed_by = app_current_user_id()`,
    [dossierId, fiscalYearId, accountCode, patch.status ?? null, patch.note ?? null]);
}
