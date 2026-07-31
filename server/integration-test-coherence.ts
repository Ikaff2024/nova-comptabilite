import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import * as payroll from './domain/payroll.js';
import { globalCoherence } from './domain/coherence.js';

// ============================================================================
// COHÉRENCE INTER-MODULES — ce que le moteur a le droit d'affirmer.
//
// Un contrôle de cohérence parle à un dirigeant, souvent par mail, sans que
// personne ne relise. Un diagnostic faux y coûte plus cher qu'une absence de
// diagnostic : le lecteur part chercher une erreur qui n'existe pas, et la fois
// suivante il n'ouvre plus.
//
// Ce que le test verrouille :
//   • un 661 mouvementé SANS bulletin n'est pas un « écart » : c'est une paie
//     tenue hors de Nova, et ça se dit comme tel ;
//   • le contrôle des charges patronales se tait dans ce cas au lieu de répéter
//     le même constat sous un autre nom ;
//   • quand les deux côtés existent et divergent, l'écart est bien annoncé.
//
//   npm run test:coherence   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

const annee = new Date().getUTCFullYear();

async function dossierAvecSalaires(u: string, brut: number) {
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, `Exercice ${annee}`, `${annee}-01-01`, `${annee}-12-31`));
  const j = await withUser(u, (c) => acc.createJournal(c, d.id, 'OD', 'Opérations diverses', 'operations_diverses'));
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy, journalId: j,
    entryDate: `${annee}-06-30`, description: 'Salaires du mois', source: 'manual',
    lines: [{ accountCode: '661', debit: brut }, { accountCode: '422', credit: brut }],
  }));
  return d;
}

async function main() {
  // --- Cas 1 : des salaires en 661, aucun bulletin dans le module Paie -------
  const u1 = randomUUID();
  const d1 = await dossierAvecSalaires(u1, 4800000);
  const co1 = await withUser(u1, (c) => globalCoherence(c, d1.id));
  const chk1 = co1.controles.find((x) => x.regle === 'masse_salariale_661');

  check('un 661 sans bulletin est relevé', !!chk1);
  check("le niveau reste informatif, pas une anomalie", chk1?.niveau === 'info', `(${chk1?.niveau})`);
  check("le diagnostic dit « paie tenue hors de Nova »", /hors de Nova/i.test(chk1?.libelle ?? ''), `(${chk1?.libelle})`);
  check("le mot « écart » n'est pas employé", !/écart/i.test(chk1?.explication ?? ''), `(${chk1?.explication?.slice(0, 80)}…)`);
  check('le contrôle des charges patronales se tait',
    !co1.controles.some((x) => x.regle === 'charges_patronales_664'),
    `(${co1.controles.map((x) => x.regle).join(', ')})`);
  check("aucune anomalie haute ou moyenne n'est levée",
    co1.resume.haute === 0 && co1.resume.moyenne === 0, `(h=${co1.resume.haute} m=${co1.resume.moyenne})`);

  // --- Cas 2 : des bulletins, et un 661 qui ne suit pas ---------------------
  const u2 = randomUUID();
  const d2 = await dossierAvecSalaires(u2, 200000);
  await withUser(u2, (c) => payroll.createEmployee(c, d2.id, {
    matricule: 'S001', nom: 'TRAORE', prenoms: 'Aya', dateEmbauche: '2024-01-15',
    poste: 'Employé', categorie: 'Employé', statutMatrimonial: 'Célibataire',
    salaireBase: 500000, dateNaissance: '1994-04-04',
  }));
  await withUser(u2, (c) => payroll.runPayroll(c, d2.id, annee, 5, {}));
  const co2 = await withUser(u2, (c) => globalCoherence(c, d2.id));
  const chk2 = co2.controles.find((x) => x.regle === 'masse_salariale_661');
  check("bulletins et 661 divergents : l'écart est annoncé", chk2?.niveau === 'moyenne', `(${chk2?.niveau})`);
  check('les deux montants sont cités', /écart/i.test(chk2?.explication ?? ''), `(${chk2?.explication?.slice(0, 80)}…)`);
  check('le contrôle des charges patronales reprend la parole',
    co2.controles.some((x) => x.regle === 'charges_patronales_664'));

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
