import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import { etatsOfficiels } from './domain/etats-officiels.js';
import { pnlMensuel, pnlDetail } from './domain/pnl-mensuel.js';

// ============================================================================
// COMPTE DE RÉSULTAT MENSUALISÉ.
//
// Ce que le test verrouille :
//
//  • le cumul des mois retombe EXACTEMENT sur le compte de résultat annuel —
//    sinon la grille et l'état officiel racontent deux histoires du même
//    exercice, et c'est celle qu'on regarde le plus qui gagne ;
//  • chaque poste tombe dans le bon mois : un loyer passé onze fois sur douze
//    doit se voir dans la colonne vide, pas se fondre dans un total annuel ;
//  • la descente rend les VRAIES écritures, et leur somme égale la case d'où
//    l'on est parti — un détail qui ne recoupe pas sa case ne sert à rien ;
//  • un solde intermédiaire (marge, valeur ajoutée) refuse la descente en le
//    disant, au lieu de rendre une liste vide qu'on croirait exhaustive ;
//  • un mois hors des bornes de l'exercice apparaît en clair.
//
//   npm run test:pnl   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME Revue', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jVE = await withUser(u, (c) => acc.createJournal(c, d.id, 'VE', 'Ventes', 'ventes'));
  const jOD = await withUser(u, (c) => acc.createJournal(c, d.id, 'OD', 'Opérations diverses', 'operations_diverses'));

  const post = (jid: string, date: string, desc: string, lines: any[]) =>
    withUser(u, (c) => acc.postEntry(c, {
      dossierId: d.id, fiscalYearId: fy, journalId: jid, entryDate: date, description: desc, source: 'manual', lines,
    }));

  // Douze mois de loyer… sauf un. C'est exactement ce qu'une revue d'arrêté
  // cherche, et ce qu'un total annuel ne montre jamais.
  const moisAvecLoyer = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '12'];
  for (const mo of moisAvecLoyer) {
    await post(jOD, `2026-${mo}-05`, `Loyer ${mo}`,
      [{ accountCode: '6221', debit: 300000 }, { accountCode: '4011', credit: 300000 }]);
  }
  // Des ventes, dont deux le même mois.
  await post(jVE, '2026-03-10', 'Prestation mars',
    [{ accountCode: '4111', debit: 1200000 }, { accountCode: '7061', credit: 1200000 }]);
  await post(jVE, '2026-06-12', 'Prestation juin A',
    [{ accountCode: '4111', debit: 800000 }, { accountCode: '7061', credit: 800000 }]);
  await post(jVE, '2026-06-25', 'Prestation juin B',
    [{ accountCode: '4111', debit: 500000 }, { accountCode: '7061', credit: 500000 }]);
  // Une charge de personnel.
  await post(jOD, '2026-06-30', 'Salaires juin',
    [{ accountCode: '6611', debit: 450000 }, { accountCode: '422', credit: 450000 }]);

  const g = await withUser(u, (c) => pnlMensuel(c, d.id, fy));

  // ---------------- Articulation avec l'état officiel ----------------
  const off = await withUser(u, (c) => etatsOfficiels(c, d.id, fy));
  const xiOfficiel = off.compteResultat.find((x) => x.ref === 'XI')?.montant ?? 0;
  check('la grille annonce douze colonnes pour un exercice civil', g.mois.length === 12, `(${g.mois.length})`);
  check('le cumul des mois retombe sur le résultat annuel', g.controle.ok,
    `(mensuel ${g.controle.cumulMensuel} / annuel ${g.controle.resultatAnnuel})`);
  check("et sur celui de l'état officiel, calculé à part",
    Math.abs(g.controle.cumulMensuel - Number(xiOfficiel)) < 0.5,
    `(${g.controle.cumulMensuel} vs ${xiOfficiel})`);

  // ---------------- Chaque montant dans son mois ----------------
  const idx = (cle: string) => g.mois.findIndex((m) => m.cle === cle);
  const ligne = (ref: string) => g.lignes.find((l) => l.ref === ref);

  const ca = ligne('XB');
  check('le chiffre d\'affaires de mars est isolé', ca?.mensuel[idx('2026-03')] === 1200000, `(${ca?.mensuel[idx('2026-03')]})`);
  check('juin cumule ses deux prestations', ca?.mensuel[idx('2026-06')] === 1300000, `(${ca?.mensuel[idx('2026-06')]})`);
  check('un mois sans vente reste à zéro', ca?.mensuel[idx('2026-05')] === 0, `(${ca?.mensuel[idx('2026-05')]})`);
  check('le CA annuel est la somme des mois', ca?.total === 2500000, `(${ca?.total})`);

  // Le loyer : une charge, donc négative, et un trou en novembre.
  const services = ligne('RH');
  check('les charges sont négatives, pour que tout s\'additionne',
    (services?.mensuel[idx('2026-01')] ?? 0) === -300000, `(${services?.mensuel[idx('2026-01')]})`);
  check('LE TROU DE NOVEMBRE SE VOIT', services?.mensuel[idx('2026-11')] === 0, `(${services?.mensuel[idx('2026-11')]})`);
  check('onze loyers, pas douze', services?.total === -3300000, `(${services?.total})`);

  // ---------------- Descente jusqu'aux écritures ----------------
  const det = await withUser(u, (c) => pnlDetail(c, d.id, 'RH', { mois: '2026-01', fiscalYearId: fy }));
  check('la descente rend les écritures du mois', det.lignes.length === 1, `(${det.lignes.length})`);
  check('et son total recoupe la case de la grille',
    det.total === services?.mensuel[idx('2026-01')], `(${det.total} vs ${services?.mensuel[idx('2026-01')]})`);
  check('le détail par compte accompagne', det.parCompte.some((x) => x.compte === '6221'),
    `(${det.parCompte.map((x) => x.compte).join(',')})`);
  check('chaque ligne porte sa pièce et son journal',
    !!det.lignes[0].journal && det.lignes[0].date === '2026-01-05', `(${det.lignes[0].date})`);

  const detAn = await withUser(u, (c) => pnlDetail(c, d.id, 'RH', { fiscalYearId: fy }));
  check('sans mois précisé, on obtient l\'année entière', detAn.lignes.length === 11, `(${detAn.lignes.length})`);
  check('et son total recoupe la colonne Total', detAn.total === services?.total, `(${detAn.total} vs ${services?.total})`);

  const detCa = await withUser(u, (c) => pnlDetail(c, d.id, 'TC', { mois: '2026-06', fiscalYearId: fy }));
  check('un poste de produit descend aussi', detCa.total === 1300000, `(${detCa.total})`);
  check('les deux ventes de juin sont là', detCa.lignes.length === 2, `(${detCa.lignes.length})`);

  // ---------------- Un solde calculé refuse la descente ----------------
  let refus = false; let motif = '';
  try { await withUser(u, (c) => pnlDetail(c, d.id, 'XC', { fiscalYearId: fy })); }
  catch (e: any) { refus = true; motif = e.message; }
  check('la valeur ajoutée refuse la descente', refus);
  check('et elle dit pourquoi, au lieu de rendre une liste vide',
    /solde calculé/.test(motif), `(${motif.slice(0, 60)}…)`);

  let refusRef = false;
  try { await withUser(u, (c) => pnlDetail(c, d.id, 'ZZ', { fiscalYearId: fy })); } catch { refusRef = true; }
  check('un poste inconnu est refusé', refusRef);

  // ---------------- Un mois hors bornes se voit ----------------
  // Écriture datée de 2027 mais rattachée à l'exercice 2026 : elle ne doit pas
  // se fondre dans une colonne voisine.
  const e2027 = await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy, journalId: jOD, entryDate: '2026-12-31',
    description: 'Écriture à redater', source: 'manual', status: 'draft',
    lines: [{ accountCode: '6221', debit: 90000 }, { accountCode: '4011', credit: 90000 }],
  }));
  await withUser(u, (c) => c.query(
    "update entries set entry_date='2027-01-15' where dossier_id=$1 and id=$2", [d.id, e2027.id]));
  await withUser(u, (c) => c.query("update entries set status='posted' where dossier_id=$1 and id=$2", [d.id, e2027.id]));

  const g2 = await withUser(u, (c) => pnlMensuel(c, d.id, fy));
  check('le mois hors bornes apparaît en colonne', g2.mois.some((m) => m.cle === '2027-01'),
    `(${g2.mois.map((m) => m.cle).join(',')})`);
  check('et le cumul reste articulé avec l\'annuel', g2.controle.ok,
    `(${g2.controle.cumulMensuel} / ${g2.controle.resultatAnnuel})`);

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
