import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import { coherenceChecks } from './domain/controls.js';

// ============================================================================
// CONTRÔLES DE RÉVISION — le cas réel rencontré chez IKAFFANAN.
//
// Une écriture imputée sur un compte de TÊTE (571, qui a des subdivisions)
// coupe le compte réel en deux : les encaissements sur 5711, les sorties sur
// 571. La caisse paraît alors CRÉDITRICE — physiquement impossible — et le
// bilan présente une trésorerie-passif qui n'existe pas.
//
// Rien dans les totaux ne trahit l'erreur : la balance reste équilibrée.
// Seul un contrôle sur l'imputation peut la voir.
//
//   npm run test:controles   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME Caisse', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const j = await withUser(u, (c) => acc.createJournal(c, d.id, 'OD', 'Opérations diverses', 'operations_diverses'));
  const post = (date: string, desc: string, lines: any[]) =>
    withUser(u, (c) => acc.postEntry(c, { dossierId: d.id, fiscalYearId: fy, journalId: j, entryDate: date, description: desc, source: 'manual', lines }));

  // Les encaissements vont sur la subdivision, les sorties sur le compte de tête.
  await post('2026-02-10', 'Encaissements espèces',
    [{ accountCode: '5711', debit: 9190000 }, { accountCode: '7061', credit: 9190000 }]);
  await post('2026-03-15', 'Règlement fournisseur en espèces',
    [{ accountCode: '4011', debit: 3000000 }, { accountCode: '571', credit: 3000000 }]);
  // Un virement de fonds enregistré d'un seul côté.
  await post('2026-04-02', 'Virement caisse vers banque (moitié manquante)',
    [{ accountCode: '5211', debit: 211954 }, { accountCode: '585', credit: 211954 }]);

  const r = await withUser(u, (c) => coherenceChecks(c, d.id, fy));
  const tete = r.anomalies.find((a) => a.regle === 'ecriture_sur_compte_de_tete');
  const vir = r.anomalies.find((a) => a.regle === 'virement_fonds_non_solde');
  const caisse = r.anomalies.find((a) => a.regle === 'caisse_negative');

  check("l'imputation sur le compte de tête 571 est détectée", tete?.compte === '571', `(${tete?.compte})`);
  check('et le message nomme les subdivisions à utiliser',
    /5711/.test(tete?.explication ?? ''), `(${(tete?.explication ?? '').slice(0, 60)}…)`);
  check('le virement de fonds non soldé est détecté', vir?.compte === '585', `(${vir?.compte})`);
  check('les deux sont au niveau le plus élevé',
    tete?.niveau === 'haute' && vir?.niveau === 'haute');
  check("la caisse créditrice, elle, était déjà vue", !!caisse || tete?.compte === '571');

  // La balance, elle, reste parfaitement équilibrée : l'erreur est invisible
  // dans les totaux. C'est tout l'intérêt du contrôle.
  const tb = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  const net = tb.reduce((s: number, x: any) => s + Number(x.balance), 0);
  check('la balance reste équilibrée malgré l\'erreur', Math.abs(net) < 0.01, `(${net})`);

  // Un dossier sain ne déclenche rien.
  const u2 = randomUUID();
  const cab2 = await withUser(u2, (c) => acc.onboardCabinet(c, u2, 'Cab2', 'CI'));
  const d2 = await withUser(u2, (c) => acc.openDossier(c, { cabinetId: cab2, raisonSociale: 'PME Saine', country: 'CI' }));
  const fy2 = await withUser(u2, (c) => acc.createFiscalYear(c, d2.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const j2 = await withUser(u2, (c) => acc.createJournal(c, d2.id, 'OD', 'OD', 'operations_diverses'));
  await withUser(u2, (c) => acc.postEntry(c, {
    dossierId: d2.id, fiscalYearId: fy2, journalId: j2, entryDate: '2026-02-10',
    description: 'Encaissement', source: 'manual',
    lines: [{ accountCode: '5711', debit: 500000 }, { accountCode: '7061', credit: 500000 }],
  }));
  const r2 = await withUser(u2, (c) => coherenceChecks(c, d2.id, fy2));
  check('aucune fausse alerte sur un dossier correctement imputé',
    !r2.anomalies.some((a) => a.regle === 'ecriture_sur_compte_de_tete' || a.regle === 'virement_fonds_non_solde'),
    `(${r2.anomalies.map((a) => a.regle).join(',')})`);

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
