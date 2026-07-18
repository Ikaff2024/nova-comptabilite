import type { Client } from '../db.js';
import { postEntry, financialStatements } from './accounting.js';

// ============================================================================
// Déclaration de TVA (SYSCOHADA) : collectée (443) - déductible (445)
// = TVA à payer (4441) ou crédit de TVA à reporter (4449).
// La liquidation solde 443/445 et constate le net.
// ============================================================================

export async function vatDeclaration(c: Client, dossierId: string, from: string, to: string) {
  const { rows } = await c.query(
    `select
        coalesce(sum(l.amount_credit - l.amount_debit) filter (where a.account_code like '443%'), 0) as collectee,
        coalesce(sum(l.amount_debit  - l.amount_credit) filter (where a.account_code like '445%'), 0) as deductible
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where l.dossier_id = $1 and e.entry_date between $2 and $3`,
    [dossierId, from, to],
  );
  const collectee = Number(rows[0].collectee);
  const deductible = Number(rows[0].deductible);
  const net = collectee - deductible;

  const { rows: br } = await c.query(
    `select a.account_code, a.label,
            coalesce(sum(l.amount_debit), 0) as debit, coalesce(sum(l.amount_credit), 0) as credit
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where l.dossier_id = $1 and e.entry_date between $2 and $3
        and (a.account_code like '443%' or a.account_code like '445%')
      group by a.account_code, a.label order by a.account_code`,
    [dossierId, from, to],
  );

  return {
    from, to, collectee, deductible,
    netDue: net > 0 ? net : 0,
    creditReportable: net < 0 ? -net : 0,
    breakdown: br.map((r: any) => ({ account_code: r.account_code, label: r.label, debit: Number(r.debit), credit: Number(r.credit) })),
  };
}

export async function postVatLiquidation(c: Client, dossierId: string, from: string, to: string, date: string) {
  const d = await vatDeclaration(c, dossierId, from, to);
  if (d.collectee === 0 && d.deductible === 0) throw new Error('Aucune TVA sur la période.');

  const { rows: fy } = await c.query(
    "select id from fiscal_years where dossier_id=$1 and status<>'closed' and $2 between start_date and end_date order by start_date limit 1",
    [dossierId, date]);
  if (!fy[0]) throw new Error("Aucun exercice ouvert pour cette date.");
  const { rows: jo } = await c.query(
    "select id from journals where dossier_id=$1 and (code='OD' or type='operations_diverses') limit 1", [dossierId]);
  if (!jo[0]) throw new Error("Journal OD absent — initialisez le dossier.");

  const lines: any[] = [];
  if (d.collectee > 0) lines.push({ accountCode: '443', debit: d.collectee, label: 'TVA collectée' });
  if (d.deductible > 0) lines.push({ accountCode: '445', credit: d.deductible, label: 'TVA déductible' });
  const net = d.collectee - d.deductible;
  if (net > 0) lines.push({ accountCode: '4441', credit: net, label: 'TVA due' });
  else if (net < 0) lines.push({ accountCode: '4449', debit: -net, label: 'Crédit de TVA à reporter' });

  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy[0].id, journalId: jo[0].id, entryDate: date,
    description: `Déclaration TVA du ${from} au ${to}`, source: 'manual', lines,
  });
  return { entryId, ...d };
}

// ============================================================================
// Estimation de l'impôt sur les bénéfices (IS) & de l'IMF — barème Côte d'Ivoire
// (CGI). Indicatif : calculé sur le résultat COMPTABLE, avant réintégrations et
// déductions fiscales. Sert à provisionner l'impôt et anticiper les acomptes.
// ============================================================================

export interface ISParams {
  tauxIS: number;        // taux de droit commun (CI : 25 %)
  tauxIMF: number;       // taux de l'impôt minimum forfaitaire (CI : 0,5 % du CA)
  imfPlancher: number;   // IMF minimum (CI : 3 000 000 F)
  imfPlafond: number;    // IMF maximum (CI : 35 000 000 F)
}
export const IS_CI: ISParams = { tauxIS: 0.25, tauxIMF: 0.005, imfPlancher: 3_000_000, imfPlafond: 35_000_000 };

export async function estimationIS(c: Client, dossierId: string, fiscalYearId?: string, p: ISParams = IS_CI) {
  const fs: any = await financialStatements(c, dossierId, fiscalYearId);
  const is = fs.incomeStatement;
  const chiffreAffaires = (is.sig ?? []).find((s: any) => s.label === "Chiffre d'affaires")?.amount ?? 0;
  const resultatComptable: number = is.resultatNet;
  const beneficeImposable = Math.max(0, resultatComptable);

  const isTheorique = beneficeImposable * p.tauxIS;
  const imf = Math.min(p.imfPlafond, Math.max(p.imfPlancher, chiffreAffaires * p.tauxIMF));
  const beneficiaire = resultatComptable > 0;
  const impotDu = beneficiaire ? Math.max(isTheorique, imf) : imf;
  const base = !beneficiaire ? 'IMF (résultat déficitaire)' : isTheorique >= imf ? 'IS (25 % du bénéfice)' : 'IMF (supérieur à l\'IS)';
  // Acomptes provisionnels CI : 3 fractions égales (avril, juin, septembre) = 1/3 de l'impôt N-1.
  const acompte = impotDu / 3;

  return {
    fiscalYearId: fiscalYearId ?? null,
    chiffreAffaires, resultatComptable, beneficeImposable, beneficiaire,
    tauxIS: p.tauxIS, isTheorique,
    tauxIMF: p.tauxIMF, imf, imfPlancher: p.imfPlancher, imfPlafond: p.imfPlafond,
    impotDu, baseRetenue: base, acompteProvisionnel: acompte,
    note: "Estimation indicative sur le résultat comptable, avant réintégrations/déductions fiscales. Barème Côte d'Ivoire (CGI) : IS 25 %, IMF 0,5 % du CA (min 3 M, plafond 35 M F). À valider avec un fiscaliste.",
  };
}
