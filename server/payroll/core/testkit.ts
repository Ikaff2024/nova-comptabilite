// ============================================================================
// Micro-harnais de test (describe/it/expect) — permet de reprendre TELS QUELS
// les tests du paquet payroll-core d'IvoirePaie (écrits pour vitest) sans
// ajouter vitest au projet. Seuls les matchers réellement utilisés par ces
// tests sont implémentés. Lancé par `npm run test:payroll` (tsx).
//
// Ces tests sont le FILET DE SÉCURITÉ du moteur de paie : ils verrouillent les
// barèmes officiels (ITS, CNPS, RICF). Toute mise à jour du moteur doit les
// laisser au vert.
// ============================================================================

interface Result { suite: string; name: string; error?: string }
const results: Result[] = [];
let currentSuite = '';

export function describe(name: string, fn: () => void): void {
  const parent = currentSuite;
  currentSuite = parent ? `${parent} › ${name}` : name;
  try { fn(); } finally { currentSuite = parent; }
}

export function it(name: string, fn: () => void): void {
  try { fn(); results.push({ suite: currentSuite, name }); }
  catch (e: any) { results.push({ suite: currentSuite, name, error: e?.message ?? String(e) }); }
}
export const test = it;

const fmt = (v: unknown) => typeof v === 'object' ? JSON.stringify(v) : String(v);

// Construit les matchers ; `negate` inverse l'assertion (modificateur `.not`).
function matchers(actual: any, negate: boolean) {
  // Assure : `ok` = résultat brut du matcher ; on échoue si ok === negate.
  const check = (ok: boolean, expectation: string) => {
    if (ok === negate) {
      throw new Error(negate ? `attendu NON ${expectation}, obtenu ${fmt(actual)}` : `attendu ${expectation}, obtenu ${fmt(actual)}`);
    }
  };
  return {
    toBe: (e: any) => check(Object.is(actual, e), fmt(e)),
    toEqual: (e: any) => check(JSON.stringify(actual) === JSON.stringify(e), fmt(e)),
    toBeCloseTo: (e: number, digits = 2) => check(Math.abs(actual - e) < Math.pow(10, -digits) / 2, `~${e}`),
    toBeGreaterThan: (n: number) => check(actual > n, `> ${n}`),
    toBeGreaterThanOrEqual: (n: number) => check(actual >= n, `>= ${n}`),
    toBeLessThan: (n: number) => check(actual < n, `< ${n}`),
    toBeLessThanOrEqual: (n: number) => check(actual <= n, `<= ${n}`),
    toContain: (s: any) => check(
      typeof actual === 'string' ? actual.includes(s) : Array.isArray(actual) && actual.includes(s), `contenir ${fmt(s)}`),
    toMatch: (re: RegExp | string) => check(
      typeof re === 'string' ? String(actual).includes(re) : re.test(String(actual)), `correspondre à ${re}`),
    toBeDefined: () => check(actual !== undefined, 'défini'),
    toBeTruthy: () => check(!!actual, 'vrai'),
    toBeFalsy: () => check(!actual, 'faux'),
  };
}

export function expect(actual: any) {
  return { ...matchers(actual, false), not: matchers(actual, true) };
}

// Affiche le bilan et sort en code 1 si un test échoue (utilisable en CI).
export function report(): void {
  const failed = results.filter((r) => r.error);
  for (const f of failed) console.error(`  ✗ ${f.suite} › ${f.name}\n      ${f.error}`);
  const n = results.length;
  console.log(`\n${failed.length ? '✗ ÉCHEC' : '✓ SUCCÈS'} — ${n - failed.length}/${n} test(s) au vert.`);
  if (failed.length) process.exit(1);
}
