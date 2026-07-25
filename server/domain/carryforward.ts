import type { Client } from '../db.js';

// ============================================================================
// À-nouveaux de report : deux lectures cohabitent en comptabilité, et elles ne
// se calculent pas sur la même assiette.
//
//  1. La lecture PAR EXERCICE (balance, compte de résultat) : on filtre sur
//     fiscal_year_id. Les à-nouveaux font partie de l'exercice qu'ils ouvrent.
//
//  2. La lecture CUMULÉE, qui ignore les bornes d'exercice (position de
//     trésorerie à date, encours non lettré d'un tiers, balance âgée) : là, les
//     à-nouveaux générés par une clôture SONT UN DOUBLON — ils reproduisent des
//     pièces déjà présentes au ledger, celles de l'exercice clos. Les compter
//     double les montants.
//
// Ce module identifie les à-nouveaux de report pour que la lecture cumulée les
// écarte. La reprise initiale importée (bilan d'entrée d'un dossier repris chez
// un confrère) est conservée : elle, n'a pas de pièce d'origine dans Nova.
// Critère : un exercice reçoit des à-nouveaux de report si l'exercice qui le
// précède a été clôturé — c'est exactement ce que fait closeExercise().
// ============================================================================

export async function carryForwardFiscalYears(c: Client, dossierId: string): Promise<string[]> {
  const { rows } = await c.query(
    'select id, status from fiscal_years where dossier_id=$1 order by start_date', [dossierId]);
  const out: string[] = [];
  for (let i = 1; i < rows.length; i++) if (rows[i - 1].status === 'closed') out.push(rows[i].id);
  return out;
}

// Fragment à insérer dans un where (l'écriture doit être aliasée `e`).
// $p reçoit le tableau renvoyé par carryForwardFiscalYears : vide = aucune
// clôture, donc aucune ligne écartée.
export const NOT_CARRY_FORWARD = (p: number) =>
  `not (e.source = 'opening_balance' and e.fiscal_year_id = any($${p}::uuid[]))`;
