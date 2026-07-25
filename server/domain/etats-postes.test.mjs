import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contrôle de la saisie des tableaux de correspondance (etats-postes.ts) :
//  1. toute expression se parse ;
//  2. tout compte cité existe au plan SYSCOHADA ;
//  3. les formules des soldes ne renvoient qu'à des postes existants ;
//  4. deux postes d'un même état ne se disputent pas un compte.
//   npm run test:postes   (aucune base de données requise)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(path.join(ROOT, 'server/domain/etats-postes.ts'), 'utf8');

const plan = new Set();
for (const l of fs.readFileSync(path.join(ROOT, 'plan_comptable_OHADA_valide.txt'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^(\d{3,})\s+\S/);
  if (m) plan.add(m[1]);
}
const planArr = [...plan];
const connu = (code) => plan.has(code) || planArr.some((p) => p.startsWith(code));

const sansP = (s) => s.trim().replace(/\s*p\.?$/i, '');
function parse(raw) {
  const m = sansP(raw).match(/^(\d+)\s*(?:\(\s*sauf\s+(.+?)\s*\))?$/i);
  if (!m) return null;
  return { prefixe: m[1], sauf: (m[2] ?? '').split(/\s*(?:,|et)\s*/).map(sansP).filter(Boolean) };
}
const match = (code, raw) => {
  const e = parse(raw);
  return !!e && code.startsWith(e.prefixe) && !e.sauf.some((x) => code.startsWith(x));
};

// Découpe le fichier source en tables, puis chaque table en postes.
function table(nom) {
  const m = src.match(new RegExp(`export const ${nom}: PosteEtat\\[\\] = \\[([\\s\\S]*?)\\n\\];`));
  if (!m) return [];
  return [...m[1].matchAll(/\{\s*ref:\s*'([A-Z]{2})'[\s\S]*?\n?\s*\}(?=,)/g)].map((x) => ({
    ref: x[1],
    bloc: x[0],
    exprs: [...x[0].matchAll(/(?:brut|amort|comptes):\s*\[([^\]]*)\]/g)]
      .flatMap((b) => [...b[1].matchAll(/'([^']+)'/g)].map((q) => q[1])),
    formule: (x[0].match(/formule:\s*'([^']*)'/) ?? [])[1],
    nature: (x[0].match(/nature:\s*'([a-z]+)'/) ?? [])[1],
  }));
}

let ko = 0;
const fail = (m) => { console.error(`  FAIL ${m}`); ko++; };

const tables = { BILAN_ACTIF: table('BILAN_ACTIF'), BILAN_PASSIF: table('BILAN_PASSIF'), COMPTE_DE_RESULTAT: table('COMPTE_DE_RESULTAT') };

for (const [nom, postes] of Object.entries(tables)) {
  if (!postes.length) { fail(`table ${nom} introuvable ou vide`); continue; }

  // 1 & 2 — expressions et codes
  let nbExpr = 0;
  for (const p of postes) {
    for (const raw of p.exprs) {
      nbExpr++;
      const e = parse(raw);
      if (!e) { fail(`${nom} ${p.ref} : expression illisible « ${raw} »`); continue; }
      for (const c of [e.prefixe, ...e.sauf]) if (!connu(c)) fail(`${nom} ${p.ref} : compte ${c} absent du plan (« ${raw} »)`);
    }
  }

  // 3 — références citées dans les formules
  const refs = new Set(postes.map((p) => p.ref));
  for (const p of postes) {
    if (!p.formule) continue;
    for (const r of p.formule.match(/\b[A-Z]{2}\b/g) ?? []) {
      if (!refs.has(r)) fail(`${nom} ${p.ref} : la formule cite ${r}, qui n'est pas un poste de cet état`);
    }
  }

  // 4 — un poste calculé ne porte pas de comptes, un poste simple en porte
  for (const p of postes) {
    const calcule = p.nature === 'total' || p.nature === 'solde' || p.nature === 'rubrique';
    if (calcule && p.exprs.length) fail(`${nom} ${p.ref} : poste calculé mais porte des comptes`);
    if (!calcule && !p.exprs.length) fail(`${nom} ${p.ref} : poste sans compte`);
  }

  // 5 — pas deux postes sur le même compte (hors colonne amortissements)
  const brut = postes.map((p) => ({
    ref: p.ref,
    exprs: [...p.bloc.matchAll(/(?:brut|comptes):\s*\[([^\]]*)\]/g)].flatMap((b) => [...b[1].matchAll(/'([^']+)'/g)].map((q) => q[1])),
  }));
  for (const code of planArr) {
    const hits = brut.filter((p) => p.exprs.some((raw) => match(code, raw))).map((p) => p.ref);
    if (hits.length > 1) fail(`${nom} : le compte ${code} est réclamé par ${hits.join(' et ')}`);
  }

  console.log(`  ${nom} : ${postes.length} postes, ${nbExpr} expressions — OK`);
}

console.log(ko === 0 ? '\nTableaux de correspondance conformes ✅' : `\n${ko} anomalie(s)`);
process.exitCode = ko === 0 ? 0 : 1;
