// =============================================================================
// Nova Comptabilité — exécute TOUTES les suites de tests.
// =============================================================================
// Constat NOVA-P1-06 de la revue CTO 001 : le dépôt déclarait dix-huit suites,
// la CI en exécutait UNE. Environ 429 contrôles — dont l'intégralité de la paie,
// des états financiers, des notes annexes, et la suite de sécurité — ne
// tournaient jamais automatiquement. Un merge vert ne garantissait presque rien.
//
// La correction évidente aurait été d'ajouter dix-sept lignes à ci.yml. Ce
// n'aurait pas traité la cause : les suites avaient été écrites une à une, et
// personne n'avait pensé à les brancher. Le même oubli se reproduirait à la
// prochaine.
//
// Ce lanceur DÉCOUVRE donc les suites dans package.json au lieu d'en tenir une
// liste. Ajouter un script `test:*` suffit à le faire tourner en CI — il n'y a
// plus rien à penser, donc plus rien à oublier.
//
//   npm run test:all
//
// Les suites s'exécutent en SÉRIE : elles partagent une base et créent leurs
// propres jeux d'essai. Les paralléliser demanderait une base par suite ; à
// ~100 secondes pour l'ensemble, le gain ne vaut pas le risque d'interférence.
// =============================================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// `test:all` s'exclut lui-même, sans quoi il s'appellerait indéfiniment.
const suites = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith('test:') && k !== 'test:all')
  .sort();

if (suites.length === 0) {
  console.error('[tests] aucune suite test:* déclarée dans package.json.');
  process.exit(1);
}

console.log(`[tests] ${suites.length} suite(s) découverte(s) dans package.json.\n`);

const echecs = [];
const debutTotal = Date.now();

for (const suite of suites) {
  const nom = suite.replace(/^test:/, '');
  process.stdout.write(`── ${nom.padEnd(24)} `);
  const debut = Date.now();
  // `shell: true` est nécessaire pour résoudre npm sous Windows. Node émet alors
  // un avertissement de dépréciation par appel, qui noyait le compte rendu :
  // le script est donc lancé avec --no-deprecation (cf. package.json).
  const r = spawnSync('npm', ['run', '--silent', suite], {
    encoding: 'utf8', shell: true, env: process.env,
  });
  const secondes = ((Date.now() - debut) / 1000).toFixed(1);
  const sortie = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  if (r.status === 0) {
    // Dernière ligne de compte-rendu, quand la suite en produit une.
    const bilan = sortie.split('\n').reverse()
      .find((l) => /\d+\s+PASS|checks PASS|SUCCÈS|✅/.test(l))?.trim() ?? '';
    console.log(`OK   ${secondes.padStart(5)}s  ${bilan.slice(0, 44)}`);
  } else {
    console.log(`ÉCHEC ${secondes.padStart(4)}s`);
    echecs.push({ nom, sortie });
  }
}

const total = ((Date.now() - debutTotal) / 1000).toFixed(0);

if (echecs.length > 0) {
  // La sortie complète des suites en échec, et d'elles seules : noyer un échec
  // dans le journal des vingt-deux autres revient à le cacher.
  for (const e of echecs) {
    console.error(`\n${'='.repeat(70)}\nÉCHEC — ${e.nom}\n${'='.repeat(70)}`);
    console.error(e.sortie.trimEnd().split('\n').slice(-40).join('\n'));
  }
  console.error(`\n[tests] ${echecs.length}/${suites.length} suite(s) en échec (${total}s) : `
    + echecs.map((e) => e.nom).join(', '));
  process.exit(1);
}

console.log(`\n[tests] ${suites.length}/${suites.length} suites au vert (${total}s).`);
