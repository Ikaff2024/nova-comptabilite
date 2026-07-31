import type { Client } from '../db.js';
import * as acc from './accounting.js';
import { payrollYear } from './payroll.js';
import { listAssets } from './assets.js';

// ============================================================================
// AQM 2.0 — Moteur de cohérence INTER-MODULES. Au-delà des contrôles d'un seul
// module (controls.ts = soldes anormaux du grand livre), on vérifie que les
// modules « racontent la même histoire » : la paie comptabilisée correspond-elle
// aux bulletins ? les dotations aux immobilisations sont-elles passées ? etc.
// Déterministe et traçable (chaque contrôle expose attendu / constaté / écart).
// ============================================================================

export type Niveau = 'haute' | 'moyenne' | 'info' | 'ok';
export interface CoherenceCheck {
  module: string; regle: string; libelle: string;
  attendu: number; constate: number; ecart: number;
  niveau: Niveau; explication: string;
}

const round = (n: number) => Math.round(n);
// Tolérance : 1 % de la base, avec un plancher pour ignorer le bruit d'arrondi.
const tol = (base: number) => Math.max(1000, Math.abs(base) * 0.01);

export async function globalCoherence(c: Client, dossierId: string, fiscalYearId?: string): Promise<{
  dossierId: string; devise: string; exercice: string | null; annee: number;
  resume: { haute: number; moyenne: number; info: number; ok: number; total: number };
  niveauGlobal: Niveau; controles: CoherenceCheck[];
}> {
  const { rows: dr } = await c.query('select base_currency from dossiers where id=$1', [dossierId]);
  const devise = dr[0]?.base_currency ?? 'XOF';

  // Résoudre l'exercice (par défaut le plus récent). On suppose un exercice
  // civil (Jan–Déc), cas courant en Côte d'Ivoire, pour aligner la paie.
  let fyId = fiscalYearId;
  let exercice: string | null = null;
  let annee = new Date().getUTCFullYear();
  const { rows: fys } = await c.query(
    'select id, label, extract(year from start_date)::int as y from fiscal_years where dossier_id=$1 order by start_date desc', [dossierId]);
  if (fys.length) {
    const chosen = fyId ? fys.find((f: any) => f.id === fyId) : fys[0];
    if (chosen) { fyId = chosen.id; exercice = chosen.label; annee = chosen.y; }
  }

  const tb = await acc.trialBalance(c, dossierId, fyId);
  const balPrefix = (...prefixes: string[]) => tb
    .filter((r: any) => prefixes.some((p) => String(r.account_code).startsWith(p)))
    .reduce((s: number, r: any) => s + Number(r.balance), 0);

  const controles: CoherenceCheck[] = [];
  const add = (chk: Omit<CoherenceCheck, 'ecart'>) => controles.push({ ...chk, ecart: round(chk.constate - chk.attendu) });

  // --- Paie ↔ Comptabilité : masse salariale brute (661) -------------------
  const py: any = await payrollYear(c, dossierId, annee);
  const brutPaie = round(py?.totals?.brut ?? 0);
  const brutCompta = round(balPrefix('661'));
  if (brutPaie > 0 || brutCompta > 0) {
    let niveau: Niveau = 'ok';
    let libelle = 'Masse salariale brute vs compte 661';
    let expl = 'La masse salariale brute des bulletins correspond aux rémunérations comptabilisées (661).';
    if (brutPaie > 0 && brutCompta === 0) { niveau = 'haute'; expl = `Des bulletins existent (masse brute ${brutPaie}) mais aucune rémunération n'est comptabilisée en 661 : l'OD de paie n'a pas été passée.`; }
    // Aucun bulletin en face d'un 661 mouvementé n'est PAS un écart : c'est une
    // paie tenue hors de Nova. Annoncer « écart » ici, c'est poser un mauvais
    // diagnostic — et le lecteur cherchera une erreur qui n'existe pas.
    else if (brutPaie === 0) {
      niveau = 'info';
      libelle = 'Paie tenue hors de Nova';
      expl = `Les rémunérations sont comptabilisées en 661 (${brutCompta}) sans aucun bulletin dans le module Paie : la paie est tenue ailleurs, ou les bulletins de l'exercice ${exercice ?? annee} n'ont pas été saisis. Rien à corriger si c'est voulu — mais le rapprochement paie ↔ comptabilité reste alors impossible.`;
    }
    else if (Math.abs(brutCompta - brutPaie) > tol(brutPaie)) { niveau = 'moyenne'; expl = `Écart entre la masse salariale des bulletins (${brutPaie}) et le compte 661 (${brutCompta}) : paie partiellement comptabilisée ou écriture manuelle divergente.`; }
    add({ module: 'Paie ↔ Comptabilité', regle: 'masse_salariale_661', libelle, attendu: brutPaie, constate: brutCompta, niveau, explication: expl });
  }

  // --- Paie ↔ Comptabilité : charges patronales (664) ----------------------
  const cnpsPat = round(py?.totals?.cnpsPatronal ?? 0);
  const compta664 = round(balPrefix('664'));
  // Sans aucun bulletin, ce contrôle n'a rien à dire de plus que celui du 661 :
  // on ne répète pas le même constat sous un deuxième libellé.
  if (brutPaie > 0 && (cnpsPat > 0 || compta664 > 0)) {
    let niveau: Niveau = 'ok';
    let expl = 'Les charges sociales patronales des bulletins correspondent au compte 664.';
    if (cnpsPat > 0 && compta664 === 0) { niveau = 'moyenne'; expl = `Charges sociales patronales des bulletins (${cnpsPat}) non comptabilisées en 664.`; }
    else if (Math.abs(compta664 - cnpsPat) > tol(cnpsPat)) { niveau = 'info'; expl = `Écart entre les charges patronales des bulletins (${cnpsPat}) et le compte 664 (${compta664}).`; }
    add({ module: 'Paie ↔ Comptabilité', regle: 'charges_patronales_664', libelle: 'Charges patronales vs compte 664', attendu: cnpsPat, constate: compta664, niveau, explication: expl });
  }

  // --- Immobilisations ↔ Comptabilité : dotations dues ---------------------
  const assets: any[] = await listAssets(c, dossierId);
  if (assets.length) {
    const dotationsDues = round(assets.reduce((s, a) => s + (a.status === 'disposed' ? 0 : Number(a.pendingAmount) || 0), 0));
    let niveau: Niveau = 'ok';
    let expl = "Toutes les dotations aux amortissements dues sont comptabilisées.";
    if (dotationsDues > 0) { niveau = 'moyenne'; expl = `${dotationsDues} de dotations aux amortissements sont dues mais pas encore comptabilisées (immobilisations en retard d'amortissement). Lexa peut les passer (comptabiliser_dotations_dues).`; }
    add({ module: 'Immobilisations ↔ Comptabilité', regle: 'dotations_dues', libelle: 'Dotations dues non comptabilisées', attendu: 0, constate: dotationsDues, niveau, explication: expl });

    // Cumul des amortissements : registre vs comptes 28.
    const cumulRegistre = round(assets.reduce((s, a) => s + (Number(a.cumulPosted) || 0), 0));
    const cumul28 = round(-balPrefix('28')); // 28 est créditeur : balance négative.
    if (cumulRegistre > 0 || cumul28 > 0) {
      let n2: Niveau = 'ok';
      let e2 = 'Le cumul des amortissements du registre correspond aux comptes 28.';
      if (Math.abs(cumul28 - cumulRegistre) > tol(cumulRegistre)) { n2 = 'info'; e2 = `Écart entre le cumul d'amortissements du registre (${cumulRegistre}) et les comptes 28 (${cumul28}) : amortissements antérieurs non repris, ou écriture manuelle.`; }
      add({ module: 'Immobilisations ↔ Comptabilité', regle: 'cumul_amortissements_28', libelle: 'Cumul amortissements vs comptes 28', attendu: cumulRegistre, constate: cumul28, niveau: n2, explication: e2 });
    }
  }

  // --- TVA ↔ Grand livre : cohérence avec le RÉGIME fiscal -------------------
  // Contrôle déterministe (pas d'estimation) : sous l'impôt synthétique on ne
  // collecte pas de TVA ; en réel, une TVA collectée nulle malgré des ventes
  // est un signal fort.
  const { rows: rg } = await c.query('select regime_fiscal from dossiers where id=$1', [dossierId]);
  const regime = String(rg[0]?.regime_fiscal ?? '');
  const tvaCollectee = round(-balPrefix('443'));   // 443 est créditeur
  const ventes = round(-balPrefix('70'));          // 70x créditeur
  if (regime === 'synthetique') {
    const ok = tvaCollectee === 0;
    add({
      module: 'TVA ↔ Grand livre', regle: 'tva_regime_synthetique', libelle: 'TVA collectée vs régime fiscal',
      attendu: 0, constate: tvaCollectee, niveau: ok ? 'ok' : 'haute',
      explication: ok ? "Régime de l'impôt synthétique : aucune TVA collectée, conforme."
        : `Régime de l'impôt synthétique (non assujetti) mais ${tvaCollectee} de TVA collectée en 443 : imputation à revoir, ou régime mal renseigné dans la fiche entreprise.`,
    });
  } else if (ventes > 0 || tvaCollectee > 0) {
    const ok = !(ventes > 500000 && tvaCollectee === 0);
    add({
      module: 'TVA ↔ Grand livre', regle: 'tva_collectee_ventes', libelle: 'TVA collectée vs ventes comptabilisées',
      attendu: 0, constate: tvaCollectee, niveau: ok ? 'ok' : 'moyenne',
      explication: ok ? 'Des ventes et une TVA collectée sont enregistrées de façon cohérente.'
        : `Des ventes (${ventes}) sans aucune TVA collectée en 443 : vérifiez l'assujettissement, une exonération, ou une TVA non comptabilisée.`,
    });
  }

  // --- Trésorerie ↔ Résultat : bouclage du tableau de flux -------------------
  // Le TFT calcule déjà l'écart entre la variation de trésorerie CONSTATÉE au
  // bilan et celle EXPLIQUÉE par les flux. Un écart matériel = des mouvements
  // de trésorerie que le résultat et les flux n'expliquent pas.
  try {
    const tft: any = await acc.cashFlowStatement(c, dossierId, fyId);
    if (tft?.hasPrevious) {
      const ecart = round(tft.ecartReconciliation);
      const base = Math.max(Math.abs(round(tft.variationConstatee)), 1);
      const ok = Math.abs(ecart) <= Math.max(1000, base * 0.02);
      add({
        module: 'Trésorerie ↔ Résultat', regle: 'tft_reconciliation', libelle: 'Bouclage du tableau de flux',
        attendu: round(tft.variationConstatee), constate: round(tft.variationCalculee), niveau: ok ? 'ok' : 'moyenne',
        explication: ok ? 'La variation de trésorerie est entièrement expliquée par les flux (exploitation, investissement, financement).'
          : `La variation de trésorerie constatée n'est pas entièrement expliquée par les flux : écart de ${ecart}. Des mouvements de trésorerie sont mal rattachés (ou un compte de bilan a bougé sans contrepartie identifiée).`,
      });
    }
  } catch { /* TFT indisponible (pas de N-1) : contrôle non applicable */ }

  const resume = {
    haute: controles.filter((x) => x.niveau === 'haute').length,
    moyenne: controles.filter((x) => x.niveau === 'moyenne').length,
    info: controles.filter((x) => x.niveau === 'info').length,
    ok: controles.filter((x) => x.niveau === 'ok').length,
    total: controles.length,
  };
  const niveauGlobal: Niveau = resume.haute ? 'haute' : resume.moyenne ? 'moyenne' : resume.info ? 'info' : 'ok';
  const ord = { haute: 0, moyenne: 1, info: 2, ok: 3 };
  controles.sort((a, b) => ord[a.niveau] - ord[b.niveau]);
  return { dossierId, devise, exercice, annee, resume, niveauGlobal, controles };
}
