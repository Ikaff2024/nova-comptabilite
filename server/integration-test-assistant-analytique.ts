import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import * as analytic from './domain/analytic.js';
import * as assist from './domain/analytique-assistant.js';

// ============================================================================
// ASSISTANT DE MISE EN PLACE ANALYTIQUE.
//
// Ce que le test verrouille, et pourquoi :
//
//  • l'assistant est REJOUABLE : relancé, il ignore ce qui existe au lieu de
//    dupliquer ou d'écraser un ajustement fait à la main ;
//  • le premier axe prend la place de l'axe principal tant que celui-ci est
//    vierge — sinon le dossier garde à vie un « Section analytique » vide à
//    côté du vrai découpage ;
//  • l'axe PRINCIPAL refuse la ventilation rétroactive, EN DISANT POURQUOI :
//    ses valeurs vivent dans l'écriture, et une écriture comptabilisée est
//    immuable. C'est la contrainte qui justifie toute la conception ;
//  • un axe secondaire, lui, se ventile rétroactivement sans toucher au grand
//    livre — et l'aperçu annonce exactement ce qui sera touché avant de
//    l'appliquer ;
//  • une règle sans critère est refusée : elle ventilerait tout ;
//  • les suggestions viennent de l'HISTORIQUE DU DOSSIER, avec leurs
//    précédents. Une seule occurrence ne fait pas une habitude.
//
//   npm run test:assistant-analytique   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME Analytique', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jOD = await withUser(u, (c) => acc.createJournal(c, d.id, 'OD', 'Opérations diverses', 'operations_diverses'));
  const post = (date: string, desc: string, lines: any[]) =>
    withUser(u, (c) => acc.postEntry(c, {
      dossierId: d.id, fiscalYearId: fy, journalId: jOD, entryDate: date, description: desc, source: 'manual', lines,
    }));

  // ---------------- Les modèles ----------------
  const modeles = assist.modelesActivite();
  check('des modèles sont proposés par activité', modeles.length >= 5, `(${modeles.length})`);
  const btp = modeles.find((m) => m.cle === 'btp');
  check('le BTP propose un axe Chantier', btp?.axes.some((a) => a.code === 'CHANTIER') === true);
  check("un axe dont les sections sont propres à l'entreprise n'en invente aucune",
    btp?.axes.find((a) => a.code === 'CHANTIER')?.sections.length === 0);
  check('mais il explique quoi y mettre',
    (btp?.axes.find((a) => a.code === 'CHANTIER')?.aide ?? '').length > 20);
  check('un axe générique, lui, propose ses sections',
    (btp?.axes.find((a) => a.code === 'NATURE')?.sections.length ?? 0) >= 3);

  // ---------------- Création en une passe ----------------
  const commerce = modeles.find((m) => m.cle === 'commerce')!;
  const r1 = await withUser(u, (c) => assist.appliquerModele(c, d.id, [
    { code: 'PDV', label: 'Point de vente', sections: [{ code: 'COCODY', label: 'Boutique Cocody' }, { code: 'YOP', label: 'Boutique Yopougon' }] },
    ...commerce.axes.filter((a) => a.code === 'ACTIVITE').map((a) => ({ code: a.code, label: a.label, sections: a.sections })),
  ], u));

  check("l'axe principal, encore vierge, est renommé au lieu d'être doublé",
    r1.principalRenomme === 'PDV', `(${r1.principalRenomme})`);
  const axes = await withUser(u, (c) => analytic.listAxes(c, d.id));
  check('deux axes en tout, pas trois', axes.length === 2, `(${axes.map((a) => a.code).join(',')})`);
  check("« Point de vente » est bien l'axe principal",
    axes.find((a) => a.isPrimary)?.code === 'PDV', `(${axes.find((a) => a.isPrimary)?.code})`);
  check('les sections sont créées', r1.sectionsCreees.length === 4, `(${r1.sectionsCreees.join(',')})`);

  // Rejouer l'assistant ne doit rien casser.
  const r2 = await withUser(u, (c) => assist.appliquerModele(c, d.id, [
    { code: 'PDV', label: 'Point de vente', sections: [{ code: 'COCODY', label: 'Autre nom' }] },
  ], u));
  check('rejoué, il ne crée rien en double', r2.axesCrees.length === 0 && r2.sectionsCreees.length === 0,
    `(${r2.axesCrees.join(',')} / ${r2.sectionsCreees.join(',')})`);
  check('et il dit ce qu\'il a ignoré', r2.ignores.length === 2, `(${r2.ignores.join(' | ')})`);
  const secs = await withUser(u, (c) => analytic.listSections(c, d.id, 'all'));
  check("un intitulé ajusté à la main n'est pas écrasé",
    secs.find((s: any) => s.code === 'COCODY')?.label === 'Boutique Cocody',
    `(${secs.find((s: any) => s.code === 'COCODY')?.label})`);

  // ---------------- Des écritures déjà passées, non ventilées ----------------
  for (const [mo, montant] of [['01', 300000], ['02', 300000], ['03', 300000]] as [string, number][]) {
    await post(`2026-${mo}-05`, `Loyer ${mo}`,
      [{ accountCode: '6221', debit: montant }, { accountCode: '4011', credit: montant }]);
  }
  await post('2026-04-10', 'Vente marchandises',
    [{ accountCode: '4111', debit: 900000 }, { accountCode: '7011', credit: 900000 }]);

  // ---------------- L'axe principal refuse le rétroactif ----------------
  const etatP = await withUser(u, (c) => assist.etatVentilation(c, d.id, 'PDV', fy));
  check("l'axe principal se déclare non rétroactif", etatP.retroactif === false);
  check('et il explique que le grand livre est immuable',
    /immuable/.test(etatP.message), `(${etatP.message.slice(0, 50)}…)`);

  let refusPrincipal = false; let motif = '';
  try {
    await withUser(u, (c) => assist.apercuVentilation(c, d.id, { axe: 'PDV', section: 'COCODY', comptes: ['6221'] }, fy));
  } catch (e: any) { refusPrincipal = true; motif = e.message; }
  check("ventiler l'axe principal après coup est refusé", refusPrincipal);
  check('et le message oriente vers un axe secondaire', /axe secondaire/.test(motif), `(${motif.slice(0, 60)}…)`);

  // ---------------- L'axe secondaire, lui, se ventile ----------------
  const etatA = await withUser(u, (c) => assist.etatVentilation(c, d.id, 'ACTIVITE', fy));
  check("l'axe secondaire est rétroactif", etatA.retroactif === true);
  check('il compte les lignes de gestion non ventilées', etatA.nonVentilees === 4, `(${etatA.nonVentilees})`);

  const ap = await withUser(u, (c) => assist.apercuVentilation(c, d.id,
    { axe: 'ACTIVITE', section: 'SERVICES', comptes: ['6221'] }, fy));
  check("l'aperçu annonce exactement ce qui sera touché", ap.nb === 3, `(${ap.nb})`);
  check('avec le montant en jeu', ap.montant === -900000, `(${ap.montant})`);
  check('et des exemples pour juger sur pièce', ap.exemples.length === 3, `(${ap.exemples.length})`);

  const etatAvant = await withUser(u, (c) => assist.etatVentilation(c, d.id, 'ACTIVITE', fy));
  const appl = await withUser(u, (c) => assist.appliquerVentilation(c, d.id,
    { axe: 'ACTIVITE', section: 'SERVICES', comptes: ['6221'] }, fy));
  check('la ventilation applique le nombre annoncé', appl.ventilees === ap.nb, `(${appl.ventilees} vs ${ap.nb})`);

  const etatApres = await withUser(u, (c) => assist.etatVentilation(c, d.id, 'ACTIVITE', fy));
  check('le compteur de non-ventilées baisse d\'autant',
    etatAvant.nonVentilees - etatApres.nonVentilees === appl.ventilees,
    `(${etatAvant.nonVentilees} → ${etatApres.nonVentilees})`);

  // Le résultat analytique le voit immédiatement — sans qu'aucune écriture n'ait bougé.
  const rap = await withUser(u, (c) => analytic.analyticReport(c, d.id, fy, 'ACTIVITE'));
  const services = rap.sections.find((s: any) => s.code === 'SERVICES');
  check("le résultat analytique reflète la ventilation rétroactive",
    services?.charges === 900000, `(${services?.charges})`);

  // Rejouer la même règle ne double rien.
  const appl2 = await withUser(u, (c) => assist.appliquerVentilation(c, d.id,
    { axe: 'ACTIVITE', section: 'SERVICES', comptes: ['6221'] }, fy));
  check('rejouée, la règle ne ventile plus rien', appl2.ventilees === 0, `(${appl2.ventilees})`);

  // ---------------- Garde-fous ----------------
  let refusVide = false;
  try { await withUser(u, (c) => assist.apercuVentilation(c, d.id, { axe: 'ACTIVITE', section: 'NEGOCE' }, fy)); }
  catch { refusVide = true; }
  check('une règle sans aucun critère est refusée', refusVide);

  let refusSection = false;
  try {
    await withUser(u, (c) => assist.appliquerVentilation(c, d.id,
      { axe: 'ACTIVITE', section: 'COCODY', comptes: ['7011'] }, fy));
  } catch { refusSection = true; }
  check("une section d'un autre axe est refusée", refusSection);

  // ---------------- Suggestions apprises du dossier ----------------
  // Deux ventes de plus sur le même compte, ventilées à la main : cela fait
  // une habitude, donc une suggestion pour les suivantes.
  for (const mo of ['05', '06']) {
    const e = await post(`2026-${mo}-12`, `Vente ${mo}`,
      [{ accountCode: '4111', debit: 400000 }, { accountCode: '7011', credit: 400000 }]);
    const { rows } = await withUser(u, (c) => c.query(
      `select l.id from entry_lines l join accounts a on a.id=l.account_id
        where l.entry_id=$1 and a.account_code='7011'`, [e.id]));
    await withUser(u, (c) => analytic.setLineAxis(c, d.id, rows[0].id, 'ACTIVITE', 'NEGOCE'));
  }

  const sug = await withUser(u, (c) => assist.suggestionsVentilation(c, d.id, 'ACTIVITE', fy));
  const s7011 = sug.find((x) => x.compte === '7011');
  check('une habitude du dossier devient une suggestion', s7011?.section === 'NEGOCE', `(${s7011?.section})`);
  check('avec le nombre de précédents qui la soutiennent', s7011?.precedents === 2, `(${s7011?.precedents})`);
  check('et le nombre de lignes qu\'elle traiterait', s7011?.concernees === 1, `(${s7011?.concernees})`);
  // 6221 est entièrement ventilé : il n'a plus rien à traiter, donc rien à
  // suggérer. Une suggestion sans ligne concernée serait du bruit.
  check("un compte entièrement ventilé ne fait plus l'objet de suggestion",
    !sug.some((x) => x.compte === '6221'), `(${sug.map((x) => x.compte).join(',')})`);

  const sugPrincipal = await withUser(u, (c) => assist.suggestionsVentilation(c, d.id, 'PDV', fy));
  check("aucune suggestion sur l'axe principal, qui ne peut pas les appliquer", sugPrincipal.length === 0);

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
