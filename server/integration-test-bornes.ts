import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';

// ============================================================================
// BORNAGE TEMPOREL et intégrité des exercices.
//
// Deux besoins distincts, souvent confondus :
//   • filtrer par EXERCICE (fiscal_year_id) — la lecture comptable ;
//   • borner par DATES à l'intérieur — la lecture de contrôle (un mois, un
//     trimestre, une situation arrêtée).
//
// Et un défaut que ce test verrouille : createFiscalYear n'imposait rien. Un
// « Exercice 2025 » courant jusqu'en 2026, ou deux exercices qui se recouvrent,
// étaient acceptés — et postEntry validait alors une date de 2026 comme étant
// « dans » l'exercice 2025. Toutes les lectures filtrées par exercice s'en
// trouvaient faussées, sans le moindre signal.
//
// anomaliesExercices() diagnostique l'existant, que les contrôles à la création
// ne peuvent pas rattraper.
//
//   npm run test:bornes   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const u = randomUUID();
  const cab = await withUser(u, (c) => acc.onboardCabinet(c, u, 'Cab', 'CI'));
  const d = await withUser(u, (c) => acc.openDossier(c, { cabinetId: cab, raisonSociale: 'PME', country: 'CI' }));
  const fy = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2025', '2025-01-01', '2025-12-31'));
  const j = await withUser(u, (c) => acc.createJournal(c, d.id, 'BQ', 'Banque', 'banque'));

  // --- garde-fous à la création d'exercice ---
  const refuse = async (label: string, a: string, b: string) => {
    try { await withUser(u, (c) => acc.createFiscalYear(c, d.id, label, a, b)); return false; }
    catch { return true; }
  };
  check('chevauchement refusé', await refuse('Exercice bis', '2025-06-01', '2026-05-31'));
  check('exercice de 24+ mois refusé', await refuse('Exercice long', '2027-01-01', '2029-06-30'));
  check('fin avant début refusée', await refuse('Exercice inversé', '2027-12-31', '2027-01-01'));
  const fy26 = await withUser(u, (c) => acc.createFiscalYear(c, d.id, 'Exercice 2026', '2026-01-01', '2026-12-31'));
  check('exercice adjacent accepté', !!fy26);

  // --- bornage temporel ---
  for (const [date, montant] of [['2025-02-10', 100000], ['2025-06-15', 200000], ['2025-11-20', 300000]] as [string, number][]) {
    await withUser(u, (c) => acc.postEntry(c, {
      dossierId: d.id, fiscalYearId: fy, journalId: j, entryDate: date, description: `Vente ${date}`, source: 'manual',
      lines: [{ accountCode: '521', debit: montant }, { accountCode: '701', credit: montant }],
    }));
  }
  const tout = await withUser(u, (c) => acc.trialBalance(c, d.id, fy));
  const s = (r: any[], code: string) => r.find((x: any) => x.account_code === code)?.balance ?? 0;
  check('balance exercice entier : 701 = -600 000', s(tout, '701') === -600000, `(${s(tout, '701')})`);

  const t1 = await withUser(u, (c) => acc.trialBalance(c, d.id, fy, { from: '2025-01-01', to: '2025-06-30' }));
  check('balance bornée au 1er semestre : 701 = -300 000', s(t1, '701') === -300000, `(${s(t1, '701')})`);

  const t2 = await withUser(u, (c) => acc.trialBalance(c, d.id, fy, { from: '2025-07-01' }));
  check('balance depuis juillet : 701 = -300 000', s(t2, '701') === -300000, `(${s(t2, '701')})`);

  const gl = await withUser(u, (c) => acc.generalLedger(c, d.id, { fiscalYearId: fy, from: '2025-06-01', to: '2025-06-30' }));
  check('grand livre borné à juin : 2 lignes', gl.length === 2, `(${gl.length})`);

  // --- diagnostic sur données déjà abîmées : on force un exercice mal borné ---
  await withUser(u, (c) => c.query(
    "update fiscal_years set end_date='2026-06-30' where dossier_id=$1 and id=$2", [d.id, fy]));
  await withUser(u, (c) => acc.postEntry(c, {
    dossierId: d.id, fiscalYearId: fy, journalId: j, entryDate: '2026-03-15', description: 'Opération 2026 dans exercice 2025', source: 'manual',
    lines: [{ accountCode: '521', debit: 50000 }, { accountCode: '701', credit: 50000 }],
  }));
  await withUser(u, (c) => c.query(
    "update fiscal_years set end_date='2025-12-31' where dossier_id=$1 and id=$2", [d.id, fy]));

  const an = await withUser(u, (c) => acc.anomaliesExercices(c, d.id));
  check('diagnostic : écriture hors bornes détectée', an.ecrituresHorsBornes.length === 1, `(${an.ecrituresHorsBornes[0]?.nb} écriture(s) — ${an.ecrituresHorsBornes[0]?.premiere})`);
  check('diagnostic : aucun chevauchement résiduel', an.chevauchements.length === 0);
  check('diagnostic : origine identifiée (journal)', (an.ecrituresHorsBornes[0]?.journaux ?? []).includes('BQ'),
    `(${(an.ecrituresHorsBornes[0]?.journaux ?? []).join(',')})`);

  // --- le garde-fou de date résiste à un objet Date ---
  // Le pilote pg restitue les colonnes `date` en objets Date : passer une telle
  // valeur faisait taire le contrôle, car `unObjetDate < 'chaîne'` vaut
  // toujours faux en JavaScript. Le contrôle laissait alors passer n'importe
  // quelle date, sans message.
  let refuseDate = false;
  try {
    await withUser(u, (c) => acc.postEntry(c, {
      dossierId: d.id, fiscalYearId: fy, journalId: j,
      entryDate: new Date('2026-03-15') as any, description: 'Objet Date hors exercice', source: 'manual',
      lines: [{ accountCode: '521', debit: 1000 }, { accountCode: '701', credit: 1000 }],
    }));
  } catch { refuseDate = true; }
  check('objet Date hors bornes refusé — garde-fou non contournable', refuseDate);

  let acceptee = false;
  try {
    await withUser(u, (c) => acc.postEntry(c, {
      dossierId: d.id, fiscalYearId: fy, journalId: j,
      entryDate: new Date('2025-08-15') as any, description: 'Objet Date dans exercice', source: 'manual',
      lines: [{ accountCode: '521', debit: 1000 }, { accountCode: '701', credit: 1000 }],
    }));
    acceptee = true;
  } catch { /* ignore */ }
  check('objet Date dans les bornes accepté', acceptee);
  if (acceptee) {
    const gl2 = await withUser(u, (c) => acc.generalLedger(c, d.id, { fiscalYearId: fy, from: '2025-08-01', to: '2025-08-31' }));
    check('date stockée normalisée en AAAA-MM-JJ', gl2.some((l: any) => l.entry_date === '2025-08-15'), `(${gl2[0]?.entry_date})`);
  }

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
