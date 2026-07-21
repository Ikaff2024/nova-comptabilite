import type { Client } from '../db.js';
import * as acc from './accounting.js';
import { estimationIS, vatDeclaration } from './tax.js';

// ============================================================================
// Assistant fiscal proactif. Signale, de façon DÉTERMINISTE, des points de
// vigilance et pistes d'optimisation dérivés de la comptabilité et du régime.
// Positionnement prudent : ce sont des PISTES à valider avec un fiscaliste,
// jamais un conseil définitif — on reste dans la ligne « fiabilité » de Nova.
// ============================================================================

export type Niveau = 'haute' | 'moyenne' | 'info';
export interface Conseil { niveau: Niveau; categorie: string; titre: string; detail: string; montant?: number }

const round = (n: number) => Math.round(Number(n) || 0);

export async function fiscalAdvisor(c: Client, dossierId: string, fiscalYearId?: string): Promise<{
  devise: string; conseils: Conseil[];
}> {
  const { rows: dr } = await c.query('select base_currency, regime_fiscal from dossiers where id=$1', [dossierId]);
  const devise = dr[0]?.base_currency ?? 'XOF';
  const regime = String(dr[0]?.regime_fiscal ?? '');
  const conseils: Conseil[] = [];
  const push = (co: Conseil) => conseils.push(co);
  const safe = async (fn: () => Promise<void>) => { try { await fn(); } catch { /* source ignorée */ } };

  // 1) IS vs IMF : structure de l'impôt.
  await safe(async () => {
    const est: any = await estimationIS(c, dossierId, fiscalYearId);
    if (!est.beneficiaire && est.chiffreAffaires > 0) {
      push({ niveau: 'moyenne', categorie: 'is', titre: 'Résultat déficitaire — IMF dû malgré la perte', montant: round(est.imf),
        detail: `Le résultat est négatif : vous restez redevable de l'impôt minimum forfaitaire (${round(est.imf)} ${devise}). Le déficit est reportable sur les exercices suivants — pensez à en tenir compte l'an prochain.` });
    } else if (est.beneficiaire && est.imf > est.isTheorique) {
      push({ niveau: 'moyenne', categorie: 'is', titre: 'Vous payez l\'IMF, supérieur à l\'IS', montant: round(est.imf),
        detail: `Votre impôt est l'IMF (${round(est.imf)} ${devise}), plus élevé que l'IS calculé sur le bénéfice (${round(est.isTheorique)} ${devise}) : la marge est faible au regard du chiffre d'affaires. Piste : agir sur la rentabilité, ou vérifier les charges déductibles omises.` });
    }
    // Acompte à provisionner.
    if (est.impotDu > 0) {
      push({ niveau: 'info', categorie: 'is', titre: 'Acomptes d\'impôt à provisionner', montant: round(est.acompteProvisionnel),
        detail: `Impôt estimé de l'exercice : ${round(est.impotDu)} ${devise}. Prévoyez les acomptes provisionnels (environ ${round(est.acompteProvisionnel)} ${devise} chacun) pour éviter une sortie de trésorerie brutale au solde.` });
    }
  });

  // 2) Crédit de TVA qui s'accumule -> demande de remboursement.
  await safe(async () => {
    const { rows: fy } = fiscalYearId
      ? await c.query("select to_char(start_date,'YYYY-MM-DD') s, to_char(end_date,'YYYY-MM-DD') e from fiscal_years where dossier_id=$1 and id=$2", [dossierId, fiscalYearId])
      : { rows: [{ s: `${new Date().getUTCFullYear()}-01-01`, e: `${new Date().getUTCFullYear()}-12-31` }] };
    if (!fy[0]) return;
    const vat: any = await vatDeclaration(c, dossierId, fy[0].s, fy[0].e);
    if (vat.creditReportable > 1_000_000) {
      push({ niveau: 'moyenne', categorie: 'tva', titre: 'Crédit de TVA important à récupérer', montant: round(vat.creditReportable),
        detail: `Un crédit de TVA de ${round(vat.creditReportable)} ${devise} s'accumule (TVA déductible > collectée). Au-delà d'un certain seuil, une demande de remboursement à la DGI peut être introduite plutôt que de le reporter indéfiniment.` });
    }
  });

  // 3) Amendes / pénalités : non déductibles, à réintégrer.
  await safe(async () => {
    const tb = await acc.trialBalance(c, dossierId, fiscalYearId);
    const amendes = tb.filter((r: any) => /amend|p[ée]nalit/i.test(String(r.account_label ?? '')) && Number(r.balance) > 0)
      .reduce((s: number, r: any) => s + Number(r.balance), 0);
    if (amendes > 0) {
      push({ niveau: 'info', categorie: 'is', titre: 'Amendes / pénalités enregistrées', montant: round(amendes),
        detail: `${round(amendes)} ${devise} d'amendes ou pénalités en charges : elles ne sont pas déductibles fiscalement et doivent être réintégrées au résultat pour le calcul de l'impôt.` });
    }
  });

  // 4) Régime fiscal manifestement incohérent avec le volume d'activité.
  await safe(async () => {
    const fs: any = await acc.financialStatements(c, dossierId, fiscalYearId);
    const ca = (fs.incomeStatement?.sig ?? []).find((s: any) => s.label === "Chiffre d'affaires")?.amount ?? 0;
    if (regime === 'synthetique' && ca > 200_000_000) {
      push({ niveau: 'haute', categorie: 'regime', titre: 'Régime fiscal à vérifier', montant: round(ca),
        detail: `Votre chiffre d'affaires (${round(ca)} ${devise}) paraît élevé pour le régime de l'impôt synthétique. Vérifiez si vous ne relevez pas d'un régime réel (RSI/RNI) — un régime inadapté expose à un redressement.` });
    }
    if (!regime) {
      push({ niveau: 'info', categorie: 'regime', titre: 'Régime fiscal non renseigné', detail: 'Renseignez le régime fiscal dans la fiche entreprise : il conditionne la TVA, les déclarations et les conseils fiscaux.' });
    }
  });

  return { devise, conseils };
}
