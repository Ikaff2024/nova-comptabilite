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
    let expl = 'La masse salariale brute des bulletins correspond aux rémunérations comptabilisées (661).';
    if (brutPaie > 0 && brutCompta === 0) { niveau = 'haute'; expl = `Des bulletins existent (masse brute ${brutPaie}) mais aucune rémunération n'est comptabilisée en 661 : l'OD de paie n'a pas été passée.`; }
    else if (Math.abs(brutCompta - brutPaie) > tol(brutPaie)) { niveau = 'moyenne'; expl = `Écart entre la masse salariale des bulletins (${brutPaie}) et le compte 661 (${brutCompta}) : paie partiellement comptabilisée ou écriture manuelle divergente.`; }
    add({ module: 'Paie ↔ Comptabilité', regle: 'masse_salariale_661', libelle: 'Masse salariale brute vs compte 661', attendu: brutPaie, constate: brutCompta, niveau, explication: expl });
  }

  // --- Paie ↔ Comptabilité : charges patronales (664) ----------------------
  const cnpsPat = round(py?.totals?.cnpsPatronal ?? 0);
  const compta664 = round(balPrefix('664'));
  if (cnpsPat > 0 || compta664 > 0) {
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
