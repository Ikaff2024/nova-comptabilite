import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import * as tiers from './domain/tiers.js';
import * as lettrage from './domain/lettrage.js';
import * as dash from './domain/dossierdashboard.js';
import * as forecast from './domain/forecast.js';
import * as relances from './domain/relances.js';
import * as purchases from './domain/purchases.js';
import * as clotureworks from './domain/clotureworks.js';
import * as accdocs from './documents/accounting-docs.js';

// ============================================================================
// Scénario « deux exercices + clôture ». Verrouille l'invariant qui régit tous
// les états : une lecture PAR EXERCICE filtre sur fiscal_year_id (à-nouveaux
// compris) ; une lecture CUMULÉE (encours non lettré, position à date) écarte
// les à-nouveaux de report, qui rejoueraient les pièces de l'exercice clos.
// Sans cela, tout ce qui touche au bilan double après la première clôture.
//
//   npm run test:exercices   (nécessite DATABASE_URL, cf. docs/DEV-LOCAL.md)
// ============================================================================

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${label} ${detail}`); }
  else { failed++; console.error(`  FAIL ${label} ${detail}`); process.exitCode = 1; }
}

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cabinet Test', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME Deux Exercices', country: 'CI' }));

  const fy25 = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2025', '2025-01-01', '2025-12-31'));
  const fy26 = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  const jVE = await withUser(u, (c) => acc.createJournal(c, d.id, 'VE', 'Ventes', 'ventes'));
  const jAC = await withUser(u, (c) => acc.createJournal(c, d.id, 'AC', 'Achats', 'achats'));
  const jBQ = await withUser(u, (c) => acc.createJournal(c, d.id, 'BQ', 'Banque', 'banque'));

  const client = await withUser(u, (c) => tiers.createCounterparty(c, d.id, { type: 'client', name: 'Client Alpha' }));
  const frs = await withUser(u, (c) => tiers.createCounterparty(c, d.id, { type: 'fournisseur', name: 'Fournisseur Beta' }));

  // --- Exercice 2025 : vente à crédit 1 000 000 (impayée) + achat 400 000 (impayé)
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy25, journalId: jVE, entryDate: '2025-03-10',
    description: 'Facture Alpha', source: 'manual',
    lines: [
      { accountCode: '411', debit: 1000000, counterpartyId: client.id, label: 'Fact. A-001' },
      { accountCode: '701', credit: 1000000 },
    ],
  }));
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy25, journalId: jAC, entryDate: '2025-04-05',
    description: 'Facture Beta', source: 'manual',
    lines: [
      { accountCode: '601', debit: 400000 },
      { accountCode: '401', credit: 400000, counterpartyId: frs.id, label: 'Fact. B-001' },
    ],
  }));
  // Encaissement partiel 300 000 en 2025 (non lettré volontairement)
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy25, journalId: jBQ, entryDate: '2025-06-20',
    description: 'Acompte Alpha', source: 'manual',
    lines: [
      { accountCode: '521', debit: 300000 },
      { accountCode: '411', credit: 300000, counterpartyId: client.id, label: 'Acompte' },
    ],
  }));

  const tb25 = await withUser(u, (c) => acc.trialBalance(c, d.id, fy25));
  const c411_25 = tb25.find((r: any) => r.account_code === '411');
  check('2025 · 411 = 700 000', c411_25?.balance === 700000, `(${c411_25?.balance})`);

  // --- Clôture 2025 → à-nouveaux dans 2026
  const clo = await withUser(u, (c) => acc.closeExercise(c, d.id, fy25));
  check('clôture 2025 → résultat 600 000', clo.resultat === 600000, `(${clo.resultat})`);
  check('clôture 2025 → exercice suivant = 2026', clo.newFiscalYearId === fy26);

  // --- Exercice 2026 : nouvelle vente 500 000
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy26, journalId: jVE, entryDate: '2026-02-15',
    description: 'Facture Alpha 2', source: 'manual',
    lines: [
      { accountCode: '411', debit: 500000, counterpartyId: client.id, label: 'Fact. A-002' },
      { accountCode: '701', credit: 500000 },
    ],
  }));

  // ---------------- Balance générale ----------------
  const tb26 = await withUser(u, (c) => acc.trialBalance(c, d.id, fy26));
  const c411_26 = tb26.find((r: any) => r.account_code === '411');
  check('2026 · 411 = 1 200 000 (AN 700k + 500k)', c411_26?.balance === 1200000, `(${c411_26?.balance})`);
  check('2026 · à-nouveaux 411 = 700 000', c411_26?.open_debit === 700000, `(${c411_26?.open_debit})`);
  const c701_26 = tb26.find((r: any) => r.account_code === '701');
  check('2026 · 701 ne cumule pas 2025', c701_26?.balance === -500000, `(${c701_26?.balance})`);

  const tbAll = await withUser(u, (c) => acc.trialBalance(c, d.id));
  const c411_all = tbAll.find((r: any) => r.account_code === '411');
  check('sans exercice · 411 double bien (1 900 000) → filtrage indispensable',
    c411_all?.balance === 1900000, `(${c411_all?.balance})`);

  // ---------------- Balance auxiliaire ----------------
  const aux26 = await withUser(u, (c) => tiers.auxiliaryBalance(c, d.id, { fiscalYearId: fy26 }));
  const alpha26 = aux26.find((r: any) => r.id === client.id);
  check('aux 2026 · solde exercice Alpha = 1 200 000', alpha26?.balance === 1200000, `(${alpha26?.balance})`);
  check('aux 2026 · encours non lettré Alpha = 1 200 000 (pas de doublon)',
    alpha26?.open_balance === 1200000, `(${alpha26?.open_balance})`);
  check('aux 2026 · 3 postes ouverts Alpha', alpha26?.open_count === 3, `(${alpha26?.open_count})`);

  const aux25 = await withUser(u, (c) => tiers.auxiliaryBalance(c, d.id, { fiscalYearId: fy25 }));
  const alpha25 = aux25.find((r: any) => r.id === client.id);
  check('aux 2025 · solde exercice Alpha = 700 000', alpha25?.balance === 700000, `(${alpha25?.balance})`);
  check('aux 2025 · encours identique (toutes périodes)', alpha25?.open_balance === 1200000, `(${alpha25?.open_balance})`);

  const auxClients = await withUser(u, (c) => tiers.auxiliaryBalance(c, d.id, { type: 'client', fiscalYearId: fy26 }));
  check('aux · filtre type=client', auxClients.length === 1 && auxClients[0].id === client.id, `(${auxClients.length})`);

  // Cohérence balance générale ↔ balance auxiliaire sur le même exercice
  const sumAux26 = aux26.filter((r: any) => r.collective === '411').reduce((s: number, r: any) => s + r.balance, 0);
  check('aux 2026 · sous-total 411 = solde du collectif', sumAux26 === c411_26?.balance, `(${sumAux26} vs ${c411_26?.balance})`);

  // ---------------- Balance âgée / encours ----------------
  const aged = await withUser(u, (c) => lettrage.agedBalance(c, d.id, '2026-03-01'));
  const aged411 = aged.find((r: any) => r.account_code === '411');
  check('balance âgée · 411 = 1 200 000 (sans doublon d\'à-nouveaux)', aged411?.balance === 1200000, `(${aged411?.balance})`);
  const aged401 = aged.find((r: any) => r.account_code === '401');
  check('balance âgée · 401 = -400 000', aged401?.balance === -400000, `(${aged401?.balance})`);

  const lv = await withUser(u, (c) => lettrage.accountLettrageView(c, d.id, '411'));
  check('lettrage 411 · 3 postes ouverts (AN de report écarté)', lv.open.length === 3, `(${lv.open.length})`);

  const tacc = await withUser(u, (c) => lettrage.tiersAccounts(c, d.id));
  const t411 = tacc.find((r: any) => r.account_code === '411');
  check('comptes tiers · 411 open_count = 3', t411?.open_count === 3, `(${t411?.open_count})`);

  const od = await withUser(u, (c) => relances.overdueClients(c, d.id, '2026-03-01'));
  check('relances · Alpha dû = 1 200 000', od[0]?.balance === 1200000, `(${od[0]?.balance})`);

  const sa = await withUser(u, (c) => purchases.supplierAging(c, d.id, '2026-03-01'));
  check('aging fournisseurs · Beta dû = 400 000', sa[0]?.balance === 400000, `(${sa[0]?.balance})`);

  // ---------------- Tableau de bord ----------------
  const db26: any = await withUser(u, (c) => dash.dossierDashboard(c, d.id, fy26));
  check('synthèse 2026 · créances = 1 200 000', db26.kpis.creances === 1200000, `(${db26.kpis.creances})`);
  check('synthèse 2026 · dettes frs = 400 000', db26.kpis.dettesFrs === 400000, `(${db26.kpis.dettesFrs})`);
  check('synthèse 2026 · trésorerie = 300 000', db26.kpis.tresorerie === 300000, `(${db26.kpis.tresorerie})`);
  check('synthèse 2026 · résultat exercice = 500 000', db26.kpis.resultat === 500000, `(${db26.kpis.resultat})`);
  check('synthèse 2026 · top client = 1 200 000', db26.topClients[0]?.amount === 1200000, `(${db26.topClients[0]?.amount})`);

  const db25: any = await withUser(u, (c) => dash.dossierDashboard(c, d.id, fy25));
  check('synthèse 2025 · créances à fin 2025 = 700 000', db25.kpis.creances === 700000, `(${db25.kpis.creances})`);
  check('synthèse 2025 · résultat = 600 000', db25.kpis.resultat === 600000, `(${db25.kpis.resultat})`);
  check('synthèse 2025 · exercice affiché', db25.fiscalYear?.label === 'Exercice 2025', `(${db25.fiscalYear?.label})`);

  // ---------------- Prévisionnel / clôture ----------------
  const fc: any = await withUser(u, (c) => forecast.cashForecast(c, d.id, {}));
  check('prévisionnel · trésorerie de départ = 300 000', fc.currentCash === 300000, `(${fc.currentCash})`);

  const cw: any = await withUser(u, (c) => clotureworks.clotureChecklist(c, d.id, fy26));
  check('checklist clôture · exécutée', Array.isArray(cw?.taches), `(${cw?.taches?.length} tâches)`);

  // ---------------- Grand livre auxiliaire / relevés ----------------
  const gl26 = await withUser(u, (c) => tiers.auxiliaryLedger(c, d.id, client.id, { fiscalYearId: fy26 }));
  check('GL tiers 2026 · 2 lignes (AN + facture)', gl26.length === 2, `(${gl26.length})`);
  const glOpen = await withUser(u, (c) => tiers.auxiliaryLedger(c, d.id, client.id, { openOnly: true }));
  check('GL tiers encours · 3 lignes, sans AN', glOpen.length === 3, `(${glOpen.length})`);
  const st: any = await withUser(u, (c) => tiers.tiersStatement(c, d.id, client.id));
  check('relevé de compte · solde 1 200 000', st.totals.solde === 1200000, `(${st.totals.solde})`);

  const allGl = await withUser(u, (c) => tiers.allTiersLedger(c, d.id, { fiscalYearId: fy26 }));
  check('GL auxiliaire complet 2026 · filtré par exercice', allGl.length === 3, `(${allGl.length})`);

  const pdf1 = await withUser(u, (c) => accdocs.balanceAuxiliairePdf(c, d.id, fy26));
  check('PDF balance auxiliaire (exercice) généré', pdf1.buffer.length > 500 && pdf1.count === 2, `(${pdf1.count} tiers)`);
  const pdf2 = await withUser(u, (c) => accdocs.grandLivreAuxiliairePdf(c, d.id, fy26));
  check('PDF grand livre auxiliaire (exercice) généré', pdf2.buffer.length > 500 && pdf2.count === 3, `(${pdf2.count} lignes)`);

  // ---------------- Lettrage automatique ----------------
  // Règlement du solde Alpha en 2026 : doit se lettrer avec les pièces d'origine.
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy26, journalId: jBQ, entryDate: '2026-05-10',
    description: 'Règlement Alpha', source: 'manual',
    lines: [
      { accountCode: '521', debit: 500000 },
      { accountCode: '411', credit: 500000, counterpartyId: client.id, label: 'Règlement A-002' },
    ],
  }));
  const al = await withUser(u, (c) => lettrage.autoLettrage(c, d.id, '411'));
  check('lettrage auto · 1 groupe (facture A-002 ↔ règlement)', al.groups === 1, `(${al.groups} groupes, ${al.linesLettered} lignes)`);
  const aux26b = await withUser(u, (c) => tiers.auxiliaryBalance(c, d.id, { fiscalYearId: fy26 }));
  const alpha26b = aux26b.find((r: any) => r.id === client.id);
  check('après lettrage · encours Alpha = 700 000', alpha26b?.open_balance === 700000, `(${alpha26b?.open_balance})`);
  check('après lettrage · solde exercice Alpha = 700 000', alpha26b?.balance === 700000, `(${alpha26b?.balance})`);

  console.log(`\n${passed} PASS / ${failed} FAIL`);
  await closePool();
}

main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
