import { randomUUID } from 'node:crypto';
import { withUser, closePool } from './db.js';
import * as acc from './domain/accounting.js';

// ============================================================================
// SÉCURITÉ — autorisation de la suppression de dossier.
//
// Régression de la faille 0077 : la garde de dossier_delete laissait passer un
// utilisateur d'un AUTRE cabinet (v_caller NULL → logique ternaire → exception
// non levée). Tout authentifié pouvait supprimer n'importe quel dossier.
//
//   npm run test:securite   (nécessite DATABASE_URL)
// ============================================================================

let ok = 0, ko = 0;
const check = (l: string, c: boolean, d = '') => { c ? (ok++, console.log(`  PASS ${l} ${d}`)) : (ko++, console.error(`  FAIL ${l} ${d}`)); };

async function main() {
  const uOwner = randomUUID(), uOutsider = randomUUID(), uCollab = randomUUID();

  const cabA = await withUser(uOwner, (c) => acc.onboardCabinet(c, uOwner, 'Cabinet A', 'CI'));
  const dA = await withUser(uOwner, (c) => acc.openDossier(c, { cabinetId: cabA, raisonSociale: 'Cible SARL', country: 'CI' }));
  await withUser(uOutsider, (c) => acc.onboardCabinet(c, uOutsider, 'Cabinet Attaquant', 'SN'));

  // 1) Un étranger (autre cabinet) NE PEUT PAS supprimer le dossier de A.
  let bloque = false; let msg = '';
  try { await withUser(uOutsider, (c) => acc.deleteDossier(c, dA.id)); }
  catch (e: any) { bloque = true; msg = e.message; }
  const toujoursLa = await withUser(uOwner, (c) => acc.listDossiers(c));
  check('un étranger ne peut pas supprimer le dossier d\'un autre cabinet', bloque, `(${msg.slice(0, 55)})`);
  check('et le dossier est toujours là', toujoursLa.some((d: any) => d.id === dA.id));

  // 2) Un membre de rang insuffisant (collaborateur) non plus.
  await withUser(uOwner, (c) => c.query(
    `insert into cabinet_members(cabinet_id, user_id, role) values ($1,$2,'collaborateur')`, [cabA, uCollab]));
  let bloqueCollab = false;
  try { await withUser(uCollab, (c) => acc.deleteDossier(c, dA.id)); } catch { bloqueCollab = true; }
  check('un collaborateur du cabinet ne peut pas supprimer', bloqueCollab);

  // 3) Le propriétaire légitime, LUI, peut toujours supprimer.
  let supprOwner = false;
  try { await withUser(uOwner, (c) => acc.deleteDossier(c, dA.id)); supprOwner = true; } catch { /* */ }
  const apres = await withUser(uOwner, (c) => acc.listDossiers(c));
  check('le propriétaire supprime toujours son dossier', supprOwner && !apres.some((d: any) => d.id === dA.id));

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}
main().catch(async (e) => { console.error('ERREUR', e); process.exitCode = 1; await closePool(); });
