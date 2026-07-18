import type { Client } from '../db.js';
import { tableExists } from '../schema-cache.js';

// ============================================================================
// AI Quality Monitor (AQM) — couche de validation DÉTERMINISTE des décisions de
// Lexa. Ne juge pas l'IA par une autre IA : applique des RÈGLES comptables
// vérifiables (SYSCOHADA) et renvoie un verdict PASS / WARNING / FAIL, un score
// dérivé des contrôles, et la raison de chaque contrôle → explicabilité.
//
// Sert de « gate » avant qu'une écriture proposée par Lexa ne soit affichée ou
// comptabilisée, et alimente le Decision Ledger. Lecture seule.
// ============================================================================

export type CheckLevel = 'pass' | 'warning' | 'fail';
export interface Check { code: string; label: string; level: CheckLevel; detail?: string }
export interface ValidationReport {
  verdict: 'PASS' | 'WARNING' | 'FAIL';
  score: number;                 // 0-100, déterministe (dérivé des contrôles)
  checks: Check[];
  summary: string;
}

export interface DraftLine { accountCode: string; debit?: number; credit?: number; label?: string }
export interface DraftEntry { date?: string; journalCode?: string; description?: string; lines: DraftLine[] }

const round = (n: number) => Math.round(n * 100) / 100;

// Verdict + score à partir des contrôles. Un FAIL prime ; sinon WARNING ; sinon PASS.
// Score : 100 − 30 par échec − 8 par avertissement, borné à [0, 100].
export function scoreFromChecks(checks: Check[]): { verdict: ValidationReport['verdict']; score: number } {
  const fails = checks.filter((k) => k.level === 'fail').length;
  const warns = checks.filter((k) => k.level === 'warning').length;
  const score = Math.max(0, Math.min(100, 100 - 30 * fails - 8 * warns));
  const verdict = fails > 0 ? 'FAIL' : warns > 0 ? 'WARNING' : 'PASS';
  return { verdict, score };
}

// Valide une écriture PROPOSÉE (avant comptabilisation). Non bloquant : renvoie un
// diagnostic complet plutôt que de lever une exception.
export async function validateEntry(
  c: Client, dossierId: string, entry: DraftEntry, opts: { fiscalYearId?: string } = {},
): Promise<ValidationReport> {
  const checks: Check[] = [];
  const add = (code: string, label: string, level: CheckLevel, detail?: string) => checks.push({ code, label, level, detail });
  const lines = entry.lines ?? [];

  // 1. Partie double : au moins deux lignes, au moins un débit et un crédit.
  const totDeb = round(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const totCred = round(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  if (lines.length < 2) add('partie_double', 'Partie double', 'fail', 'Une écriture doit comporter au moins deux lignes (un débit, un crédit).');
  else if (totDeb === 0 && totCred === 0) add('partie_double', 'Partie double', 'fail', 'Aucun montant saisi.');
  else add('partie_double', 'Partie double', 'pass', `${lines.length} lignes.`);

  // 2. Équilibre débit = crédit.
  if (totDeb !== totCred) add('equilibre', 'Équilibre débit = crédit', 'fail', `Débit ${totDeb} ≠ crédit ${totCred} (écart ${round(Math.abs(totDeb - totCred))}).`);
  else if (totDeb > 0) add('equilibre', 'Équilibre débit = crédit', 'pass', `Débit = crédit = ${totDeb}.`);

  // 3. Montants : positifs et un seul sens par ligne.
  const badAmount = lines.filter((l) => (Number(l.debit) || 0) < 0 || (Number(l.credit) || 0) < 0);
  const bothSides = lines.filter((l) => (Number(l.debit) || 0) > 0 && (Number(l.credit) || 0) > 0);
  if (badAmount.length) add('montants', 'Montants positifs', 'fail', 'Un montant est négatif : inversez le sens (débit/crédit) plutôt qu\'un montant négatif.');
  else if (bothSides.length) add('montants', 'Un seul sens par ligne', 'warning', 'Une ligne porte à la fois un débit et un crédit : à scinder en deux lignes.');
  else add('montants', 'Montants positifs, un seul sens', 'pass');

  // 4. Comptes existants dans le plan du dossier.
  const codes = [...new Set(lines.map((l) => String(l.accountCode || '').trim()).filter(Boolean))];
  if (codes.length) {
    const { rows: accs } = await c.query(
      'select account_code, class_no, is_collective from accounts where dossier_id=$1 and account_code = any($2)',
      [dossierId, codes],
    );
    const byCode = new Map<string, any>(accs.map((a: any) => [a.account_code, a]));
    const missing = codes.filter((k) => !byCode.has(k));
    if (missing.length) add('comptes_existants', 'Comptes au plan SYSCOHADA', 'fail', `Compte(s) introuvable(s) : ${missing.join(', ')}. À créer au plan ou corriger.`);
    else add('comptes_existants', 'Comptes au plan SYSCOHADA', 'pass', `${codes.length} compte(s) reconnus.`);

    // 5. Sens attendu par classe (souple : avertissement, car avoirs/reprises existent).
    const anomaliesSens: string[] = [];
    for (const l of lines) {
      const a = byCode.get(String(l.accountCode || '').trim());
      if (!a) continue;
      const deb = (Number(l.debit) || 0) > 0, cred = (Number(l.credit) || 0) > 0;
      if (a.class_no === 7 && deb) anomaliesSens.push(`${a.account_code} (produit) au débit`);
      if (a.class_no === 6 && cred) anomaliesSens.push(`${a.account_code} (charge) au crédit`);
    }
    if (anomaliesSens.length) add('sens_classes', 'Sens habituel des classes 6/7', 'warning', `${anomaliesSens.join(' ; ')} — inhabituel (possible avoir/reprise). À confirmer.`);
    else add('sens_classes', 'Sens habituel des classes 6/7', 'pass');

    // 6. Imputation directe sur un compte collectif (401/411…) sans passer par un tiers.
    const collectives = lines.map((l) => byCode.get(String(l.accountCode || '').trim())).filter((a) => a?.is_collective).map((a) => a.account_code);
    if (collectives.length) add('compte_collectif', 'Compte collectif → tiers', 'warning', `Imputation directe sur ${[...new Set(collectives)].join(', ')} : rattachez un tiers (compte auxiliaire) pour un suivi correct.`);
  } else {
    add('comptes_existants', 'Comptes au plan SYSCOHADA', 'fail', 'Aucun compte renseigné.');
  }

  // 7. Date dans un exercice ouvert + période non clôturée.
  if (entry.date) {
    const { rows: fys } = await c.query(
      "select label, status, to_char(start_date,'YYYY-MM-DD') as start, to_char(end_date,'YYYY-MM-DD') as end from fiscal_years where dossier_id=$1 order by start_date",
      [dossierId],
    );
    const inFy = fys.find((f: any) => entry.date! >= f.start && entry.date! <= f.end);
    if (!inFy) add('date_exercice', 'Date dans un exercice', 'fail', `La date ${fr(entry.date)} ne tombe dans aucun exercice ouvert. Créez l'exercice ou corrigez la date.`);
    else if (inFy.status === 'closed') add('date_exercice', 'Date dans un exercice', 'fail', `La date ${fr(entry.date)} appartient à l'exercice « ${inFy.label} » déjà clôturé.`);
    else add('date_exercice', 'Date dans un exercice', 'pass', `Exercice « ${inFy.label} ».`);

    if (await tableExists('period_closures')) {
      const ey = Number(entry.date.slice(0, 4)), em = Number(entry.date.slice(5, 7));
      const { rows: closed } = await c.query(
        'select 1 from period_closures where dossier_id=$1 and (year*12 + month) >= ($2*12 + $3) limit 1',
        [dossierId, ey, em],
      );
      if (closed[0]) add('periode_ouverte', 'Période mensuelle ouverte', 'fail', `Le mois ${em}/${ey} est clôturé : rouvrez-le pour saisir.`);
      else add('periode_ouverte', 'Période mensuelle ouverte', 'pass');
    }
  }

  const { verdict, score } = scoreFromChecks(checks);
  const nF = checks.filter((k) => k.level === 'fail').length, nW = checks.filter((k) => k.level === 'warning').length;
  const summary = verdict === 'PASS'
    ? `Tous les contrôles sont passés (${checks.length}/${checks.length}). Écriture prête à être comptabilisée.`
    : verdict === 'WARNING'
      ? `${checks.length - nW} contrôle(s) OK, ${nW} point(s) de vigilance. Vérifiez avant de comptabiliser.`
      : `${nF} contrôle(s) bloquant(s) et ${nW} avertissement(s) : l'écriture ne peut pas être comptabilisée en l'état.`;
  return { verdict, score, checks, summary };
}

function fr(iso: string): string { return iso.split('-').reverse().join('/'); }
