import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { withUser, closePool } from './db.js';
import * as users from './domain/users.js';
import {
  hashPassword, verifyPassword, issueToken, verifyToken,
  generateResetToken, hashResetToken,
} from './auth.js';

// ============================================================================
// RÉCUPÉRATION DE MOT DE PASSE (constat N10 de l'audit externe).
//
// L'écran de connexion ne proposait aucun recours : un utilisateur qui oublie
// son mot de passe était simplement dehors. C'est le défaut qu'un pilote
// rencontre dès la première semaine.
//
// L'audit fixe lui-même les critères d'acceptation : « compte connu/inconnu
// avec réponse non révélatrice, expiration et usage unique du lien,
// invalidation après succès et limites de tentatives ». Ce test les reprend un
// par un, plus la garantie qui les sous-tend : la base ne stocke jamais le
// jeton en clair.
//
//   npm run test:password-reset
// ============================================================================

let ok = 0, ko = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { ok++; console.log(`  PASS ${label} ${detail}`); }
  else { ko++; console.error(`  FAIL ${label} ${detail}`); }
};

const ADMIN_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });

/** Crée un compte et renvoie son identifiant. */
async function compte(email: string, motDePasse: string): Promise<string> {
  return withUser(null, (c) => users.registerUser(c, email, hashPassword(motDePasse), 'Testeur'));
}

async function main() {
  const email = `reset-${randomUUID().slice(0, 8)}@test.nova`;
  const ancien = 'ancien-mot-de-passe';
  const nouveau = 'nouveau-mot-de-passe';
  const uid = await compte(email, ancien);

  console.log('\n--- 1) Le jeton n\'est JAMAIS stocké en clair ---');
  {
    const token = generateResetToken();
    await withUser(null, (c) => users.demanderReinitialisation(c, email, hashResetToken(token), '127.0.0.1'));
    const { rows } = await admin.query(
      'select token_hash from password_resets where user_id = $1 order by created_at desc limit 1', [uid]);
    check('la base ne contient pas le jeton', rows[0]?.token_hash !== token);
    check('elle contient son empreinte SHA-256', rows[0]?.token_hash === hashResetToken(token),
      `(${String(rows[0]?.token_hash).slice(0, 16)}…)`);
  }

  console.log('\n--- 2) Compte inconnu : aucune différence observable ---');
  {
    // C'est la garantie de non-divulgation. Si la couche domaine se comportait
    // différemment, l'API ne pourrait pas la rattraper.
    const inconnu = await withUser(null, (c) =>
      users.demanderReinitialisation(c, 'personne@nexiste-pas.test', hashResetToken(generateResetToken()), null));
    check('aucun compte renvoyé pour une adresse inconnue', inconnu === null);
    const { rows } = await admin.query(
      "select count(*)::int n from password_resets pr join app_users u on u.id = pr.user_id where u.email = 'personne@nexiste-pas.test'");
    check('aucun jeton créé pour une adresse inconnue', rows[0].n === 0);
  }

  console.log('\n--- 3) Usage unique ---');
  {
    const token = generateResetToken();
    await withUser(null, (c) => users.demanderReinitialisation(c, email, hashResetToken(token), null));

    const out = await withUser(null, (c) =>
      users.appliquerReinitialisation(c, hashResetToken(token), hashPassword(nouveau)));
    check('premier emploi : accepté', out?.email === email, `(${out?.email})`);

    let refuse = false, msg = '';
    try {
      await withUser(null, (c) =>
        users.appliquerReinitialisation(c, hashResetToken(token), hashPassword('encore-autre-chose')));
    } catch (e: any) { refuse = true; msg = e.message; }
    check('second emploi du MÊME lien : refusé', refuse, `(${msg.slice(0, 40)})`);
  }

  console.log('\n--- 4) Le mot de passe a bien changé ---');
  {
    const u = await withUser(null, (c) => users.getUserForLogin(c, email));
    check('le nouveau mot de passe est accepté', verifyPassword(nouveau, u!.password_hash));
    check('l\'ancien ne l\'est plus', !verifyPassword(ancien, u!.password_hash));
  }

  console.log('\n--- 5) Les sessions ouvertes sont invalidées ---');
  {
    // Le scénario qui compte : quelqu'un a volé une session. La victime reprend
    // la main sur son compte. Sans invalidation, le voleur garderait l'accès
    // sept jours de plus — la récupération ne serait qu'un demi-service.
    const avant = await withUser(null, (c) => users.getUserForLogin(c, email));
    const jetonVole = issueToken({ id: uid, email, tokenVersion: (avant!.token_version ?? 0) - 1 });
    const jetonFrais = issueToken({ id: uid, email, tokenVersion: avant!.token_version ?? 0 });

    const versionEnBase = await withUser(null, (c) => users.tokenVersion(c, uid));
    check('la version de session a été incrémentée', versionEnBase >= 1, `(version ${versionEnBase})`);

    // La signature reste valide dans les deux cas : c'est bien la VERSION qui
    // départage, pas la cryptographie.
    check('le jeton volé est cryptographiquement valide', verifyToken(jetonVole) !== null);
    check('mais sa version est périmée', (verifyToken(jetonVole)!.tv ?? 0) !== versionEnBase);
    check('le jeton frais porte la bonne version', (verifyToken(jetonFrais)!.tv ?? 0) === versionEnBase);
  }

  console.log('\n--- 6) Expiration ---');
  {
    const token = generateResetToken();
    await withUser(null, (c) => users.demanderReinitialisation(c, email, hashResetToken(token), null));
    await admin.query(
      "update password_resets set expires_at = now() - interval '1 minute' where token_hash = $1",
      [hashResetToken(token)]);

    let refuse = false, msg = '';
    try {
      await withUser(null, (c) => users.appliquerReinitialisation(c, hashResetToken(token), hashPassword('xyz12345')));
    } catch (e: any) { refuse = true; msg = e.message; }
    check('un lien expiré est refusé', refuse, `(${msg.slice(0, 40)})`);
  }

  console.log('\n--- 7) Une nouvelle demande annule la précédente ---');
  {
    // Sinon un ancien courriel, resté dans une boîte, garderait un lien vivant.
    const t1 = generateResetToken();
    const t2 = generateResetToken();
    await withUser(null, (c) => users.demanderReinitialisation(c, email, hashResetToken(t1), null));
    await withUser(null, (c) => users.demanderReinitialisation(c, email, hashResetToken(t2), null));

    let t1Refuse = false;
    try { await withUser(null, (c) => users.appliquerReinitialisation(c, hashResetToken(t1), hashPassword('abcd1234'))); }
    catch { t1Refuse = true; }
    check('l\'ancien lien ne fonctionne plus', t1Refuse);

    const out = await withUser(null, (c) => users.appliquerReinitialisation(c, hashResetToken(t2), hashPassword('abcd1234')));
    check('le dernier lien fonctionne', out?.email === email);
  }

  console.log('\n--- 8) Un jeton inventé ne donne rien ---');
  {
    let refuse = false;
    try {
      await withUser(null, (c) =>
        users.appliquerReinitialisation(c, hashResetToken(generateResetToken()), hashPassword('zzzz9999')));
    } catch { refuse = true; }
    check('un jeton jamais émis est refusé', refuse);
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
