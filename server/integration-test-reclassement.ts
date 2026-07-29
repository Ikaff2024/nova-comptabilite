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

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
