import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import * as wip from './domain/assetswip.js';
import * as officiels from './domain/etats-officiels.js';
import * as analytic from './domain/analytic.js';
import * as rentab from './domain/rentabilite.js';

// ============================================================================
// Cycle complet d'une IMMOBILISATION PRODUITE EN INTERNE, sur le cas réel d'un
// éditeur qui développe son propre logiciel : charges de développement portées
// par une section analytique, capitalisation partielle (seule la phase de
// développement l'est), puis mise en service qui ouvre l'amortissement.
//
// Ce que le test verrouille, au-delà des écritures :
//   • les charges d'origine RESTENT en charges — c'est le produit 72 qui les
//     neutralise, pas une extourne ;
//   • l'en-cours tombe au bon poste du bilan officiel, la production immobilisée
//     au poste TF du compte de résultat ;
//   • le bilan reste équilibré et le résultat recoupé à chaque étape.
//
// Il rend aussi visible l'effet dont il faut avoir conscience : sans
// capitalisation le résultat serait de -4 600 000 ; avec, il est de -920 000.
// La capitalisation améliore le résultat de l'exercice, donc l'impôt.
//
//   npm run test:production-immo   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'IKAFFANAN', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'IKAFFANAN SARL', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jOD = await withUser(u, (c) => acc.createJournal(c, d.id, 'OD', 'Opérations diverses', 'operations_diverses'));
  const jBQ = await withUser(u, (c) => acc.createJournal(c, d.id, 'BQ', 'Banque', 'banque'));
  await withUser(u, (c) => analytic.createSection(c, d.id, 'NOVA', 'Produit Nova'));

  // Charges réelles du développement, ventilées sur la section NOVA
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy, journalId: jBQ, entryDate: '2026-03-31',
    description: 'Salaire mars — dév. Nova', source: 'manual',
    lines: [
      { accountCode: '661', debit: 4000000, analyticAxis: 'NOVA', label: 'Salaire dév.' },
      { accountCode: '521', credit: 4000000 },
    ],
  }));
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy, journalId: jBQ, entryDate: '2026-03-31',
    description: 'Abonnements API + hébergement', source: 'manual',
    lines: [
      { accountCode: '6281', debit: 600000, analyticAxis: 'NOVA', label: 'API / hébergement' },
      { accountCode: '521', credit: 600000 },
    ],
  }));

  const w = await withUser(u, (c) => wip.createWip(c, d.id, {
    label: 'Nova — plateforme comptable', wipAccountCode: '2193',
    analyticSection: 'NOVA', startedOn: '2026-01-01',
  }, u));
  check('chantier créé', !!w.id);

  const couts = await withUser(u, (c) => wip.coutsDeLaPeriode(c, d.id, w.id, '2026-01-01', '2026-12-31'));
  check('coûts lus depuis la section analytique = 4 600 000', couts.total === 4600000, `(${couts.total} sur ${couts.parCompte.length} comptes)`);

  // On ne capitalise que la part développement (ici 80 % du temps)
  const cap = await withUser(u, (c) => wip.capitaliser(c, d.id, w.id, {
    date: '2026-06-30', montant: 3680000, from: '2026-01-01', to: '2026-06-30',
    note: 'Phase de développement (80 % du temps)',
  }, u));
  check('capitalisation comptabilisée', cap.montant === 3680000);

  const tb = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  const s = (code: string) => tb.find((r: any) => r.account_code === code)?.balance ?? 0;
  check('2193 en-cours débité de 3 680 000', s('2193') === 3680000, `(${s('2193')})`);
  check('721 production immobilisée créditée', s('721') === -3680000, `(${s('721')})`);
  check('les charges restent en charges (661 intact)', s('661') === 4000000, `(${s('661')})`);

  const e1: any = await withUser(u, (c) => officiels.etatsOfficiels(c, d.id, fy));
  const p = (t: any[], r: string) => t.find((l: any) => l.ref === r);
  check('bilan équilibré après capitalisation', e1.controles.equilibreBilan.ok, `(écart ${e1.controles.equilibreBilan.ecart})`);
  check('en-cours au poste AF du bilan', p(e1.bilanActif, 'AF')?.net === 3680000, `(${p(e1.bilanActif, 'AF')?.net})`);
  check('production immobilisée au poste TF', p(e1.compteResultat, 'TF')?.montant === 3680000, `(${p(e1.compteResultat, 'TF')?.montant})`);

  const mes = await withUser(u, (c) => wip.mettreEnService(c, d.id, w.id, { date: '2026-07-01', durationYears: 3 }, u));
  check('mise en service : immobilisation créée', !!mes.assetId && mes.montant === 3680000);

  const tb2 = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  const s2 = (code: string) => tb2.find((r: any) => r.account_code === code)?.balance ?? 0;
  check('2193 soldé après mise en service', s2('2193') === 0, `(${s2('2193')})`);
  check('212 porte l\'immobilisation', s2('212') === 3680000, `(${s2('212')})`);

  const e2: any = await withUser(u, (c) => officiels.etatsOfficiels(c, d.id, fy));
  check('bilan toujours équilibré', e2.controles.equilibreBilan.ok, `(écart ${e2.controles.equilibreBilan.ecart})`);
  check('résultat toujours recoupé', e2.controles.resultat.ok, `(${e2.controles.resultat.parLesPostes})`);

  const liste = await withUser(u, (c) => wip.listWip(c, d.id));
  check('chantier passé en service', liste[0]?.statut === 'en_service' && liste[0]?.cumul === 3680000);

  let refus = false;
  try { await withUser(u, (c) => wip.capitaliser(c, d.id, w.id, { date: '2026-09-30', montant: 100000 }, u)); }
  catch { refus = true; }
  check('capitalisation refusée après mise en service', refus);

  // ---------------- Rentabilité par activité ----------------
  // L'analytique seule voit les charges et les produits ; elle ignore ce que
  // l'activité a demandé d'investir. Une activité peut afficher une marge et
  // n'avoir jamais remboursé sa mise de départ — c'est ce que ce rapport montre.
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy, journalId: jBQ, entryDate: '2026-09-30',
    description: 'Abonnements Nova encaissés', source: 'manual',
    lines: [
      { accountCode: '521', debit: 1200000 },
      { accountCode: '706', credit: 1200000, analyticAxis: 'NOVA', label: 'Abonnements' },
    ],
  }));

  const rp: any = await withUser(u, (c) => rentab.rentabiliteParActivite(c, d.id, fy));
  const nova = rp.activites.find((a: any) => a.code === 'NOVA');
  check('rentabilité · activité NOVA présente', !!nova, `(${rp.activites.length} activité(s))`);
  check('rentabilité · produits de l\'exercice = 1 200 000', nova?.exercice.produits === 1200000, `(${nova?.exercice.produits})`);
  check('rentabilité · charges de l\'exercice = 4 600 000', nova?.exercice.charges === 4600000, `(${nova?.exercice.charges})`);
  check('rentabilité · investissement rattaché = 3 680 000', nova?.investissement.immobilise === 3680000, `(${nova?.investissement.immobilise})`);
  check('rentabilité · immobilisation héritée de la section', nova?.investissement.nbImmobilisations === 1, `(${nova?.investissement.nbImmobilisations})`);
  check('rentabilité · retour calculé, rien remboursé', nova?.retour.ratio != null && nova.retour.ratio < 0, `(${nova?.retour.ratio} %)`);
  check('rentabilité · VNC reprise', (nova?.investissement.vnc ?? 0) > 0, `(${nova?.investissement.vnc})`);

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
