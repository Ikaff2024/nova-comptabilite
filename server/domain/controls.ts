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
  // lui-même (`is_postable` est posé à false à l'instanciation du plan). Y
  // imputer une écriture éclate le compte réel en deux — le solde part d'un
  // côté, les mouvements de l'autre — et fabrique des soldes impossibles :
  // une caisse créditrice, par exemple, alors que sa subdivision est
  // débitrice. C'est une erreur d'imputation, pas une erreur de montant, donc
  // rien dans les totaux ne la trahit.
  const { rows: plan } = await c.query(
    `select a.account_code, a.is_postable,
            (select string_agg(s.account_code, ', ' order by s.account_code)
               from accounts s
              where s.dossier_id = a.dossier_id and s.is_active
                and s.account_code <> a.account_code
                and s.account_code like a.account_code || '%') as subdivisions
       from accounts a where a.dossier_id = $1 and a.is_postable = false`, [dossierId]);
  const teteAvecSubdivisions = new Map<string, string>(
    plan.filter((p: any) => p.subdivisions).map((p: any) => [p.account_code, p.subdivisions]));
  const push = (niveau: Niveau, regle: string, r: any, explication: string) =>
    anomalies.push({ niveau, regle, compte: r.account_code, intitule: r.account_label ?? '', solde: Math.round(r.balance), sens: r.balance >= 0 ? 'débiteur' : 'créditeur', explication });

  for (const r of rows) {
    const code = String(r.account_code); const bal = Number(r.balance);

    // Imputation sur un compte de tête : signalée même quand le solde est
    // faible, car c'est la CAUSE d'autres anomalies (caisse créditrice,
    // trésorerie éclatée), et le montant n'a rien à voir avec la gravité.
    const subs = teteAvecSubdivisions.get(code);
    if (subs && (r.total_debit !== 0 || r.total_credit !== 0)) {
      push('haute', 'ecriture_sur_compte_de_tete', r,
        `Le compte ${code} regroupe des subdivisions (${subs}) : on n'y impute pas d'écriture directement. Les mouvements passés ici sont séparés de ceux de la subdivision, ce qui coupe le compte réel en deux et peut produire un solde impossible. À réimputer sur la subdivision qui convient.`);
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
