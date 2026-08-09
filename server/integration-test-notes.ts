import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import * as notes from './domain/notes-annexes.js';

// ============================================================================
// NOTES ANNEXES 3A / 3C — mouvements des immobilisations et des amortissements.
//
// Ce que le test verrouille, et pourquoi :
//
//  • Les mouvements sont LUS, pas déduits. Un moteur qui ne reçoit que deux
//    balances doit inférer les entrées et sorties d'un écart de soldes ; il se
//    trompe dès qu'un exercice est incomplet. Nova lit les à-nouveaux et les
//    mouvements séparément — le cas « acquisition ET cession la même année »,
//    invisible dans un écart de soldes, doit ressortir en clair.
//
//  • La note s'ARTICULE avec le bilan : sa clôture retombe exactement sur la
//    colonne de l'état. Sans ce contrôle, deux tableaux du même dossier
//    peuvent afficher deux valeurs du même parc.
//
//  • Un compte de classe 2 qu'aucun poste ne capte est SIGNALÉ. Un total juste
//    qui cache un compte oublié est pire qu'un total faux.
//
//  • Le registre des immobilisations et la comptabilité sont rapprochés : un
//    bien acheté sans être inscrit au registre ne serait jamais amorti.
//
//   npm run test:notes   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME Immo', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jAN = await withUser(u, (c) => acc.createJournal(c, d.id, 'AN', 'À-nouveaux', 'a_nouveaux'));
  const jOD = await withUser(u, (c) => acc.createJournal(c, d.id, 'OD', 'Opérations diverses', 'operations_diverses'));

  const post = (jid: string, date: string, desc: string, lines: any[], source: any = 'manual') =>
    withUser(u, (c) => acc.postEntry(c, {
      dossierId: d.id, fiscalYearId: fy, journalId: jid, entryDate: date, description: desc, source, lines,
    }));

  // --- Ouverture : un parc déjà constitué, partiellement amorti -------------
  await post(jAN, '2026-01-01', 'À-nouveaux immobilisations', [
    { accountCode: '2441', debit: 12000000 },   // matériel & mobilier  → poste AM
    { accountCode: '245', debit: 8000000 },     // matériel de transport → poste AN
    { accountCode: '2844', credit: 4500000 },
    { accountCode: '2845', credit: 3000000 },
    { accountCode: '101', credit: 12500000 },
  ], 'opening_balance');

  // --- Mouvements de l'exercice --------------------------------------------
  // Le cas qui piège un moteur sur balances : sur le MÊME poste, une
  // acquisition et une cession la même année. L'écart de soldes ne montre que
  // le net ; les deux colonnes de la note, elles, doivent être exactes.
  await post(jOD, '2026-03-10', 'Acquisition véhicule utilitaire',
    [{ accountCode: '245', debit: 6000000 }, { accountCode: '481', credit: 6000000 }]);
  await post(jOD, '2026-09-20', 'Sortie véhicule ancien (valeur brute)',
    [{ accountCode: '812', debit: 5000000 }, { accountCode: '245', credit: 5000000 }]);
  await post(jOD, '2026-09-20', 'Sortie véhicule ancien (amortissements)',
    [{ accountCode: '2845', debit: 2000000 }, { accountCode: '812', credit: 2000000 }]);
  await post(jOD, '2026-12-31', 'Dotations aux amortissements', [
    { accountCode: '6813', debit: 3400000 },
    { accountCode: '2844', credit: 1600000 },
    { accountCode: '2845', credit: 1800000 },
  ]);

  // ---------------- Note 3A : valeurs brutes ----------------
  const n3a = await withUser(u, (c) => notes.note3A(c, d.id, fy));
  const am = n3a.lignes.find((l) => l.ref === 'AM');
  const an = n3a.lignes.find((l) => l.ref === 'AN');

  check('le matériel de transport a sa propre ligne (245 ≠ mobilier)',
    !!an && an.ouverture === 8000000, `(${an?.ouverture})`);
  check('le mobilier reste sur sa ligne', am?.ouverture === 12000000, `(${am?.ouverture})`);

  check('acquisition ET cession du même poste : les deux sont lues',
    an?.augmentations === 6000000 && an?.diminutions === 5000000,
    `(+${an?.augmentations} / −${an?.diminutions})`);
  check('un moteur sur écart de soldes n\'aurait vu que le net (+1 000 000)',
    (an?.augmentations ?? 0) - (an?.diminutions ?? 0) === 1000000);
  check('clôture = ouverture + augmentations − diminutions',
    an?.cloture === 9000000, `(${an?.cloture})`);
  check('un poste sans mouvement garde ouverture = clôture',
    am?.augmentations === 0 && am?.cloture === 12000000, `(${am?.cloture})`);

  check('le détail par compte accompagne chaque ligne',
    (an?.comptes ?? []).some((x) => x.code === '245'), `(${an?.comptes.map((x) => x.code).join(',')})`);

  // ---------------- Note 3C : amortissements ----------------
  const n3c = await withUser(u, (c) => notes.note3C(c, d.id, fy));
  const amAm = n3c.lignes.find((l) => l.ref === 'AM');
  const anAm = n3c.lignes.find((l) => l.ref === 'AN');

  check('les amortissements se présentent en positif',
    anAm?.ouverture === 3000000, `(${anAm?.ouverture})`);
  check('la dotation de l\'exercice est une AUGMENTATION',
    anAm?.augmentations === 1800000, `(${anAm?.augmentations})`);
  check('la reprise sur bien cédé est une DIMINUTION',
    anAm?.diminutions === 2000000, `(${anAm?.diminutions})`);
  check('cumul de clôture = 3 000 000 + 1 800 000 − 2 000 000',
    anAm?.cloture === 2800000, `(${anAm?.cloture})`);
  check('le mobilier cumule sa seule dotation',
    amAm?.cloture === 6100000, `(${amAm?.cloture})`);

  // ---------------- Articulation avec le bilan ----------------
  check('la note 3A retombe exactement sur le bilan', n3a.articulee,
    `(${n3a.articulation.filter((a) => a.ecart).map((a) => `${a.ref}:${a.ecart}`).join(',')})`);
  check('la note 3C aussi', n3c.articulee,
    `(${n3c.articulation.filter((a) => a.ecart).map((a) => `${a.ref}:${a.ecart}`).join(',')})`);

  const tb = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  const brut245 = tb.find((r: any) => r.account_code === '245')?.balance;
  check('et le bilan dit bien ce que dit la comptabilité', brut245 === 9000000, `(${brut245})`);

  // ---------------- Rien ne s'évapore ----------------
  // 2391 est le compte cité au point 1.1 du backlog : selon la lecture retenue
  // du poste AL, il tombe dans un poste ou dans aucun. Quelle que soit la
  // réponse, il ne doit pas s'évaporer — c'est cela que le test fige.
  await post(jOD, '2026-06-01', 'Immobilisation en cours (bâtiment)',
    [{ accountCode: '2391', debit: 750000 }, { accountCode: '481', credit: 750000 }]);
  const n3aBis = await withUser(u, (c) => notes.note3A(c, d.id, fy));
  const capte = n3aBis.lignes.some((l) => l.comptes.some((x) => x.code === '2391'));
  const signale = n3aBis.comptesNonAffectes.some((x) => x.code === '2391');
  check('un compte de classe 2 est soit capté, soit SIGNALÉ — jamais perdu',
    capte || signale, `(capté=${capte}, signalé=${signale})`);

  // ---------------- Rapprochement avec le registre ----------------
  const rap = await withUser(u, (c) => notes.rapprochementRegistre(c, d.id, fy));
  check('le registre est vide alors que la compta porte des immobilisations',
    rap.registreBrut === 0 && rap.comptaBrut > 0, `(registre ${rap.registreBrut} / compta ${rap.comptaBrut})`);
  check('et l\'écart est annoncé, pas tu', rap.concordant === false && rap.ecartBrut !== 0,
    `(écart ${rap.ecartBrut})`);

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
