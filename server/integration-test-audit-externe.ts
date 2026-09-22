import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';
import { dossierContext, annonceUneMutation } from './ai/agent.js';
import { parseStatement, ReleveAmbiguError, ENTETE_ATTENDU } from './mobilemoney/parser.js';

// ============================================================================
// AUDIT EXTERNE DU 21 SEPTEMBRE 2026 — constats reproduits puis verrouillés.
//
// N01 (P1) — le compte de démonstration ouvre la « Console Nova » et y lit la
//            volumétrie et les coûts d'API de TOUS les cabinets clients.
// N02 (P1) — un relevé Mobile Money sans en-têtes fait lire 150 000 F comme
//            2 026 F : le montant était pris dans l'année de la date.
// H01 (P1) — Lexa a annoncé cinq écritures « comptabilisées au grand livre »
//            alors qu'elle ne disposait pas de l'outil pour le faire.
// N05 (P1) — Lexa répond sur l'exercice 2025 quand on l'interroge sur 2026,
//            alors que les états affichent bien 2026.
//
//   npm run test:audit-externe
// ============================================================================

let ok = 0, ko = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { ok++; console.log(`  PASS ${label} ${detail}`); }
  else { ko++; console.error(`  FAIL ${label} ${detail}`); }
};

const ADMIN_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });

async function main() {
  console.log('\n=== N01 — le compte de démonstration n\'est pas un opérateur ===');
  {
    // La migration 0051 accordait le droit opérateur en dur, par adresse email.
    // Ce n'était donc pas une case cochée par erreur sur un environnement : le
    // droit revenait sur toute base neuve. La migration 0082 le retire.
    const { rows } = await admin.query(
      "select is_platform_admin from app_users where lower(email) = 'demo@nova-comptabilite.ci'");
    if (rows.length === 0) {
      check('compte démo absent de cette base (rien à vérifier)', true, '(base de test)');
    } else {
      check('le compte démo n\'a PAS le droit opérateur', rows[0].is_platform_admin === false,
        `(is_platform_admin=${rows[0].is_platform_admin})`);
    }

    // Aucune adresse ne doit plus recevoir ce droit « par migration » à part
    // celle de l'éditeur. On constate l'état, pour que toute dérive se voie.
    const { rows: ops } = await admin.query(
      'select email from app_users where is_platform_admin order by email');
    const emails = ops.map((r: any) => String(r.email).toLowerCase());
    check('aucun compte de démonstration parmi les opérateurs',
      !emails.some((e) => e.includes('demo')), `(opérateurs : ${emails.join(', ') || 'aucun'})`);
  }

  console.log('\n=== N01 (suite) — la console refuse un utilisateur ordinaire ===');
  {
    // La garde serveur existait déjà et fonctionne. On la verrouille par un test
    // négatif : masquer le bouton dans l'interface n'aurait jamais suffi.
    const ordinaire = randomUUID();
    await withUser(ordinaire, (c) => acc.onboardCabinet(c, ordinaire, 'Cabinet Ordinaire', 'CI'));

    let refuse = false, msg = '';
    try { await withUser(ordinaire, (c) => c.query('select * from platform_cabinets()')); }
    catch (e: any) { refuse = true; msg = e.message; }
    check('un utilisateur ordinaire ne lit pas la console plateforme', refuse,
      `(${msg.slice(0, 50)})`);
    check('le refus est explicite', /NOT_PLATFORM_ADMIN/.test(msg));

    // Et il ne peut pas se promouvoir lui-même.
    let bloque = false;
    try {
      await withUser(ordinaire, (c) => c.query(
        'update app_users set is_platform_admin = true where id = $1', [ordinaire]));
      const { rows } = await admin.query(
        'select is_platform_admin from app_users where id = $1', [ordinaire]);
      bloque = rows[0]?.is_platform_admin !== true;
    } catch { bloque = true; }
    check('un utilisateur ne peut pas se promouvoir opérateur', bloque);
  }

  console.log('\n=== N02 — un relevé Mobile Money ne se devine pas ===');
  {
    const LIGNE = '2026-09-21;Paiement reçu;150000;AUDIT QA;QA-NOVA-20260921-001';

    // Le scénario exact de l'audit : la ligne d'exemple, collée deux fois, sans
    // en-têtes. Elle était lue à 2 026 F CFA — l'ANNÉE de la date.
    let refuse = false, msg = '';
    try { parseStatement(`${LIGNE}\n${LIGNE}`, 'wave'); }
    catch (e: any) { refuse = e instanceof ReleveAmbiguError; msg = e.message; }
    check("CSV sans en-têtes : refusé au lieu d'être mal lu", refuse, `(${msg.slice(0, 60)})`);
    check('le message dit quoi corriger', msg.includes(ENTETE_ATTENDU));

    // Contre-test de l'audit : avec en-têtes, la lecture est juste.
    const avec = parseStatement(`${ENTETE_ATTENDU}\n${LIGNE}`, 'wave');
    check('avec en-têtes : 1 transaction', avec.length === 1, `(${avec.length})`);
    check('montant = 150 000, pas 2 026', avec[0]?.amount === 150000, `(${avec[0]?.amount})`);
    check('tiers = AUDIT QA', avec[0]?.counterparty === 'AUDIT QA', `(${avec[0]?.counterparty})`);
    check('date = 2026-09-21', avec[0]?.date === '2026-09-21', `(${avec[0]?.date})`);
    check('« Paiement reçu » est un encaissement', avec[0]?.direction === 'in', `(${avec[0]?.direction})`);

    // Déduplication : deux lignes identiques donnent la MÊME référence, sinon
    // l'unicité en base ne peut rien rattraper.
    const deux = parseStatement(`${ENTETE_ATTENDU}\n${LIGNE}\n${LIGNE}`, 'wave');
    check('deux lignes identiques → même référence externe',
      deux.length === 2 && deux[0].externalRef === deux[1].externalRef, `(${deux[0]?.externalRef})`);

    // Le texte libre reste accepté (collage de SMS), mais un montant ne se lit
    // JAMAIS dans une date.
    const sms = parseStatement('Le 21/09/2026 vous avez recu 150000 FCFA de AUDIT QA', 'wave');
    check('texte libre : montant lu hors de la date', sms[0]?.amount === 150000, `(${sms[0]?.amount})`);
    check('texte libre : la date est comprise', sms[0]?.date === '2026-09-21', `(${sms[0]?.date})`);

    // Variantes exigées par l'audit : BOM, virgule, nombres français, guillemets.
    const variantes: [string, string, number][] = [
      ['BOM', `\uFEFF${ENTETE_ATTENDU}\n${LIGNE}`, 150000],
      ['séparateur virgule', 'date,type,montant,contrepartie,id\n2026-09-21,Paiement reçu,150000,AUDIT QA,R1', 150000],
      ['espace des milliers', `${ENTETE_ATTENDU}\n2026-09-21;Paiement reçu;150 000;AUDIT QA;R2`, 150000],
      ['décimale française', `${ENTETE_ATTENDU}\n2026-09-21;Paiement reçu;1500,50;AUDIT QA;R3`, 1500.5],
      ['champs cités', `${ENTETE_ATTENDU}\n"2026-09-21";"Paiement reçu";"150000";"AUDIT QA";"R4"`, 150000],
      ['date JJ/MM/AAAA', `${ENTETE_ATTENDU}\n21/09/2026;Paiement reçu;150000;AUDIT QA;R5`, 150000],
    ];
    for (const [nom, contenu, attendu] of variantes) {
      let got: number | undefined; let err = '';
      try { got = parseStatement(contenu, 'wave')[0]?.amount; } catch (e: any) { err = e.message; }
      check(`variante ${nom} : montant exact`, got === attendu, `(lu ${got ?? err.slice(0, 40)}, attendu ${attendu})`);
    }
  }


  console.log('\n=== H01 — Lexa n\'annonce jamais une action qu\'elle n\'a pas faite ===');
  {
    // Fausses annonces : première personne + verbe d'effet. C'est exactement la
    // forme de l'incident relevé (« cinq écritures comptabilisées au grand livre »).
    const fausses = [
      "J'ai comptabilisé les cinq écritures au grand livre.",
      "J’ai enregistré la facture dans le journal des ventes.",
      'Je viens de certifier la facture auprès de la DGI.',
      "Nous avons envoyé la relance au client hier.",
      "J'ai bien émis la facture n° VE-2026-0042.",
      "J'ai donc généré les trois échéances dues.",
      "C'est fait.",
      'Opération effectuée.',
    ];
    let detectees = 0;
    for (const t of fausses) if (annonceUneMutation(t)) detectees++;
    check('toutes les annonces de succès sont détectées', detectees === fausses.length,
      `(${detectees}/${fausses.length})`);

    // Tournures légitimes : elles ne doivent PAS être rectifiées, sinon la garde
    // deviendrait du bruit et on finirait par l'ignorer.
    const legitimes = [
      'Tes cinq écritures sont comptabilisées au grand livre : le solde du 601 est de 300 000 XOF.',
      'Tu peux comptabiliser cette écriture dans l’onglet Saisie.',
      'La facture sera émise quand tu cliqueras sur « Émettre ».',
      "J'ai consulté la balance : le résultat est de −4 702 454 F CFA.",
      "J'ai vérifié les contrôles de cohérence, deux points méritent attention.",
      "J'ai analysé tes créances : 1 500 000 F CFA au-delà de 90 jours.",
      'Ces trois factures ont été émises le mois dernier.',
      'Je te propose de comptabiliser la dotation aux amortissements.',
    ];
    const faussesAlertes = legitimes.filter((t) => annonceUneMutation(t));
    check('aucune fausse alerte sur les tournures légitimes', faussesAlertes.length === 0,
      faussesAlertes.length ? `(${faussesAlertes[0].slice(0, 55)})` : '(8 tournures)');

    // « valider » est volontairement hors périmètre : en français il signifie
    // aussi bien contrôler que comptabiliser, et l'AQM est un contrôle.
    check('« j\'ai validé » n\'est pas traité comme une mutation',
      annonceUneMutation("J'ai validé la facture : verdict PASS, 100/100.") === null);
  }


  console.log('\n=== N05 — Lexa travaille sur l\'exercice qui couvre la date du jour ===');
  {
    const user = randomUUID();
    const cab = await withUser(user, (c) => acc.onboardCabinet(c, user, 'Cabinet Exercices', 'CI'));
    const d = await withUser(user, (c) => acc.openDossier(c, {
      cabinetId: cab, raisonSociale: 'Deux Exercices SARL', country: 'CI',
    }));

    // Le cas exact de l'audit : 2025 jamais clôturé, 2026 ouvert et courant.
    // listFiscalYears trie par date CROISSANTE, et l'ancien code prenait le
    // premier exercice non clôturé — donc 2025.
    const fy2025 = await withUser(user, (c) =>
      acc.createFiscalYear(c, d.id, '2025', '2025-01-01', '2025-12-31'));
    const fy2026 = await withUser(user, (c) =>
      acc.createFiscalYear(c, d.id, '2026', '2026-01-01', '2026-12-31'));

    const ctx = await withUser(user, (c) => dossierContext(c, d.id));
    check('Lexa retient 2026 (exercice couvrant le jour), pas 2025', ctx.fyId === fy2026,
      ctx.fyId === fy2025 ? '(elle a repris 2025 — le défaut N05 est revenu)' : `(fyId=${ctx.fyId})`);
    check('le contexte nomme l\'exercice de travail', /Exercice de travail : « 2026 »/.test(ctx.text));
    check('le contexte signale l\'autre exercice', /« 2025 »/.test(ctx.text),
      'pour que Lexa puisse refuser une question hors périmètre au lieu de répondre à côté');
    check('le contexte interdit d\'extrapoler d\'un exercice à l\'autre',
      /n'extrapole aucun chiffre/.test(ctx.text));

    // Un exercice clôturé ne doit pas redevenir l'exercice de travail.
    await admin.query("update fiscal_years set status='closed' where id=$1", [fy2026]);
    const ctx2 = await withUser(user, (c) => dossierContext(c, d.id));
    check('exercice courant clôturé : Lexa le garde (il couvre toujours le jour)',
      ctx2.fyId === fy2026, `(fyId=${ctx2.fyId})`);

    // Et sans exercice couvrant le jour, on retient le plus RÉCENT non clôturé,
    // jamais le plus ancien.
    const d2 = await withUser(user, (c) => acc.openDossier(c, {
      cabinetId: cab, raisonSociale: 'Exercices Passes SARL', country: 'CI',
    }));
    const vieux = await withUser(user, (c) =>
      acc.createFiscalYear(c, d2.id, '2023', '2023-01-01', '2023-12-31'));
    const recent = await withUser(user, (c) =>
      acc.createFiscalYear(c, d2.id, '2024', '2024-01-01', '2024-12-31'));
    const ctx3 = await withUser(user, (c) => dossierContext(c, d2.id));
    check('aucun exercice ne couvre le jour : on prend le plus RÉCENT', ctx3.fyId === recent,
      ctx3.fyId === vieux ? '(le plus ancien a été repris — défaut N05)' : `(fyId=${ctx3.fyId})`);
  }

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await admin.end().catch(() => {});
  await closePool();
}

main().catch(async (e) => {
  console.error('ERREUR', e);
  process.exitCode = 1;
  await admin.end().catch(() => {});
  await closePool().catch(() => {});
});
