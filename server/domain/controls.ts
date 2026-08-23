import type { Client } from '../db.js';
import * as acc from './accounting.js';

// ============================================================================
// Contrôles de cohérence comptable (révision automatisée) : détecte les soldes
// anormaux au regard du sens attendu SYSCOHADA. Lecture seule — complète la
// révision manuelle (account_reviews). Alimente le conseil/contrôle de Lexa.
// ============================================================================

export type Niveau = 'haute' | 'moyenne' | 'info';
export interface Anomalie {
  niveau: Niveau; regle: string; compte: string; intitule: string;
  solde: number; sens: 'débiteur' | 'créditeur'; explication: string;
}

const SEUIL = 1000; // ignore le bruit d'arrondi / soldes négligeables

export async function coherenceChecks(c: Client, dossierId: string, fiscalYearId?: string): Promise<{
  dossierId: string; devise: string; nbComptesAnalyses: number;
  resume: { haute: number; moyenne: number; info: number; total: number };
  anomalies: Anomalie[];
}> {
  const { rows: dr } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
  const devise = dr[0]?.base_currency ?? 'XOF';
  const rows = await acc.trialBalance(c, dossierId, fiscalYearId);
  const anomalies: Anomalie[] = [];

  // Comptes de TÊTE : un compte qui a des subdivisions ne se saisit pas
  // lui-même (`is_postable` est posé à false à l'instanciation du plan).
  // C'est une erreur d'imputation, pas une erreur de montant : rien dans les
  // totaux ne la trahit, la balance reste équilibrée au franc près.
  //
  // Précision qui change tout : on ne signale PAS un compte de tête utilisé de
  // façon constante. Imputer toujours sur 701 sans jamais toucher 7011 est un
  // choix de tenue, pas une erreur — le solde reste juste.
  //
  // Ce qui est fautif, c'est que le PARENT ET UNE DE SES SUBDIVISIONS portent
  // tous deux des mouvements : le compte réel est alors coupé en deux, les
  // entrées d'un côté, les sorties de l'autre, d'où des soldes impossibles.
  // Sans cette nuance, le contrôle criait sur quinze comptes parfaitement
  // tenus et noyait la seule anomalie réelle.
  const { rows: plan } = await c.query(
    `with mouvementes as (
       select a.account_code, a.is_postable
         from entry_lines l
         join entries e on e.id = l.entry_id and e.status = 'posted'
         join accounts a on a.id = l.account_id
        where l.dossier_id = $1
        group by a.account_code, a.is_postable
     )
     select p.account_code,
            (select string_agg(k.account_code, ', ' order by k.account_code) from mouvementes k
              where k.account_code <> p.account_code
                and k.account_code like p.account_code || '%') as subdivisions
       from mouvementes p where p.is_postable = false`, [dossierId]);
  const teteAvecSubdivisions = new Map<string, string>(
    plan.filter((p: any) => p.subdivisions).map((p: any) => [p.account_code, p.subdivisions]));
  const push = (niveau: Niveau, regle: string, r: any, explication: string) =>
    anomalies.push({ niveau, regle, compte: r.account_code, intitule: r.account_label ?? '', solde: Math.round(r.balance), sens: r.balance >= 0 ? 'débiteur' : 'créditeur', explication });

  for (const r of rows) {
    const code = String(r.account_code); const bal = Number(r.balance);

    // Compte tenu à deux endroits : signalé même quand le solde est faible,
    // car c'est la CAUSE d'autres anomalies (caisse créditrice, trésorerie
    // éclatée), et le montant n'a rien à voir avec la gravité.
    const subs = teteAvecSubdivisions.get(code);
    if (subs && (r.total_debit !== 0 || r.total_credit !== 0)) {
      push('haute', 'ecriture_sur_compte_de_tete', r,
        `Le compte ${code} porte des écritures ALORS QUE sa subdivision ${subs} en porte aussi : le même compte est tenu à deux endroits. Les entrées d'un côté et les sorties de l'autre produisent des soldes impossibles — une caisse créditrice, par exemple. À réunir sur la subdivision qui convient.`);
      continue;
    }

    if (Math.abs(bal) < SEUIL) continue;

    // Virements de fonds (58) : compte de PASSAGE entre deux comptes de
    // trésorerie. Il doit être soldé — un reliquat veut dire qu'un transfert
    // n'a qu'une moitié : l'argent est parti d'un compte sans arriver dans
    // l'autre, ou l'inverse. Il gonfle alors la trésorerie d'un côté du bilan.
    if (code.startsWith('58')) {
      push('haute', 'virement_fonds_non_solde', r,
        "Les virements de fonds (58) sont un compte de passage : il doit être soldé à zéro. Un reliquat signale un transfert enregistré d'un seul côté — la trésorerie du bilan s'en trouve faussée.");
      continue;
    }

    // Fournisseurs 401 débiteurs (hors 409 = avances/fournisseurs débiteurs, normal).
    if (code.startsWith('401') && bal > 0)
      push('moyenne', 'fournisseur_debiteur', r, "Un compte fournisseur (401) au solde débiteur est inhabituel : avoir non soldé, double règlement ou avance à reclasser en 409.");
    // Clients 411 créditeurs (hors 419 = clients créditeurs/avances, normal).
    else if (code.startsWith('411') && bal < 0)
      push('moyenne', 'client_crediteur', r, "Un compte client (411) au solde créditeur est inhabituel : avance reçue à reclasser en 419, trop-perçu ou avoir.");
    // Caisse (57) créditrice → caisse physiquement négative : impossible.
    else if (code.startsWith('57') && bal < 0)
      push('haute', 'caisse_negative', r, "Une caisse (57) ne peut pas être créditrice (solde négatif impossible) : écritures manquantes ou mal imputées.");
    // Comptes d'attente/transitoires (47) non soldés → à apurer avant clôture.
    else if (code.startsWith('47'))
      push('moyenne', 'compte_attente', r, "Compte d'attente/transitoire (47) non soldé : à justifier et apurer avant la clôture.");
    // TVA collectée (443) doit être créditrice ; débitrice = anomalie.
    else if (code.startsWith('443') && bal > 0)
      push('moyenne', 'tva_collectee_debitrice', r, "La TVA facturée/collectée (443) devrait être créditrice ; un solde débiteur signale une imputation à vérifier.");
    // TVA déductible (445) doit être débitrice ; créditrice = anomalie.
    else if (code.startsWith('445') && bal < 0)
      push('moyenne', 'tva_deductible_creditrice', r, "La TVA déductible (445) devrait être débitrice ; un solde créditeur signale une imputation à vérifier.");
    // Capital (101-108) débiteur : anormal (le capital est une ressource, créditrice).
    else if (/^10[1-8]/.test(code) && bal > 0)
      push('info', 'capital_debiteur', r, "Un compte de capital (10) au solde débiteur est anormal : à vérifier.");
    // Amortissements (28) débiteurs : anormal (les amortissements sont créditeurs).
    else if (code.startsWith('28') && bal > 0)
      push('info', 'amortissement_debiteur', r, "Un compte d'amortissement (28) au solde débiteur est anormal : dotation/reprise à vérifier.");
  }

  anomalies.sort((a, b) => ({ haute: 0, moyenne: 1, info: 2 }[a.niveau] - { haute: 0, moyenne: 1, info: 2 }[b.niveau]) || Math.abs(b.solde) - Math.abs(a.solde));
  const resume = {
    haute: anomalies.filter((a) => a.niveau === 'haute').length,
    moyenne: anomalies.filter((a) => a.niveau === 'moyenne').length,
    info: anomalies.filter((a) => a.niveau === 'info').length,
    total: anomalies.length,
  };
  return { dossierId, devise, nbComptesAnalyses: rows.length, resume, anomalies };
}
