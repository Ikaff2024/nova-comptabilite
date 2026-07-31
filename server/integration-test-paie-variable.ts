import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import * as payroll from './domain/payroll.js';
import * as pvar from './domain/payrollvariable.js';
import * as tiers from './domain/tiers.js';
import * as invoicing from './domain/invoicing.js';

// ============================================================================
// PAIE VARIABLE — import du pointage, rémunération à la tâche, commission sur
// le chiffre d'affaires.
//
// Ce que le test verrouille :
//   • réimporter un mois corrigé REMPLACE les heures, il ne les double pas ;
//   • une ligne rejetée n'empêche pas les autres d'entrer, et son motif est dit ;
//   • une commission se calcule NET DES AVOIRS, et un devis n'est pas du CA ;
//   • la rémunération variable s'AJOUTE à une prime saisie à la main au lieu de
//     l'écraser — sinon elle disparaîtrait du bulletin sans bruit ;
//   • et elle entre bien dans le brut, donc dans les cotisations.
//
//   npm run test:paie-variable   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME Commerciale', country: 'CI' }));
  await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  await withUser(u, (c) => acc.createJournal(c, d.id, 'VE', 'Ventes', 'ventes'));

  const emp = await withUser(u, (c) => payroll.createEmployee(c, d.id, {
    matricule: 'V001', nom: 'KOUAME', prenoms: 'Ama', dateEmbauche: '2024-01-15',
    poste: 'Commerciale', categorie: 'Employé', statutMatrimonial: 'Célibataire',
    salaireBase: 200000, dateNaissance: '1995-05-05',
  }));
  const emp2 = await withUser(u, (c) => payroll.createEmployee(c, d.id, {
    matricule: 'T002', nom: 'DIALLO', prenoms: 'Sekou', dateEmbauche: '2025-03-01',
    poste: 'Ouvrier', categorie: 'Ouvrier', statutMatrimonial: 'Marié',
    salaireBase: 100000, dateNaissance: '1990-02-02',
  }));

  // ---------------- Import du pointage ----------------
  const csv = [
    'Matricule;Date;Heures jour;Heures nuit;Férié',
    'V001;2026-06-01;8;0;non',
    'V001;01/06/2026;8;0;non',
    'V001;2026-06-02;8;2;non',
    'T002;2026-06-01;10;0;oui',
    'X999;2026-06-01;8;0;non',
    'T002;2026-06-03;30;0;non',
    'T002;2026-06-04;0;0;non',
  ].join('\n');

  const a = await withUser(u, (c) => pvar.analyserPointage(c, d.id, csv));
  check('analyse : 3 lignes valides (la ligne en double est écartée)', a.valides === 3, `(${a.valides})`);
  check('analyse : 4 rejets, chacun motivé', a.rejetees === 4,
    `(${a.lignes.filter((l) => l.erreur).map((l) => l.erreur).join(' | ')})`);
  check('analyse : date JJ/MM/AAAA reconnue', a.lignes[1].jour === '2026-06-01', `(${a.lignes[1].jour})`);
  check('analyse : total des heures retenues', a.totalHeures === 28, `(${a.totalHeures})`);

  const imp = await withUser(u, (c) => pvar.importerPointage(c, d.id, csv, u));
  check('import : 3 lignes entrées', imp.importees === 3, `(${imp.importees})`);
  const t1 = await withUser(u, (c) => payroll.listTimeEntries(c, d.id));
  check('import : 3 pointages en base', t1.length === 3, `(${t1.length})`);

  const csv2 = 'Matricule;Date;Heures jour;Heures nuit;Férié\nV001;2026-06-01;6;0;non';
  const imp2 = await withUser(u, (c) => pvar.importerPointage(c, d.id, csv2, u));
  check('réimport : signalé comme remplacement', imp2.remplacees === 1, `(${imp2.remplacees})`);
  const t2 = await withUser(u, (c) => payroll.listTimeEntries(c, d.id));
  check('réimport : toujours 3 pointages, pas 4', t2.length === 3, `(${t2.length})`);
  const j1 = t2.find((x: any) => x.matricule === 'V001' && x.jour === '2026-06-01');
  check('réimport : heures corrigées à 6', j1?.heuresJour === 6, `(${j1?.heuresJour})`);

  // ---------------- Rémunération à la tâche ----------------
  const tache = await withUser(u, (c) => pvar.ajouterElement(c, d.id, {
    employeeId: emp2.id, annee: 2026, mois: 5, type: 'tache',
    libelle: 'Sacs cousus', quantite: 240, prixUnitaire: 350,
  }, u));
  check('tâche : 240 × 350 = 84 000', tache.montant === 84000, `(${tache.montant})`);

  let refus = false;
  try {
    await withUser(u, (c) => pvar.ajouterElement(c, d.id, {
      employeeId: emp2.id, annee: 2026, mois: 5, type: 'tache', libelle: 'X', quantite: 0, prixUnitaire: 350,
    }, u));
  } catch { refus = true; }
  check('tâche : quantité nulle refusée', refus);

  // ---------------- Commission sur le chiffre d'affaires ----------------
  const client = await withUser(u, (c) => tiers.createCounterparty(c, d.id, { type: 'client', name: 'Client Sud' }));
  const mk = async (type: string, montant: number, statut: string) => {
    await withUser(u, (c) => c.query(
      `insert into invoices(dossier_id, counterparty_id, client_name, number, invoice_date, status, total_ht, total_ttc, doc_type, vendeur_id)
       values ($1,$2,'Client Sud',$3,'2026-06-15',$4::invoice_status,$5,$5,$6,$7)`,
      [d.id, client.id, `F-${Math.random().toString(36).slice(2, 7)}`, statut, montant, type, emp.id]));
  };
  await mk('invoice', 5000000, 'issued');
  await mk('invoice', 3000000, 'paid');
  await mk('credit_note', 1000000, 'issued');
  await mk('quote', 9000000, 'issued');
  await mk('invoice', 4000000, 'draft');

  const ca = await withUser(u, (c) => pvar.caDuVendeur(c, d.id, emp.id, '2026-06-01', '2026-06-30', 'facture'));
  check('CA facturé net des avoirs = 7 000 000', ca.total === 7000000, `(${ca.total})`);
  check('le devis est exclu du CA', !ca.factures.some((f) => Math.abs(f.montant) === 9000000));
  check('la liste justificative accompagne le montant', ca.factures.length === 3, `(${ca.factures.length} pièces)`);

  const caEnc = await withUser(u, (c) => pvar.caDuVendeur(c, d.id, emp.id, '2026-06-01', '2026-06-30', 'encaisse'));
  check('CA encaissé = 3 000 000 seulement', caEnc.total === 3000000, `(${caEnc.total})`);

  const com = await withUser(u, (c) => pvar.ajouterElement(c, d.id, {
    employeeId: emp.id, annee: 2026, mois: 5, type: 'commission',
    libelle: 'Commission juin', taux: 3, baseCa: 'facture',
    periodeDebut: '2026-06-01', periodeFin: '2026-06-30',
  }, u));
  check('commission : 3 % de 7 000 000 = 210 000', com.montant === 210000, `(${com.montant})`);
  check('commission : assiette mémorisée', com.assiette === 7000000, `(${com.assiette})`);

  let refusTaux = false;
  try {
    await withUser(u, (c) => pvar.ajouterElement(c, d.id, {
      employeeId: emp.id, annee: 2026, mois: 5, type: 'commission', libelle: 'X', taux: 150,
      periodeDebut: '2026-06-01', periodeFin: '2026-06-30',
    }, u));
  } catch { refusTaux = true; }
  check('commission : taux supérieur à 100 % refusé', refusTaux);

  // ---------------- Entrée dans la paie ----------------
  const el = await withUser(u, (c) => pvar.listerElements(c, d.id, 2026, 5));
  check('éléments listés avec leur justification',
    el.length === 2 && el.some((x: any) => x.justification === '240 × 350'),
    `(${el.map((x: any) => x.justification).join(' | ')})`);

  await withUser(u, (c) => payroll.runPayroll(c, d.id, 2026, 5, { [emp.id]: { primesExceptionnelles: 50000 } as any }));
  const slips = await withUser(u, (c) => payroll.listPayslips(c, d.id, 2026, 5));
  const sAma: any = slips.find((s: any) => s.matricule === 'V001');
  const sSekou: any = slips.find((s: any) => s.matricule === 'T002');
  check('commission ajoutée à la prime manuelle (50 000 + 210 000)',
    sAma?.variables?.primesExceptionnelles === 260000, `(${sAma?.variables?.primesExceptionnelles})`);
  check("tâche portée au brut de l'ouvrier",
    sSekou?.variables?.primesExceptionnelles === 84000, `(${sSekou?.variables?.primesExceptionnelles})`);
  check('le détail justificatif accompagne le bulletin',
    Array.isArray(sAma?.variables?.detailVariable) && sAma.variables.detailVariable[0].justification === '3 % de 7000000',
    `(${JSON.stringify(sAma?.variables?.detailVariable)})`);
  check('le brut inclut la rémunération variable',
    Number(sAma?.calculation?.salaireBrutTotal) >= 260000, `(${sAma?.calculation?.salaireBrutTotal})`);

  // ---------------- Le vendeur suit la pièce ----------------
  // Une facture émise puis annulée par un avoir ne doit plus commissionner. Cela
  // n'est vrai que si l'avoir hérite du vendeur de la facture d'origine.
  const fv = await withUser(u, (c) => invoicing.createInvoice(c, d.id, {
    clientName: 'Client Sud', counterpartyId: client.id, invoiceDate: '2026-07-10',
    vendeurId: emp.id, lines: [{ description: 'Lot', quantity: 1, unitPrice: 2000000, vatRate: 0 }],
  }));
  await withUser(u, (c) => invoicing.issueInvoice(c, d.id, fv.id));
  const av = await withUser(u, (c) => invoicing.creditNoteFromInvoice(c, d.id, fv.id));
  // L'avoir naît daté du jour ; on le cale sur juillet pour que le test ne
  // dépende pas de la date à laquelle on le joue.
  await withUser(u, (c) => c.query("update invoices set invoice_date='2026-07-20' where dossier_id=$1 and id=$2", [d.id, av.id]));
  await withUser(u, (c) => invoicing.issueInvoice(c, d.id, av.id));
  const avoir = await withUser(u, (c) => invoicing.getInvoice(c, d.id, av.id));
  check("l'avoir hérite du vendeur de la facture", avoir.vendeur_id === emp.id, `(${avoir.vendeur_id})`);

  const caJuillet = await withUser(u, (c) => pvar.caDuVendeur(c, d.id, emp.id, '2026-07-01', '2026-07-31', 'facture'));
  check('facture annulée par son avoir : CA nul, pas de commission', caJuillet.total === 0, `(${caJuillet.total})`);

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
