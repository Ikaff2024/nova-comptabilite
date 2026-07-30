import { comparer, doitEnvoyer, digestHtml, type Insight } from './domain/nightly.js';

// ============================================================================
// VEILLE DE LEXA — diff, règle du silence, rendu.
//
// Ce que ce test verrouille, et qui décide de la survie du mail quotidien :
//   • un point déjà signalé hier ne se présente pas comme neuf ;
//   • un mail n'est PAS envoyé quand rien n'a bougé — un message identique
//     chaque matin apprend au destinataire à ne plus ouvrir les suivants ;
//   • un lundi fait exception, pour que le silence ne se confonde pas avec
//     une panne ;
//   • les montants sont précédés d'une réserve quand la comptabilité qui les
//     porte présente des anomalies connues.
//
// Aucune base de données : ce sont des fonctions pures.
//   npm run test:veille
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

const A = (p: Partial<Insight>): Insight => ({ niveau: 'haute', categorie: 'previsionnel', titre: 'Trésorerie projetée négative', ...p } as Insight);

// --- diff ---
const hier: Insight[] = [A({ montant: -3000000 }), A({ categorie: 'rh', titre: '3 demande(s) de congés à valider', niveau: 'moyenne' })];
const ajd: Insight[] = [A({ montant: -4979836 }), A({ categorie: 'rh', titre: '5 demande(s) de congés à valider', niveau: 'moyenne' }), A({ categorie: 'fiscal', titre: 'IMF dû malgré la perte', niveau: 'moyenne', montant: 3000000 })];
const { items, resolus } = comparer(ajd, hier);
check('trésorerie qui se creuse → aggravé', items[0].etat === 'aggrave', `(${items[0].etat}, variation ${items[0].variation})`);
check('variation chiffrée', items[0].variation === -1979836, `(${items[0].variation})`);
check('même point au compteur différent → pas « nouveau »', items[1].etat === 'stable' || items[1].etat === 'aggrave', `(${items[1].etat})`);
check('point absent hier → nouveau', items[2].etat === 'nouveau', `(${items[2].etat})`);
check('aucun résolu ici', resolus.length === 0);

const { items: i2, resolus: r2 } = comparer([A({ montant: -1000000 })], hier);
check('trésorerie qui remonte → en amélioration', i2[0].etat === 'ameliore', `(${i2[0].etat})`);
check('point disparu → résolu', r2.length === 1 && r2[0].etat === 'resolu', `(${r2.length})`);

// --- règle du silence ---
const lundi = new Date('2026-07-27'), mardi = new Date('2026-07-28');
check('rien à signaler → pas d\'envoi', doitEnvoyer([], [], mardi).envoyer === false);
check('situation inchangée un mardi → pas d\'envoi',
  doitEnvoyer([A({ montant: -1, etat: 'stable' })], [], mardi).envoyer === false,
  `(${doitEnvoyer([A({ montant: -1, etat: 'stable' })], [], mardi).motif})`);
check('situation inchangée un lundi → récap hebdo',
  doitEnvoyer([A({ montant: -1, etat: 'stable' })], [], lundi).envoyer === true,
  `(${doitEnvoyer([A({ montant: -1, etat: 'stable' })], [], lundi).motif})`);
check('un point aggravé → envoi', doitEnvoyer([A({ montant: -1, etat: 'aggrave' })], [], mardi).envoyer === true);
check('un point résolu → envoi', doitEnvoyer([], [A({ etat: 'resolu' })], mardi).envoyer === true);

// --- rendu ---
const html = digestHtml('IKAFFANAN LTD', { haute: 2, moyenne: 3 }, items, 'XOF', {
  resolus: r2, fiabilite: { fiable: false, motifs: ['15 écriture(s) rattachée(s) à « Exercice 2025 » sont datées hors de ses bornes'] },
});
check('bandeau de fiabilité présent', html.includes('Chiffres à prendre avec réserve'));
check('badge NOUVEAU rendu', html.includes('NOUVEAU'));
check('badge AGGRAVÉ rendu', html.includes('AGGRAVÉ'));
check('bloc des points résolus', html.includes('Réglé depuis hier'));
check('date d\'analyse en pied', /Analyse produite le/.test(html));

const propre = digestHtml('X', { haute: 1, moyenne: 0 }, [A({ montant: -1, etat: 'stable' })], 'XOF', { fiabilite: { fiable: true, motifs: [] } });
check('pas de bandeau si la compta est saine', !propre.includes('Chiffres à prendre avec réserve'));
check('chapeau dit que rien n\'a bougé', propre.includes('Rien de nouveau depuis hier'));

console.log(`\n${ok} PASS / ${ko} FAIL`);
process.exitCode = ko === 0 ? 0 : 1;
