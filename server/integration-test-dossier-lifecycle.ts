import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';

// ============================================================================
// CYCLE DE VIE D'UN DOSSIER — suppression d'un dossier RÉELLEMENT peuplé.
//
// NOUVEAU-P1-A. dossier_delete() échouait sur tout dossier contenant une
// écriture validée, donc sur tout dossier réel : les verrous d'immuabilité
// refusent `delete from entry_lines`. Le test de sécurité existant ne l'avait
// pas vu parce qu'il supprime un dossier VIDE.
//
// Le correctif ouvre une porte étroite (migration 0081) : DELETE seulement,
// pour un dossier explicitement nommé, et sous identité PROPRIÉTAIRE des
// tables. Le rôle applicatif n'étant jamais propriétaire, une route normale ne
// peut pas l'emprunter. Ce test le vérifie plutôt que de le supposer.
//
//   npm run test:dossier-lifecycle
// ============================================================================

let ok = 0, ko = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { ok++; console.log(`  PASS ${label} ${detail}`); }
  else { ko++; console.error(`  FAIL ${label} ${detail}`); }
};

/** Monte un dossier et le peuple selon les axes demandés. */
async function dossierPeuple(user: string, cabinet: string, nom: string, opts: {
  brouillon?: boolean; validee?: boolean; document?: boolean;
  immobilisation?: boolean; analytique?: boolean; tiers?: boolean;
} = {}) {
  const d = await withUser(user, (c) => acc.openDossier(c, {
    cabinetId: cabinet, raisonSociale: nom, country: 'CI',
  }));

  await withUser(user, async (c) => {
    const fyId = await acc.createFiscalYear(c, d.id, '2026', '2026-01-01', '2026-12-31');
    const { rows: jr } = await c.query(
      `insert into journals(dossier_id, code, label, type)
       values ($1,'OD','Opérations diverses','operations_diverses') returning id`, [d.id]);

    const poser = async (statut: 'draft' | 'posted', montant: number) => {
      const { id } = await acc.postEntry(c, {
        dossierId: d.id, fiscalYearId: fyId, journalId: jr[0].id,
        entryDate: '2026-03-01', description: `${statut} ${montant}`,
        lines: [
          { accountCode: '6011', debit: montant, credit: 0 },
          { accountCode: '4011', debit: 0, credit: montant },
        ],
      });
      if (statut === 'draft') {
        await c.query("update entries set status='draft' where id=$1", [id]);
      }
      return id;
    };

    if (opts.validee) { await poser('posted', 500000); await poser('posted', 250000); }
    if (opts.brouillon) {
      const { rows } = await c.query(
        `insert into entries(dossier_id, fiscal_year_id, journal_id, entry_date, description, status)
         values ($1,$2,$3,'2026-04-01','BROUILLON','draft') returning id`, [d.id, fyId, jr[0].id]);
      const { rows: a } = await c.query(
        "select id from accounts where dossier_id=$1 and account_code='6011'", [d.id]);
      await c.query(
        `insert into entry_lines(entry_id, dossier_id, account_id, amount_debit, amount_credit)
         values ($1,$2,$3,1000,0)`, [rows[0].id, d.id, a[0].id]);
    }
    if (opts.tiers) {
      await c.query(
        `insert into counterparties(dossier_id, name, type) values ($1,'Client Test','client')`, [d.id]);
    }
    if (opts.document) {
      const { rows } = await c.query(
        `insert into documents(dossier_id, filename, mime_type, size_bytes, storage)
         values ($1,'piece.pdf','application/pdf',3,'db') returning id`, [d.id]);
      await c.query(
        `insert into document_blobs(document_id, dossier_id, data) values ($1,$2,$3)`,
        [rows[0].id, d.id, Buffer.from('pdf')]);
    }
    if (opts.immobilisation) {
      await c.query(
        `insert into fixed_assets(dossier_id, label, asset_account_code, amort_account_code,
                                   acquisition_date, commissioning_date, amount, duration_years)
         values ($1,'Véhicule','2441','2841','2026-01-15','2026-01-15',6000000,5)`, [d.id]);
    }
    if (opts.analytique) {
      const { rows: ax } = await c.query(
        `insert into analytic_axes(dossier_id, code, label) values ($1,'GEO','Géographie') returning id`, [d.id]);
      await c.query(
        `insert into analytic_sections(dossier_id, axis_id, code, label)
         values ($1,$2,'ABJ','Abidjan')`, [d.id, ax[0].id]);
    }
  });

  return d;
}

// Compteur de vérification : il doit voir CE QUI EST RÉELLEMENT EN BASE.
//
// La première version interrogeait le pool applicatif sans poser d'identité.
// Sous RLS, cela ne renvoie aucune ligne (fail-closed) : le compteur valait 0
// avant comme après la suppression, et tous les contrôles « plus aucune
// écriture » passaient sans rien prouver. Un test aveugle est pire qu'absent —
// il donne l'illusion d'une garantie.
//
// On lit donc en identité propriétaire, hors RLS : après suppression du
// dossier, plus aucun utilisateur ne l'a dans son périmètre, et seule cette
// lecture peut distinguer « supprimé » de « invisible ».
const ADMIN_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const verite = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });

async function compte(dossierId: string, table: string): Promise<number> {
  const { rows } = await verite.query(`select count(*)::int n from ${table} where dossier_id = $1`, [dossierId]);
  return rows[0].n;
}

async function main() {
  const owner = randomUUID(), collab = randomUUID(), etranger = randomUUID();

  const cab = await withUser(owner, (c) => acc.onboardCabinet(c, owner, 'Cabinet Cycle', 'CI'));
  await withUser(etranger, (c) => acc.onboardCabinet(c, etranger, 'Cabinet Étranger', 'SN'));
  await withUser(owner, (c) => c.query(
    'select cabinet_member_add($1,$2,$3)', [cab, '', 'collaborateur']).catch(() => {}));

  console.log('\n--- 1) Dossier VIDE : suppression (comportement déjà couvert) ---');
  {
    const d = await dossierPeuple(owner, cab, 'Vide SARL');
    await withUser(owner, (c) => acc.deleteDossier(c, d.id));
    const reste = await withUser(owner, (c) => acc.listDossiers(c));
    check('dossier vide supprimé', !reste.some((x: any) => x.id === d.id));
  }

  console.log('\n--- 2) Dossier avec BROUILLON ---');
  {
    const d = await dossierPeuple(owner, cab, 'Brouillon SARL', { brouillon: true });
    check('brouillon présent avant', await compte(d.id, 'entries') === 1);
    await withUser(owner, (c) => acc.deleteDossier(c, d.id));
    check('dossier avec brouillon supprimé', await compte(d.id, 'entries') === 0);
  }

  console.log('\n--- 3) Dossier avec ÉCRITURES VALIDÉES (le cas qui échouait) ---');
  {
    const d = await dossierPeuple(owner, cab, 'Validee SARL', { validee: true });
    const avantE = await compte(d.id, 'entries');
    const avantL = await compte(d.id, 'entry_lines');
    check('écritures validées présentes avant', avantE === 2 && avantL === 4, `(${avantE} écr. / ${avantL} lignes)`);
    let erreur = '';
    try { await withUser(owner, (c) => acc.deleteDossier(c, d.id)); }
    catch (e: any) { erreur = e.message; }
    check('suppression réussie malgré les écritures validées', erreur === '', erreur ? `(${erreur.slice(0, 80)})` : '');
    check('plus aucune écriture', await compte(d.id, 'entries') === 0);
    check('plus aucune ligne', await compte(d.id, 'entry_lines') === 0);
  }

  console.log('\n--- 4 à 7) Dossier COMPLET : documents, immobilisations, analytique, tiers ---');
  {
    const d = await dossierPeuple(owner, cab, 'Complete SARL', {
      validee: true, brouillon: true, document: true, immobilisation: true, analytique: true, tiers: true,
    });
    const avant = {
      docs: await compte(d.id, 'documents'), blobs: await compte(d.id, 'document_blobs'),
      immo: await compte(d.id, 'fixed_assets'), axes: await compte(d.id, 'analytic_axes'),
      sections: await compte(d.id, 'analytic_sections'), tiers: await compte(d.id, 'counterparties'),
      comptes: await compte(d.id, 'accounts'),
    };
    check('dossier réellement peuplé', avant.docs > 0 && avant.immo > 0 && avant.axes > 0 && avant.comptes > 100,
      `(${avant.docs} doc, ${avant.immo} immo, ${avant.axes} axe, ${avant.comptes} comptes)`);

    await withUser(owner, (c) => acc.deleteDossier(c, d.id));

    check('documents supprimés', await compte(d.id, 'documents') === 0);
    check('blobs supprimés', await compte(d.id, 'document_blobs') === 0);
    check('immobilisations supprimées', await compte(d.id, 'fixed_assets') === 0);
    check('axes analytiques supprimés', await compte(d.id, 'analytic_axes') === 0);
    check('sections analytiques supprimées', await compte(d.id, 'analytic_sections') === 0);
    check('tiers supprimés', await compte(d.id, 'counterparties') === 0);
    check('plan comptable supprimé', await compte(d.id, 'accounts') === 0);
    check('journaux supprimés', await compte(d.id, 'journals') === 0);
    check('exercices supprimés', await compte(d.id, 'fiscal_years') === 0);
  }

  console.log('\n--- 8) Cabinet ÉTRANGER tente la suppression → refus ---');
  {
    const d = await dossierPeuple(owner, cab, 'Cible SARL', { validee: true });
    let bloque = false, msg = '';
    try { await withUser(etranger, (c) => acc.deleteDossier(c, d.id)); }
    catch (e: any) { bloque = true; msg = e.message; }
    check('un étranger ne supprime pas', bloque, `(${msg.slice(0, 60)})`);
    check('le dossier est toujours là', await compte(d.id, 'entries') === 2);
    await withUser(owner, (c) => acc.deleteDossier(c, d.id));
  }

  console.log('\n--- 9) COLLABORATEUR du cabinet tente la suppression → refus ---');
  {
    const d = await dossierPeuple(owner, cab, 'Collab SARL', { validee: true });
    await verite.query('insert into cabinet_members(cabinet_id, user_id, role) values ($1,$2,$3)',
      [cab, collab, 'collaborateur']);
    let bloque = false, msg = '';
    try { await withUser(collab, (c) => acc.deleteDossier(c, d.id)); }
    catch (e: any) { bloque = true; msg = e.message; }
    check('un collaborateur ne supprime pas', bloque, `(${msg.slice(0, 60)})`);
    check('le dossier est toujours là', await compte(d.id, 'entries') === 2);
    await withUser(owner, (c) => acc.deleteDossier(c, d.id));
  }

  console.log('\n--- 10) La porte de démontage n\'est PAS empruntable par une route normale ---');
  {
    const d = await dossierPeuple(owner, cab, 'Porte SARL', { validee: true });
    const { rows: e } = await verite.query(
      "select id from entries where dossier_id=$1 and status='posted' limit 1", [d.id]);

    // Un client qui pose lui-même le drapeau reste bloqué : il n'est pas
    // propriétaire des tables. C'est la condition qui tient la porte fermée.
    let bloque = false, msg = '';
    try {
      await withUser(owner, async (c) => {
        await c.query("select set_config('app.dossier_teardown', $1, true)", [d.id]);
        await c.query('delete from entry_lines where entry_id = $1', [e[0].id]);
      });
    } catch (err: any) { bloque = true; msg = err.message; }
    check('drapeau posé par le client : DELETE toujours refusé', bloque, `(${msg.slice(0, 70)})`);

    // Et l'exemption ne couvre jamais l'ajout, même drapeau posé.
    let bloqueInsert = false;
    try {
      await withUser(owner, async (c) => {
        await c.query("select set_config('app.dossier_teardown', $1, true)", [d.id]);
        const { rows: a } = await c.query(
          "select id from accounts where dossier_id=$1 and account_code='6011'", [d.id]);
        await c.query(
          `insert into entry_lines(entry_id, dossier_id, account_id, amount_debit, amount_credit)
           values ($1,$2,$3,1,0)`, [e[0].id, d.id, a[0].id]);
      });
    } catch { bloqueInsert = true; }
    check('drapeau posé : INSERT dans une écriture validée toujours refusé', bloqueInsert);

    check('l\'écriture est intacte', await compte(d.id, 'entry_lines') === 4);
    await withUser(owner, (c) => acc.deleteDossier(c, d.id));
  }

  console.log('\n--- 11) Opération interrompue → aucune suppression partielle ---');
  {
    const d = await dossierPeuple(owner, cab, 'Atomique SARL', { validee: true, document: true });
    const avant = await compte(d.id, 'entry_lines');
    // On annule la transaction après l'appel : rien ne doit avoir bougé.
    const c = await verite.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.current_user_id', $1, true)", [owner]);
      await c.query('select dossier_delete($1)', [d.id]);
      await c.query('rollback');
    } finally { c.release(); }
    check('après rollback : lignes intactes', await compte(d.id, 'entry_lines') === avant, `(${avant})`);
    check('après rollback : documents intacts', await compte(d.id, 'documents') === 1);
    check('après rollback : dossier toujours présent',
      (await withUser(owner, (cc) => acc.listDossiers(cc))).some((x: any) => x.id === d.id));
    await withUser(owner, (cc) => acc.deleteDossier(cc, d.id));
  }

  console.log('\n--- 12) La piste d\'audit survit à la suppression ---');
  {
    const d = await dossierPeuple(owner, cab, 'Audit SARL', { validee: true });
    await withUser(owner, (c) => acc.deleteDossier(c, d.id));
    const { rows } = await verite.query(
      `select action, detail from audit_log
        where action = 'dossier.deleted' and detail->>'dossier_id' = $1`, [d.id]);
    check('une trace dossier.deleted subsiste', rows.length === 1);
    check('elle nomme le dossier et sa volumétrie',
      rows[0]?.detail?.raison_sociale === 'Audit SARL' && Number(rows[0]?.detail?.ecritures) === 2,
      rows[0] ? `(${rows[0].detail.raison_sociale}, ${rows[0].detail.ecritures} écritures)` : '');
  }

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await verite.end().catch(() => {});
  await closePool();
}

main().catch(async (e) => {
  console.error('ERREUR', e);
  process.exitCode = 1;
  await verite.end().catch(() => {});
  await closePool().catch(() => {});
});
