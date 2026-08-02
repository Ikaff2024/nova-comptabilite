import { normaliseProposition } from './provider.js';

// ============================================================================
// CAPTURE — la date de la pièce.
//
// Ce que ce test verrouille, et pourquoi ça compte plus qu'il n'y paraît :
// la date décide de l'EXERCICE. Sans date lue, le formulaire propose celle du
// jour ; pour une comptabilité tenue en retard — un relevé de mars 2025 saisi
// en août 2026 — la pièce part alors dans le mauvais exercice, en silence, et
// ne se découvre qu'en révision des mois plus tard. C'est exactement ce qui a
// produit les dix-neuf « mauvais exercice » du dossier IKAFFANAN.
//
// On ne peut pas empêcher le repli sur la date du jour. On peut refuser qu'il
// passe inaperçu, et lire les dates telles qu'elles s'écrivent ici.
//
//   npm run test:capture   (aucune base de données, aucun appel d'API)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

const ctx = { country: 'CI', currency: 'XOF', accountingSystem: 'normal' } as any;
const base = { description: 'Facture', currency: 'XOF', lines: [{ accountCode: '601', debit: 1000 }] };
const prop = (entryDate: unknown, extra: any = {}) => normaliseProposition({ ...base, entryDate, ...extra }, ctx);
const aDit = (p: any, motif: RegExp) => (p.warnings ?? []).some((w: string) => motif.test(w));

// --- Lecture de la date ------------------------------------------------------
check('AAAA-MM-JJ passe tel quel', prop('2025-03-31').entryDate === '2025-03-31', `(${prop('2025-03-31').entryDate})`);
check('le format français est compris', prop('01/03/2025').entryDate === '2025-03-01', `(${prop('01/03/2025').entryDate})`);
check('avec des points aussi', prop('9.7.2025').entryDate === '2025-07-09', `(${prop('9.7.2025').entryDate})`);
check('un horodatage ISO est ramené au jour', prop('2025-03-31T00:00:00Z').entryDate === '2025-03-31');

// --- Ce qui n'est pas une date ne devient pas une date ----------------------
check('un mois impossible est rejeté', prop('01/13/2025').entryDate === undefined, `(${prop('01/13/2025').entryDate})`);
check('du texte est rejeté', prop('mars 2025').entryDate === undefined);
check('et le rejet est DIT', aDit(prop('mars 2025'), /illisible/i));
check('date absente : signalée, pas passée sous silence',
  prop(undefined).entryDate === undefined && aDit(prop(undefined), /[Aa]ucune date/));
check("l'avertissement explique la conséquence, pas seulement le symptôme",
  aDit(prop(undefined), /exercice/i));

// --- Une date lue mais suspecte ---------------------------------------------
const futur = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
check('une pièce datée dans le futur est signalée', aDit(prop(futur), /futur/i));
check('mais elle est quand même retenue : c\'est au comptable de trancher', prop(futur).entryDate === futur);
check('une date ancienne ne déclenche rien — une compta se tient en retard',
  !aDit(prop('2019-01-15'), /futur|illisible|[Aa]ucune date/), `(${JSON.stringify(prop('2019-01-15').warnings)})`);

// --- Le reste de la proposition n'est pas abîmé -----------------------------
const avecAvertissement = prop('2025-03-31', { warnings: ['Pièce au nom de « X »'] });
check("les avertissements du modèle sont conservés",
  (avecAvertissement.warnings ?? []).some((w) => /au nom de/.test(w)));
check('les lignes traversent intactes', prop('2025-03-31').lines[0].debit === 1000);
check('aucun avertissement inventé quand tout va bien', prop('2025-03-31').warnings === undefined);

console.log(`\n${ok} PASS / ${ko} FAIL`);
if (ko) process.exitCode = 1;
