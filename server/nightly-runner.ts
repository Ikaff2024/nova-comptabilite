import { pool, withUser } from './db.js';
import { runForDossier } from './domain/nightly.js';

// ============================================================================
// Planificateur de la veille nocturne. Tourne dans le process de l'API (une
// seule instance en production) et se déclenche une fois par jour à l'heure
// configurée (NIGHTLY_HOUR, UTC, défaut 6h).
//
// Point clé : le job n'a PAS d'utilisateur. Sous RLS, il ne verrait donc aucun
// dossier (fail-closed, cf. app_dossier_ids). On récupère les cibles via la
// fonction SECURITY DEFINER `nightly_targets()`, puis on exécute le calcul de
// chaque dossier AU NOM de son propriétaire (withUser) — la RLS s'applique
// alors normalement, on ne la contourne pas.
// ============================================================================

const HOUR = Math.min(23, Math.max(0, Number(process.env.NIGHTLY_HOUR ?? 6)));
const CHECK_MS = 15 * 60 * 1000;      // on vérifie toutes les 15 min
let lastRunDay: string | null = null;  // 'YYYY-MM-DD' de la dernière exécution

export async function runNightlyOnce(): Promise<{ dossiers: number; errors: number }> {
  let targets: { dossier_id: string; user_id: string; email: string | null }[] = [];
  try {
    const { rows } = await pool.query('select * from nightly_targets()');
    targets = rows as any[];
  } catch (e: any) {
    console.warn('[veille] cibles indisponibles (migration en attente ?) :', e.message);
    return { dossiers: 0, errors: 0 };
  }

  let done = 0, errors = 0;
  for (const t of targets) {
    try {
      await withUser(t.user_id, (c) => runForDossier(c, t.dossier_id, { notifyTo: t.email ?? undefined }));
      done++;
    } catch (e: any) {
      errors++;
      console.warn(`[veille] dossier ${t.dossier_id} :`, e.message);
    }
  }
  if (done || errors) console.log(`[veille] ${done} dossier(s) analysé(s), ${errors} en erreur.`);
  return { dossiers: done, errors };
}

export function startNightlyScheduler(): void {
  const tick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== HOUR || lastRunDay === day) return;
    lastRunDay = day;                       // marqué AVANT : pas de double run
    try { await runNightlyOnce(); } catch (e: any) { console.warn('[veille] échec :', e.message); }
  };
  setInterval(tick, CHECK_MS).unref?.();
  console.log(`[veille] planificateur actif (chaque jour à ${HOUR}h UTC).`);
}
