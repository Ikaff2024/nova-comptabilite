import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import * as analytic from './domain/analytic.js';

// ============================================================================
// PLUSIEURS AXES ANALYTIQUES.
//
// Ce que le test verrouille, et pourquoi chaque point compte :
//
//   • un dossier naît avec son axe principal — aucun chemin de création ne peut
//     l'oublier, sinon la comptabilité analytique serait cassée pour ce dossier ;
//   • sans axe demandé, tout se comporte EXACTEMENT comme avant : c'est la
//     promesse faite aux dossiers mono-axe, qui sont la majorité ;
//   • un axe secondaire lit les mêmes écritures sous un autre découpage, et les
//     deux lectures donnent le MÊME total — sinon l'une des deux ment ;
//   • le croisement des deux axes est la raison d'être de la structure ;
//   • l'extourne recopie la ventilation : une contre-passation qui la perdrait
//     laisserait la charge dans sa section et son annulation nulle part, et
//     l'erreur ne se verrait qu'au total, où elle est nulle ;
//   • une section rattachée au mauvais axe fait ÉCHOUER l'écriture au lieu de
//     disparaître en silence ;
//   • l'axe principal ne se supprime pas : il porte la ventilation historique.
//
//   npm run test:axes   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME Multi-axes', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jVE = await withUser(u, (c) => acc.createJournal(c, d.id, 'VE', 'Ventes', 'ventes'));
  const jAC = await withUser(u, (c) => acc.createJournal(c, d.id, 'AC', 'Achats', 'achats'));

  // ---------------- L'axe principal existe d'office ----------------
  const axes0 = await withUser(u, (c) => analytic.listAxes(c, d.id));
  check('un dossier naît avec un axe principal', axes0.length === 1 && axes0[0].isPrimary, `(${axes0.map((a) => a.code).join(',')})`);

  // ---------------- Deux axes, deux découpages ----------------
  await withUser(u, (c) => analytic.createSection(c, d.id, 'COCODY', 'Agence Cocody'));
  await withUser(u, (c) => analytic.createSection(c, d.id, 'YOPOUGON', 'Agence Yopougon'));
  const axAct = await withUser(u, (c) => analytic.createAxe(c, d.id, 'activite', 'Activité'));
  check("le code d'axe est normalisé en majuscules",
    (await withUser(u, (c) => analytic.listAxes(c, d.id))).some((a) => a.code === 'ACTIVITE'));
  await withUser(u, (c) => analytic.createSection(c, d.id, 'NEGOCE', 'Négoce', 'ACTIVITE'));
  await withUser(u, (c) => analytic.createSection(c, d.id, 'SERVICES', 'Services', 'ACTIVITE'));

  // Le défaut protège les six écrans qui remplissent l'axe PRINCIPAL : leur
  // rendre les sections de tous les axes leur ferait écrire une agence dans le
  // champ activité, sans que rien ne le signale.
  const secDefaut = await withUser(u, (c) => analytic.listSections(c, d.id));
  check("par défaut, seules les sections de l'axe principal sont listées",
    secDefaut.length === 2 && secDefaut.every((s: any) => s.axisIsPrimary),
    `(${secDefaut.map((s: any) => s.code).join(',')})`);
  const secToutes = await withUser(u, (c) => analytic.listSections(c, d.id, 'all'));
  check("« all » rend les sections de tous les axes", secToutes.length === 4, `(${secToutes.length})`);

  let refusDoublon = false;
  try { await withUser(u, (c) => analytic.createSection(c, d.id, 'NEGOCE', 'Autre', undefined)); } catch { refusDoublon = true; }
  check('un code de section reste unique dans tout le dossier', refusDoublon);

  const post = (jid: string, date: string, desc: string, lines: any[]) =>
    withUser(u, (c) => acc.postEntry(c, { dossierId: d.id, fiscalYearId: fy, journalId: jid, entryDate: date, description: desc, source: 'manual', lines }));

  // Cocody vend du négoce ET du service ; Yopougon ne fait que du service.
  await post(jVE, '2026-03-10', 'Vente marchandises Cocody',
    [{ accountCode: '521', debit: 1000000 }, { accountCode: '701', credit: 1000000, analyticAxis: 'COCODY', axes: { ACTIVITE: 'NEGOCE' } }]);
  await post(jVE, '2026-03-15', 'Prestation Cocody',
    [{ accountCode: '521', debit: 400000 }, { accountCode: '706', credit: 400000, analyticAxis: 'COCODY', axes: { ACTIVITE: 'SERVICES' } }]);
  await post(jVE, '2026-04-12', 'Prestation Yopougon',
    [{ accountCode: '521', debit: 600000 }, { accountCode: '706', credit: 600000, analyticAxis: 'YOPOUGON', axes: { ACTIVITE: 'SERVICES' } }]);
  const achat = await post(jAC, '2026-04-20', 'Achat marchandises Cocody',
    [{ accountCode: '601', debit: 300000, analyticAxis: 'COCODY', axes: { ACTIVITE: 'NEGOCE' } }, { accountCode: '401', credit: 300000 }]);

  // ---------------- Sans axe demandé : le comportement d'avant ----------------
  const parDefaut = await withUser(u, (c) => analytic.analyticReport(c, d.id, fy));
  const parPrincipal = await withUser(u, (c) => analytic.analyticReport(c, d.id, fy, 'SECTION'));
  check("sans axe demandé, c'est l'axe principal", parDefaut.axe.isPrimary && parDefaut.axe.code === 'SECTION', `(${parDefaut.axe.code})`);
  check('et le résultat est identique à la demande explicite',
    JSON.stringify(parDefaut.sections) === JSON.stringify(parParDefautSections(parPrincipal)),
    `(${parDefaut.sections.length} vs ${parPrincipal.sections.length})`);

  const cocody = parDefaut.sections.find((s: any) => s.code === 'COCODY');
  check('agence Cocody : 1 400 000 de produits, 300 000 de charges',
    cocody?.produits === 1400000 && cocody?.charges === 300000, `(${cocody?.produits} / ${cocody?.charges})`);

  // ---------------- L'axe secondaire : autre découpage, même total ----------------
  const parActivite = await withUser(u, (c) => analytic.analyticReport(c, d.id, fy, 'ACTIVITE'));
  const negoce = parActivite.sections.find((s: any) => s.code === 'NEGOCE');
  const services = parActivite.sections.find((s: any) => s.code === 'SERVICES');
  check('négoce : 1 000 000 de produits, 300 000 de charges',
    negoce?.produits === 1000000 && negoce?.charges === 300000, `(${negoce?.produits} / ${negoce?.charges})`);
  check('services : 1 000 000 de produits, aucune charge',
    services?.produits === 1000000 && services?.charges === 0, `(${services?.produits} / ${services?.charges})`);
  check('les deux axes donnent le même résultat total',
    parDefaut.totals.resultat === parActivite.totals.resultat,
    `(agences ${parDefaut.totals.resultat} / activités ${parActivite.totals.resultat})`);

  // ---------------- Le croisement, raison d'être de la structure ----------------
  const croise = await withUser(u, (c) => analytic.analyticCross(c, d.id, 'SECTION', 'ACTIVITE', fy));
  const ligneCocody = croise.lignes.find((l: any) => l.code === 'COCODY');
  const colNegoce = croise.colonnes.findIndex((c: any) => c.code === 'NEGOCE');
  const colServices = croise.colonnes.findIndex((c: any) => c.code === 'SERVICES');
  check('Cocody × négoce = 1 000 000 − 300 000', ligneCocody?.cells[colNegoce] === 700000, `(${ligneCocody?.cells[colNegoce]})`);
  check('Cocody × services = 400 000', ligneCocody?.cells[colServices] === 400000, `(${ligneCocody?.cells[colServices]})`);
  const ligneYop = croise.lignes.find((l: any) => l.code === 'YOPOUGON');
  check('Yopougon ne fait pas de négoce', ligneYop?.cells[colNegoce] === 0, `(${ligneYop?.cells[colNegoce]})`);
  check('le croisement boucle sur le résultat global',
    croise.total === parDefaut.totals.resultat, `(${croise.total} vs ${parDefaut.totals.resultat})`);

  let refusMemeAxe = false;
  try { await withUser(u, (c) => analytic.analyticCross(c, d.id, 'ACTIVITE', 'ACTIVITE', fy)); } catch { refusMemeAxe = true; }
  check('croiser un axe avec lui-même est refusé', refusMemeAxe);

  // ---------------- Une section au mauvais axe fait échouer l'écriture --------
  let refusMauvaisAxe = false;
  try {
    await post(jVE, '2026-05-01', 'Vente mal ventilée',
      [{ accountCode: '521', debit: 100 }, { accountCode: '701', credit: 100, axes: { ACTIVITE: 'COCODY' } }]);
  } catch { refusMauvaisAxe = true; }
  check("une section rattachée au mauvais axe est refusée, pas ignorée", refusMauvaisAxe);
  const apresRefus = await withUser(u, (c) => analytic.analyticReport(c, d.id, fy, 'ACTIVITE'));
  check("et l'écriture entière n'est pas entrée",
    apresRefus.totals.produits === parActivite.totals.produits,
    `(${apresRefus.totals.produits} vs ${parActivite.totals.produits})`);

  // ---------------- L'extourne ANNULE, elle n'inverse pas ----------------
  // Défaut 0075 : l'origine basculait en statut 'reversed', donc hors des
  // comptes, tandis que son extourne y restait — le compte finissait au montant
  // OPPOSÉ au lieu de zéro. Les deux écritures doivent cohabiter.
  const avantExtourne = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  check('avant extourne, le 601 porte la charge',
    Number(avantExtourne.find((r: any) => r.account_code === '601')?.balance) === 300000,
    `(${avantExtourne.find((r: any) => r.account_code === '601')?.balance})`);

  await withUser(u, (c) => acc.reverseEntry(c, achat.id));

  const apresTb = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  const solde601 = Number(apresTb.find((r: any) => r.account_code === '601')?.balance ?? 0);
  check('après extourne, le 601 revient à zéro (et non à −300 000)', solde601 === 0, `(${solde601})`);
  const solde401 = Number(apresTb.find((r: any) => r.account_code === '401')?.balance ?? 0);
  check('le compte fournisseur revient à zéro aussi', solde401 === 0, `(${solde401})`);

  const jrn = await withUser(u, (c) => acc.journalEntries(c, d.id, { fiscalYearId: fy }));
  const origine = jrn.find((l: any) => l.entry_id === achat.id);
  check("l'écriture d'origine reste au journal, marquée contre-passée",
    !!origine && origine.is_reversed === true, `(${origine ? 'présente' : 'absente'})`);
  check("l'extourne y figure aussi", jrn.some((l: any) => l.is_reversal === true));

  const apresExtourne = await withUser(u, (c) => analytic.analyticReport(c, d.id, fy, 'ACTIVITE'));
  const negoceApres = apresExtourne.sections.find((s: any) => s.code === 'NEGOCE');
  check("l'extourne annule la charge SUR SON AXE secondaire",
    (negoceApres?.charges ?? 0) === 0, `(${negoceApres?.charges ?? 0})`);
  const nonVentileApres = apresExtourne.sections.find((s: any) => s.code === '—');
  check("rien n'est retombé dans le non-ventilé",
    !nonVentileApres || nonVentileApres.charges === 0, `(${nonVentileApres?.charges ?? 0})`);

  // ---------------- Garde-fous sur les axes ----------------
  let refusSuppr = false;
  const principal = (await withUser(u, (c) => analytic.listAxes(c, d.id))).find((a) => a.isPrimary)!;
  try { await withUser(u, (c) => analytic.deleteAxe(c, d.id, principal.id)); } catch { refusSuppr = true; }
  check("l'axe principal ne se supprime pas", refusSuppr);

  let refusSupprUtilise = false;
  try { await withUser(u, (c) => analytic.deleteAxe(c, d.id, axAct.id)); } catch { refusSupprUtilise = true; }
  check('un axe qui porte des ventilations ne se supprime pas non plus', refusSupprUtilise);

  const axVide = await withUser(u, (c) => analytic.createAxe(c, d.id, 'CHANTIER', 'Chantier'));
  await withUser(u, (c) => analytic.deleteAxe(c, d.id, axVide.id));
  check('un axe inutilisé se supprime',
    !(await withUser(u, (c) => analytic.listAxes(c, d.id))).some((a) => a.code === 'CHANTIER'));

  // ---------------- Détail et vue mensuelle suivent l'axe ----------------
  const detail = await withUser(u, (c) => analytic.analyticDetail(c, d.id, 'SERVICES', fy, 'ACTIVITE'));
  check("le détail d'une section secondaire retrouve ses lignes",
    detail.lines.length === 2 && detail.totals.produits === 1000000,
    `(${detail.lines.length} lignes, ${detail.totals.produits})`);
  const mensuel = await withUser(u, (c) => analytic.analyticMonthly(c, d.id, fy, 'ACTIVITE'));
  const ligneServices = mensuel.sections.find((s: any) => s.code === 'SERVICES');
  check('la vue mensuelle ventile sur le bon axe',
    ligneServices?.total === 1000000, `(${ligneServices?.total})`);

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}

// Les deux appels doivent produire la même liste de sections.
function parParDefautSections(r: any) { return r.sections; }

main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
