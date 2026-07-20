import type { Client } from '../db.js';
import { coherenceChecks } from './controls.js';
import { globalCoherence } from './coherence.js';
import { revisionReport } from './revision.js';
import { dossierAlerts } from './alerts.js';

// ============================================================================
// Score de QUALITÉ COMPTABLE (0-100, note A–D). Distinct du score de santé
// financière (scoring.ts, orienté crédit) : celui-ci mesure la FIABILITÉ de la
// tenue — exactitude, cohérence, justification, traçabilité, échéances. Il
// prolonge le positionnement AQM (« une compta juste et auditable »).
//
// Entièrement DÉTERMINISTE : recompose des contrôles déjà calculés, aucune
// estimation ni appel LLM.
// ============================================================================

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n);

export interface QualityAxis { key: string; label: string; score: number; weight: number; detail: string }

export async function qualityScore(c: Client, dossierId: string, fiscalYearId?: string): Promise<{
  score: number; rating: 'A' | 'B' | 'C' | 'D';
  axes: QualityAxis[]; forces: string[]; faiblesses: string[];
}> {
  const axes: QualityAxis[] = [];

  // --- 1) Exactitude : anomalies de soldes (sens SYSCOHADA) ------------------
  let sEx = 100, exDetail = 'Aucune anomalie de solde détectée.';
  try {
    const ctrl: any = await coherenceChecks(c, dossierId, fiscalYearId);
    const r = ctrl.resume ?? {};
    sEx = clamp(100 - (r.haute ?? 0) * 18 - (r.moyenne ?? 0) * 7 - (r.info ?? 0) * 1);
    const total = (r.haute ?? 0) + (r.moyenne ?? 0) + (r.info ?? 0);
    exDetail = total === 0 ? 'Aucune anomalie de solde détectée.' : `${total} anomalie(s) de solde à corriger (dont ${r.haute ?? 0} majeure(s)).`;
  } catch { sEx = 70; exDetail = 'Contrôle des soldes indisponible.'; }
  axes.push({ key: 'exactitude', label: 'Exactitude', score: round(sEx), weight: 0.30, detail: exDetail });

  // --- 2) Cohérence inter-modules (AQM 2.0) ----------------------------------
  let sCo = 100, coDetail = 'Les modules concordent (paie, immo, TVA, trésorerie).';
  try {
    const co: any = await globalCoherence(c, dossierId, fiscalYearId);
    const r = co.resume ?? {};
    sCo = clamp(100 - (r.haute ?? 0) * 20 - (r.moyenne ?? 0) * 10 - (r.info ?? 0) * 3);
    if ((r.haute ?? 0) + (r.moyenne ?? 0) > 0) coDetail = `${(r.haute ?? 0) + (r.moyenne ?? 0)} incohérence(s) entre modules à lever.`;
  } catch { sCo = 70; coDetail = 'Contrôle de cohérence indisponible.'; }
  axes.push({ key: 'coherence', label: 'Cohérence inter-modules', score: round(sCo), weight: 0.25, detail: coDetail });

  // --- 3) Justification des comptes (révision) -------------------------------
  let sJu = 60, juDetail = 'Révision non commencée.';
  if (fiscalYearId) {
    try {
      const rev: any = await revisionReport(c, dossierId, fiscalYearId);
      const t = rev.progress?.total ?? 0, rv = rev.progress?.reviewed ?? 0;
      if (t > 0) { sJu = clamp(Math.round((rv / t) * 100)); juDetail = `${rv} / ${t} comptes justifiés.`; }
    } catch { /* neutre */ }
  }
  axes.push({ key: 'justification', label: 'Justification des comptes', score: round(sJu), weight: 0.20, detail: juDetail });

  // --- 4) Traçabilité : part des écritures validées (vs brouillons) ----------
  let sTr = 70, trDetail = 'Aucune écriture.';
  try {
    const p: any[] = [dossierId]; let w = 'l.dossier_id = $1';
    // (on compte au niveau entries, pas lignes)
    const { rows } = await c.query(
      `select count(*) filter (where status='posted') as posted,
              count(*) filter (where status='draft')  as draft
         from entries e where e.dossier_id = $1`, p);
    const posted = Number(rows[0]?.posted ?? 0), draft = Number(rows[0]?.draft ?? 0);
    const total = posted + draft;
    if (total > 0) { sTr = clamp(Math.round((posted / total) * 100)); trDetail = draft > 0 ? `${draft} écriture(s) en brouillon non validée(s).` : 'Toutes les écritures sont validées.'; }
  } catch { /* neutre */ }
  axes.push({ key: 'tracabilite', label: 'Traçabilité', score: round(sTr), weight: 0.15, detail: trDetail });

  // --- 5) Échéances fiscales & TVA (alertes déjà calculées) ------------------
  let sEc = 100, ecDetail = 'Aucune échéance urgente.';
  try {
    const al: any = await dossierAlerts(c, dossierId, fiscalYearId);
    const fisc = (al.alertes ?? []).filter((a: any) => a.categorie === 'tva' || String(a.categorie).startsWith('echeance'));
    const hautes = fisc.filter((a: any) => a.niveau === 'haute').length;
    const moyennes = fisc.filter((a: any) => a.niveau === 'moyenne').length;
    sEc = clamp(100 - hautes * 22 - moyennes * 8);
    if (hautes + moyennes > 0) ecDetail = `${hautes + moyennes} échéance(s) fiscale(s)/TVA à traiter (dont ${hautes} urgente(s)).`;
  } catch { sEc = 85; ecDetail = 'Suivi des échéances indisponible.'; }
  axes.push({ key: 'echeances', label: 'Échéances fiscales', score: round(sEc), weight: 0.10, detail: ecDetail });

  const score = round(axes.reduce((s, a) => s + a.score * a.weight, 0));
  const rating: 'A' | 'B' | 'C' | 'D' = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';
  const forces = axes.filter((a) => a.score >= 85).map((a) => a.label);
  const faiblesses = axes.filter((a) => a.score < 60).map((a) => a.label);

  return { score, rating, axes, forces, faiblesses };
}
