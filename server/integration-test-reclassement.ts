import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import * as tiers from './domain/tiers.js';
import * as reclass from './domain/reclassement.js';

// ============================================================================
// RECLASSEMENTS préparés en brouillon.
//
// Ce que le test verrouille : un reclassement ne touche jamais l'écriture
// d'origine (le grand livre est immuable), il n'est JAMAIS comptabilisé
// d'office, et un brouillon reste hors balance et hors états tant qu'un humain
// ne l'a pas validé. Enfin, ce qui demande un jugement — un compte d'attente —
// est signalé mais jamais proposé.
//
//   npm run test:reclassement   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jBQ = await withUser(u, (c) => acc.createJournal(c, d.id, 'BQ', 'Banque', 'banque'));
  await withUser(u, (c) => acc.createJournal(c, d.id, 'OD', 'Opérations diverses', 'operations_diverses'));
  const frs = await withUser(u, (c) => tiers.createCounterparty(c, d.id, { type: 'fournisseur', name: 'Beta' }));

  // Acompte versé à un fournisseur sans facture : le 401 devient débiteur.
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy, journalId: jBQ, entryDate: '2026-03-10',
    description: 'Acompte fournisseur Beta', source: 'manual',
    lines: [
      { accountCode: '401', debit: 500000, counterpartyId: frs.id, label: 'Acompte' },
      { accountCode: '521', credit: 500000 },
    ],
  }));
  // Un compte d'attente non soldé.
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy, journalId: jBQ, entryDate: '2026-04-02',
    description: 'Encaissement non identifié', source: 'manual',
    lines: [{ accountCode: '521', debit: 90000 }, { accountCode: '471', credit: 90000 }],
  }));

  const cands = await withUser(u, (c) => reclass.candidatsReclassement(c, d.id, fy));
  const frsDeb = cands.find((x: any) => x.nature === 'fournisseur_debiteur');
  const attente = cands.find((x: any) => x.nature === 'attente_non_solde');
  check('fournisseur débiteur détecté', frsDeb?.montant === 500000 && frsDeb?.compteCible === '409', `(${frsDeb?.montant} → ${frsDeb?.compteCible})`);
  check('fournisseur débiteur : automatisable', frsDeb?.automatisable === true);
  check('compte d\'attente détecté', attente?.montant === 90000, `(${attente?.montant})`);
  check('compte d\'attente : NON automatisable', attente?.automatisable === false);

  // Préparation du reclassement, en brouillon.
  const r = await withUser(u, (c) => reclass.preparerReclassement(c, d.id, {
    compteSource: '401', compteCible: '409', montant: 500000, date: '2026-12-31',
    motif: 'solde débiteur = avance versée', counterpartyId: frs.id,
  }, u));
  check('brouillon de reclassement créé', !!r.entryId);

  const tb = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  const s = (code: string) => tb.find((x: any) => x.account_code === code)?.balance ?? 0;
  check('le brouillon N\'ENTRE PAS en balance : 401 inchangé', s('401') === 500000, `(${s('401')})`);
  check('le brouillon n\'a rien porté en 409', s('409') === 0, `(${s('409')})`);

  const br = await withUser(u, (c) => reclass.listerBrouillons(c, d.id));
  check('brouillon listé avec ses lignes', br.length === 1 && br[0].lignes.length === 2, `(${br.length} brouillon(s))`);

  // Validation par un humain.
  await withUser(u, (c) => reclass.validerBrouillon(c, d.id, r.entryId));
  const tb2 = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  const s2 = (code: string) => tb2.find((x: any) => x.account_code === code)?.balance ?? 0;
  check('après validation : 401 soldé', s2('401') === 0, `(${s2('401')})`);
  check('après validation : 409 porte l\'avance', s2('409') === 500000, `(${s2('409')})`);
  check('l\'écriture d\'origine est intacte (grand livre immuable)',
    (await withUser(u, (c) => acc.generalLedger(c, d.id, { fiscalYearId: fy, accountCode: '401' }))).length === 2);

  const cands2 = await withUser(u, (c) => reclass.candidatsReclassement(c, d.id, fy));
  check('le candidat a disparu après redressement', !cands2.some((x: any) => x.nature === 'fournisseur_debiteur'));

  // Un brouillon se supprime ; une écriture validée, non.
  const r2 = await withUser(u, (c) => reclass.preparerReclassement(c, d.id, {
    compteSource: '471', compteCible: '758', montant: 90000, date: '2026-12-31', motif: 'test suppression',
  }, u));
  await withUser(u, (c) => reclass.supprimerBrouillon(c, d.id, r2.entryId));
  check('brouillon supprimable', (await withUser(u, (c) => reclass.listerBrouillons(c, d.id))).length === 0);

  let refus = false;
  try { await withUser(u, (c) => reclass.supprimerBrouillon(c, d.id, r.entryId)); } catch { refus = true; }
  check('écriture validée non supprimable', refus);

  let refusMotif = false;
  try {
    await withUser(u, (c) => reclass.preparerReclassement(c, d.id, {
      compteSource: '401', compteCible: '409', montant: 1000, date: '2026-12-31', motif: '',
    }, u));
  } catch { refusMotif = true; }
  check('reclassement sans motif refusé', refusMotif);

  // ---------------- Le rattachement d'un brouillon reste au comptable --------
  // L'exercice se déduit de la date, c'est un bon défaut mais pas une règle :
  // une facture du 3 janvier pour une prestation de décembre appartient à
  // l'exercice précédent. Sans la main, le comptable n'a que deux mauvais choix
  // — valider ce qu'il sait faux, ou tout ressaisir.
  const fy2025 = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2025', '2025-01-01', '2025-12-31'));
  const br2 = await withUser(u, (c) => reclass.preparerReclassement(c, d.id, {
    compteSource: '401', compteCible: '409', montant: 12000, date: '2026-01-03',
    motif: 'prestation de décembre facturée en janvier', counterpartyId: frs.id,
  }, u));

  const avant = (await withUser(u, (c) => reclass.listerBrouillons(c, d.id))).find((x: any) => x.id === br2.entryId);
  check('le brouillon naît dans l\'exercice de sa date', avant?.exercice === 'Exercice 2026', `(${avant?.exercice})`);
  check('les bornes de l\'exercice accompagnent le brouillon',
    avant?.exercice_debut === '2026-01-01' && avant?.exercice_fin === '2026-12-31',
    `(${avant?.exercice_debut} → ${avant?.exercice_fin})`);

  const chg = await withUser(u, (c) => reclass.modifierBrouillon(c, d.id, br2.entryId, { fiscalYearId: fy2025 }));
  check('le comptable peut rattacher le brouillon à l\'exercice précédent', chg.exercice === 'Exercice 2025', `(${chg.exercice})`);
  check('et il est prévenu que cet exercice ne couvre pas la date', chg.couvreLaDate === false);
  const apres = (await withUser(u, (c) => reclass.listerBrouillons(c, d.id))).find((x: any) => x.id === br2.entryId);
  check('le changement est bien enregistré', apres?.exercice === 'Exercice 2025', `(${apres?.exercice})`);

  const retour = await withUser(u, (c) => reclass.modifierBrouillon(c, d.id, br2.entryId, { fiscalYearId: fy }));
  check('revenir à l\'exercice qui couvre la date ne lève aucune réserve', retour.couvreLaDate === true);

  // --- La DATE de comptabilisation, pour une compta tenue en retard ---------
  // Les imports datent souvent la pièce du JOUR DE L'IMPORT : c'est la cause
  // première des écritures « mal rattachées ». Corriger la date à la source vaut
  // mieux que déplacer l'écriture d'exercice en exercice.
  const dm = await withUser(u, (c) => reclass.modifierBrouillon(c, d.id, br2.entryId, { entryDate: '2025-03-31' }));
  check('la date de comptabilisation se corrige', dm.date === '2025-03-31', `(${dm.date})`);
  check('et l\'exercice suit tout seul, sans second geste',
    dm.exerciceAjuste === true && dm.exercice === 'Exercice 2025', `(${dm.exercice}, ajusté=${dm.exerciceAjuste})`);
  check('le rattachement redevient cohérent', dm.couvreLaDate === true);
  const apresDate = (await withUser(u, (c) => reclass.listerBrouillons(c, d.id))).find((x: any) => x.id === br2.entryId);
  check('la nouvelle date est bien en base', apresDate?.date === '2025-03-31', `(${apresDate?.date})`);

  let refusDate = false;
  try { await withUser(u, (c) => reclass.modifierBrouillon(c, d.id, br2.entryId, { entryDate: 'hier' })); } catch { refusDate = true; }
  check('une date illisible est refusée, jamais ignorée', refusDate);
  const inchange = (await withUser(u, (c) => reclass.listerBrouillons(c, d.id))).find((x: any) => x.id === br2.entryId);
  check('et le brouillon n\'a pas bougé', inchange?.date === '2025-03-31', `(${inchange?.date})`);

  // Un exercice clôturé reste fermé : on n'y injecte rien, même en brouillon.
  await withUser(u, (c) => reclass.modifierBrouillon(c, d.id, br2.entryId, { entryDate: '2026-01-03', fiscalYearId: fy }));
  await withUser(u, (c) => c.query("update fiscal_years set status='closed' where dossier_id=$1 and id=$2", [d.id, fy2025]));
  let refusClos = false;
  try { await withUser(u, (c) => reclass.modifierBrouillon(c, d.id, br2.entryId, { fiscalYearId: fy2025 })); } catch { refusClos = true; }
  check('un exercice clôturé refuse le rattachement', refusClos);

  // Et la date ne sert pas de porte dérobée vers un exercice clôturé.
  const versClos = await withUser(u, (c) => reclass.modifierBrouillon(c, d.id, br2.entryId, { entryDate: '2025-06-15' }));
  check('une date tombant dans un exercice clôturé n\'y fait pas basculer l\'écriture',
    versClos.exercice === 'Exercice 2026' && versClos.couvreLaDate === false, `(${versClos.exercice})`);

  // Une écriture validée ne se déplace pas : elle se contre-passe.
  let refusPosted = false;
  try { await withUser(u, (c) => reclass.modifierBrouillon(c, d.id, r.entryId, { fiscalYearId: fy })); } catch { refusPosted = true; }
  check('une écriture comptabilisée ne se modifie pas', refusPosted);

  // ==========================================================================
  // REDRESSEMENT EN MASSE
  //
  // « Mal rattachée » ne dit pas laquelle des deux données est fausse. Une pièce
  // capturée porte souvent la date de sa SAISIE : c'est alors la date qu'il faut
  // corriger, pas l'exercice qu'il faut changer. Déplacer l'écriture serait
  // doublement faux — elle partirait dans un exercice où elle n'a rien à faire,
  // en changeant le résultat de deux années.
  // ==========================================================================
  const u2 = randomUUID();
  const cab2 = await withUser(u2, (c) => acc.onboardCabinet(c, u2, 'Cab2', 'CI'));
  const d2 = await withUser(u2, (c) => acc.openDossier(c, { cabinetId: cab2, raisonSociale: 'PME retard', country: 'CI' }));
  const f25 = await withUser(u2, (c) => acc.createFiscalYear(c, d2.id, 'Exercice 2025', '2025-01-01', '2025-12-31'));
  const f26 = await withUser(u2, (c) => acc.createFiscalYear(c, d2.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jb = await withUser(u2, (c) => acc.createJournal(c, d2.id, 'BQ', 'Banque', 'banque'));
  await withUser(u2, (c) => acc.createJournal(c, d2.id, 'OD', 'Opérations diverses', 'operations_diverses'));

  // Fabrication de l'état à redresser. postEntry refuse aujourd'hui une date
  // hors des bornes de son exercice — c'est bien, mais ce garde-fou est récent :
  // les dossiers réels portent des écritures entrées quand il ne fonctionnait
  // pas. On reproduit donc l'état par le seul chemin resté ouvert : un
  // BROUILLON se modifie, puis se valide. L'écriture posée est identique à
  // celle qu'on trouve en production.
  const poserHorsBornes = async (
    fyPose: string, date: string, dateFinale: string, description: string,
    source: any, lines: any[], fyFinal?: string, saisieLe?: string,
  ) => {
    const e = await withUser(u2, (c) => acc.postEntry(c, {
      dossierId: d2.id, fiscalYearId: fyPose, journalId: jb, entryDate: date,
      description, source, status: 'draft', lines,
    }));
    await withUser(u2, (c) => c.query(
      `update entries set entry_date=$3, fiscal_year_id=$4, created_at=$5::timestamptz
        where dossier_id=$1 and id=$2`,
      [d2.id, e.id, dateFinale, fyFinal ?? fyPose, saisieLe ?? `${dateFinale} 10:00`]));
    await withUser(u2, (c) => c.query("update entries set status='posted' where dossier_id=$1 and id=$2", [d2.id, e.id]));
    return e;
  };

  // (a) Le cas IKAFFANAN : relevé de mars 2025, rattaché à 2025 (bon), mais daté
  //     du jour de l'import (faux). L'exercice est juste, la date ne l'est pas.
  const releve = await poserHorsBornes(f25, '2025-03-31', '2026-07-22', 'Relevé de compte mars 2025', 'ocr',
    [{ accountCode: '6318', debit: 40000 }, { accountCode: '5211', credit: 40000 }]);

  // (b) Une vraie erreur d'exercice : opération de 2026 saisie à la main dans 2025.
  const vente = await poserHorsBornes(f26, '2026-02-10', '2026-02-10', 'Vente février 2026', 'manual',
    [{ accountCode: '5211', debit: 900000 }, { accountCode: '701', credit: 900000 }], f25, '2026-03-05 09:00');

  // --- Lecture d'une date dans le libellé (fonction pure) -------------------
  // Le libellé porte souvent la date que la pièce n'a pas su donner. La lire
  // évite dix-neuf ressaisies ; encore faut-il qu'elle lise juste.
  const lu = (s: string) => reclass.dateDuLibelle(s)?.date ?? null;
  check('une période : c\'est la date de FIN qui date l\'opération',
    lu('Relevé de compte BDA pour la période du 01/03/2025 au 31/03/2025') === '2025-03-31',
    `(${lu('Relevé de compte BDA pour la période du 01/03/2025 au 31/03/2025')})`);
  check('un mois sans jour donne la fin du mois',
    lu('Relevé de compte mars 2025') === '2025-03-31', `(${lu('Relevé de compte mars 2025')})`);
  check('les accents ne gênent pas', lu('Honoraires février 2025') === '2025-02-28', `(${lu('Honoraires février 2025')})`);
  check('une année bissextile est comptée juste', lu('Loyer fevrier 2024') === '2024-02-29', `(${lu('Loyer fevrier 2024')})`);
  check('le mois abrégé est compris', lu('Commission sept. 2025') === '2025-09-30', `(${lu('Commission sept. 2025')})`);
  check('MM/AAAA donne aussi la fin du mois', lu('Abonnement 04/2025') === '2025-04-30', `(${lu('Abonnement 04/2025')})`);
  check('le format ISO est lu tel quel', lu('Facture du 2025-06-15') === '2025-06-15');
  check('un jour ne se fait pas relire comme un mois',
    lu('Facture du 01/03/2025 réglée le 15/04/2025') === '2025-04-15',
    `(${lu('Facture du 01/03/2025 réglée le 15/04/2025')})`);
  check('un numéro de pièce ne devient pas une date', lu('Facture FV-2026-0004 Client Awa') === null,
    `(${lu('Facture FV-2026-0004 Client Awa')})`);
  check('une date impossible est ignorée', lu('Opération du 32/13/2025') === null, `(${lu('Opération du 32/13/2025')})`);
  check('un libellé sans date ne propose rien', lu('Achat de fournitures de bureau') === null);
  check('une année invraisemblable est écartée', lu('Réf 12/1856 archive') === null, `(${lu('Réf 12/1856 archive')})`);

  const mal = await withUser(u2, (c) => reclass.ecrituresMalRattachees(c, d2.id));
  check('les deux écritures mal rattachées sont vues', mal.length === 2, `(${mal.length})`);

  const mRel = mal.find((x: any) => x.description.startsWith('Relevé'));
  const mVen = mal.find((x: any) => x.description.startsWith('Vente'));
  check('une pièce datée du jour de sa saisie : c\'est la DATE qui est suspecte',
    mRel?.indice === 'date_suspecte', `(${mRel?.indice})`);
  check('et la raison le dit au lieu de proposer un déplacement',
    /DATE qui est probablement fausse/.test(mRel?.raison ?? ''), `(${mRel?.raison?.slice(0, 60)}…)`);
  check('une saisie manuelle hors bornes : c\'est l\'exercice qui est suspect',
    mVen?.indice === 'exercice_suspect', `(${mVen?.indice})`);
  check('la contribution au résultat est chiffrée', mVen?.resultat === 900000, `(${mVen?.resultat})`);
  check('une charge compte en négatif dans le résultat', mRel?.resultat === -40000, `(${mRel?.resultat})`);

  // --- L'aperçu, avant de s'engager ---
  const impact = await withUser(u2, (c) => reclass.impactRedressement(c, d2.id, [
    { entryId: mRel!.id, mode: 'date', nouvelleDate: '2025-03-31' },
    { entryId: mVen!.id, mode: 'exercice' },
  ]));
  check('corriger une date ne touche AUCUN résultat', impact.sansEffetSurLeResultat === 1, `(${impact.sansEffetSurLeResultat})`);
  const d25 = impact.parExercice.find((x: any) => x.label === 'Exercice 2025');
  const d26 = impact.parExercice.find((x: any) => x.label === 'Exercice 2026');
  check('2025 perd la vente mal rattachée', d25?.delta === -900000, `(${d25?.delta})`);
  check('2026 la reçoit', d26?.delta === 900000, `(${d26?.delta})`);
  check('les deux exercices bougent du même montant, en sens inverse',
    (d25?.delta ?? 0) + (d26?.delta ?? 0) === 0);
  check('rien n\'a encore été touché : les écritures sont toujours là',
    (await withUser(u2, (c) => reclass.ecrituresMalRattachees(c, d2.id))).length === 2);

  // --- Les refus, chacun avec son motif ---
  let refusHorsBornes = false; let motif = '';
  try {
    await withUser(u2, (c) => reclass.impactRedressement(c, d2.id, [{ entryId: mRel!.id, mode: 'date', nouvelleDate: '2024-05-05' }]));
  } catch (e: any) { refusHorsBornes = true; motif = e.message; }
  check('une « correction de date » qui sort de l\'exercice est refusée', refusHorsBornes);
  check('et elle renvoie vers le bon traitement', /réaffectation d'exercice/.test(motif), `(${motif.slice(0, 70)}…)`);

  await withUser(u2, (c) => c.query("update fiscal_years set status='closed' where dossier_id=$1 and id=$2", [d2.id, f26]));
  let refusClot = false;
  try { await withUser(u2, (c) => reclass.impactRedressement(c, d2.id, [{ entryId: mVen!.id, mode: 'exercice' }])); } catch { refusClot = true; }
  check('on ne déplace pas une écriture vers un exercice clôturé', refusClot);
  await withUser(u2, (c) => c.query("update fiscal_years set status='open' where dossier_id=$1 and id=$2", [d2.id, f26]));

  // --- Exécution du lot ---
  const lot = await withUser(u2, (c) => reclass.redresserEnMasse(c, d2.id, [
    { entryId: mRel!.id, mode: 'date', nouvelleDate: '2025-03-31' },
    { entryId: mVen!.id, mode: 'exercice' },
  ], u2));
  check('les deux écritures sont traitées', lot.traitees === 2, `(${lot.traitees})`);
  check('chacune produit une extourne et un brouillon',
    lot.extournes.length === 2 && lot.brouillons.length === 2);

  const malApres = await withUser(u2, (c) => reclass.ecrituresMalRattachees(c, d2.id));
  check('plus aucune écriture mal rattachée', malApres.length === 0,
    `(${malApres.map((x: any) => `${x.description} @${x.date}/${x.exercice.label}`).join(' | ')})`);

  // Le redressement ne doit pas fabriquer l'anomalie qu'il traite : une extourne
  // datée du jour tout en étant rattachée à un exercice antérieur ressortirait
  // indéfiniment en révision, et le lot ne se terminerait jamais.
  const extournes = await withUser(u2, (c) => c.query(
    `select to_char(e.entry_date,'YYYY-MM-DD') as d, f.label,
            to_char(f.start_date,'YYYY-MM-DD') as d1, to_char(f.end_date,'YYYY-MM-DD') as d2
       from entries e join fiscal_years f on f.id = e.fiscal_year_id
      where e.dossier_id=$1 and e.reverses_entry_id is not null`, [d2.id]));
  check('chaque extourne est datée DANS l\'exercice qu\'elle neutralise',
    extournes.rows.every((r: any) => r.d >= r.d1 && r.d <= r.d2),
    `(${extournes.rows.map((r: any) => `${r.d} dans ${r.label}`).join(' | ')})`);

  const brs = await withUser(u2, (c) => reclass.listerBrouillons(c, d2.id));
  const brRel = brs.find((x: any) => x.description.startsWith('Relevé'));
  const brVen = brs.find((x: any) => x.description.startsWith('Vente'));
  check('la réécriture du relevé porte la date corrigée', brRel?.date === '2025-03-31', `(${brRel?.date})`);
  check('et reste dans son exercice d\'origine', brRel?.exercice === 'Exercice 2025', `(${brRel?.exercice})`);
  check('son libellé dit ce qui a changé', /date corrigée/.test(brRel?.description ?? ''), `(${brRel?.description})`);
  check('la vente part dans l\'exercice de sa date', brVen?.exercice === 'Exercice 2026', `(${brVen?.exercice})`);
  check('à date inchangée', brVen?.date === '2026-02-10', `(${brVen?.date})`);

  // L'extourne est comptabilisée tout de suite : entre les deux, l'écriture
  // n'est plus nulle part. C'est voulu, et le test le fige pour qu'on ne le
  // découvre pas en production.
  const tb25 = await withUser(u2, (c) => acc.trialBalance(c, d2.id, f25));
  const solde701 = Number(tb25.find((r: any) => r.account_code === '701')?.balance ?? 0);
  check('la contre-passation a déjà vidé 2025 de la vente (le brouillon, lui, attend)',
    solde701 === 0, `(${solde701})`);

  let refusVide = false;
  try { await withUser(u2, (c) => reclass.redresserEnMasse(c, d2.id, [], u2)); } catch { refusVide = true; }
  check('un lot vide est refusé', refusVide);

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
