import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contrôle de la saisie du tableau de correspondance (server/domain/etats-postes.ts) :
// chaque compte cité doit exister au plan SYSCOHADA, et chaque expression doit
// se parser. Pas de base de données : lecture du plan de référence.
//   node server/domain/etats-postes.test.mjs

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(path.join(ROOT, 'server/domain/etats-postes.ts'), 'utf8');

// Plan officiel : codes à 3 chiffres et plus.
const plan = new Set();
for (const l of fs.readFileSync(path.join(ROOT, 'plan_comptable_OHADA_valide.txt'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^(\d{3,})\s+\S/);
  if (m) plan.add(m[1]);
}
const connu = (code) => plan.has(code) || [...plan].some((p) => p.startsWith(code));

// Relit les expressions du fichier source (brut: [...] / amort: [...]).
const expressions = [];
for (const m of src.matchAll(/(?:brut|amort):\s*\[([^\]]*)\]/g)) {
  for (const q of m[1].matchAll(/'([^']+)'/g)) expressions.push(q[1]);
}

let ko = 0;
const vus = new Set();
for (const raw of expressions) {
  const partiel = /\s*p\.?$/i.test(raw.trim());
  const sansP = raw.trim().replace(/\s*p\.?$/i, '');
  const m = sansP.match(/^(\d+)\s*(?:\(\s*sauf\s+(.+?)\s*\))?$/i);
  if (!m) { console.error(`  FAIL expression illisible : « ${raw} »`); ko++; continue; }
  // « p » (pour partie) peut porter sur une exclusion : « 294 sauf 2945, 2949p ».
  const codes = [m[1], ...((m[2] ?? '').split(/\s*(?:,|et)\s*/)
    .map((s) => s.trim().replace(/\s*p\.?$/i, '')).filter(Boolean))];
  for (const c of codes) {
    vus.add(c);
    if (!connu(c)) { console.error(`  FAIL compte inconnu au plan : ${c} (dans « ${raw} »)`); ko++; }
  }
  if (partiel && !raw.includes('p')) { console.error(`  FAIL marqueur partiel perdu : ${raw}`); ko++; }
}

// Les références de postes doivent être uniques par état.
const refs = [...src.matchAll(/ref:\s*'([A-Z]{2})'/g)].map((m) => m[1]);
const actif = refs.slice(0, refs.findIndex((r) => r === 'CA'));
const dup = actif.filter((r, i) => actif.indexOf(r) !== i);
if (dup.length) { console.error(`  FAIL références en double au bilan actif : ${dup.join(', ')}`); ko++; }

console.log(`${expressions.length} expressions, ${vus.size} comptes distincts, ${actif.length} postes au bilan actif`);
console.log(ko === 0 ? 'Tableau de correspondance conforme au plan SYSCOHADA ✅' : `${ko} anomalie(s)`);
process.exitCode = ko === 0 ? 0 : 1;
