import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';

// Test d'intégration de la couche domaine (rôle nova_app, RLS active).
// Rejoue le parcours complet d'un cabinet via le code TS, pas en SQL brut.

let passed = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${label} ${detail}`); }
  else { console.error(`  FAIL ${label} ${detail}`); process.exitCode = 1; }
}

async function expectThrow(label: string, fn: () => Promise<any>) {
  try { await fn(); check(label, false, '(aucune erreur levée)'); }
  catch (e: any) { check(label, true, `(rejeté: ${String(e.message).slice(0, 50)})`); }
}

async function main() {
  const userA = randomUUID();
  const userB = randomUUID();

  // 1) Onboarding cabinet A + dossier + plan
  const cabA = await withUser(userA, (c) => acc.onboardCabinet(c, userA, 'Cabinet Abidjan', 'CI'));
  check('1 onboarding cabinet', !!cabA);

  const dossier = await withUser(userA, (c) =>
    acc.openDossier(c, { cabinetId: cabA, raisonSociale: 'PME Pilote SARL', country: 'CI' }));
  check('2 plan instancié', dossier.accounts === 1330, `(${dossier.accounts} comptes)`);

  // 3) Structures
  const fy = await withUser(userA, (c) => acc.createFiscalYear(c, dossier.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jrnl = await withUser(userA, (c) => acc.createJournal(c, dossier.id, 'VE', 'Ventes', 'ventes'));
  check('3 exercice + journal', !!fy && !!jrnl);

  // 4) Recherche de comptes
  const found = await withUser(userA, (c) => acc.listAccounts(c, dossier.id, { search: '701' }));
  check('4 recherche compte 701', found.some((a: any) => a.account_code === '701'));

  // 5) Écriture équilibrée (vente encaissée par Wave)
  const entry = await withUser(userA, (c) => acc.postEntry(c, {
    dossierId: dossier.id, fiscalYearId: fy, journalId: jrnl,
    entryDate: '2026-06-29', description: 'Vente comptant', source: 'manual',
    lines: [
      { accountCode: '521', debit: 100000, paymentChannel: 'wave', label: 'Encaissement Wave' },
      { accountCode: '701', credit: 100000, label: 'Vente marchandises' },
    ],
  }));
  check('5 écriture équilibrée postée', !!entry.id);

  // 6) Écriture déséquilibrée -> refus (validation domaine)
  await expectThrow('6 déséquilibre refusé', () => withUser(userA, (c) => acc.postEntry(c, {
    dossierId: dossier.id, fiscalYearId: fy, journalId: jrnl,
    entryDate: '2026-06-29', description: 'KO',
    lines: [{ accountCode: '521', debit: 100 }, { accountCode: '701', credit: 90 }],
  })));

  // 7) Contre-passation
  const rev = await withUser(userA, (c) => acc.reverseEntry(c, entry.id));
  check('7 contre-passation', !!rev.reversalId);

  // 8) Balance nette = 0 après vente + extourne
  const tb = await withUser(userA, (c) => acc.trialBalance(c, dossier.id, fy));
  const net = tb.reduce((s: number, r: any) => s + Number(r.balance), 0);
  check('8 balance équilibrée', Math.abs(net) < 0.001, `(net=${net})`);

  // 9) Isolation RLS : cabinet B ne voit pas le dossier de A
  await withUser(userB, (c) => acc.onboardCabinet(c, userB, 'Cabinet Dakar', 'SN'));
  const visibleToA = await withUser(userA, (c) => acc.listDossiers(c));
  const visibleToB = await withUser(userB, (c) => acc.listDossiers(c));
  check('9 RLS user A', visibleToA.length === 1 && visibleToA[0].raison_sociale === 'PME Pilote SARL');
  check('9 RLS user B', visibleToB.length === 0, `(B voit ${visibleToB.length} dossier)`);

  console.log(`\n${passed} checks PASS${process.exitCode ? ' — avec échecs' : ' — tout vert ✅'}`);
  await closePool();
}

main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
