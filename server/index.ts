import './env.js'; // doit rester en premier (peuple process.env avant db/ai)
import { createApi } from './api.js';
import { assertAuthConfig } from './auth.js';
import { assertStartupReady } from './startup.js';
import { runDailyPush } from './ai/watchdog.js';
import { startNightlyScheduler } from './nightly-runner.js';

// Railway/Render fournissent PORT ; fallback local API_PORT puis 4000.
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
assertAuthConfig(); // refuse de démarrer en prod si le secret JWT est faible

function demarrer(): void {
  const app = createApi();

  app.listen(port, () => {
    console.log(`Nova Comptabilité API → port ${port}`);
    // La veille lit une fonction créée par migration ; à ce stade les contrôles
    // de démarrage ont confirmé que le schéma attendu est bien en base.
    startNightlyScheduler();
  });

  // Agent nocturne : pousse le digest quotidien une fois par jour (après 6h UTC).
  // No-op tant que WhatsApp n'est pas configuré. Un cron externe peut aussi
  // appeler POST /api/cron/watchdog (header x-cron-secret) pour un horaire précis.
  let lastDigestDay = '';
  setInterval(async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() >= 6 && lastDigestDay !== day) {
      lastDigestDay = day;
      try { const r = await runDailyPush(); if (r.sent) console.log(`Digest quotidien Lexa : ${r.sent}/${r.links} envoi(s).`); } catch { /* best-effort */ }
    }
  }, 60 * 60 * 1000);
}

// ── migrate → verify → start ────────────────────────────────────────────────
//
// Les migrations sont appliquées AVANT ce processus, par une autorité unique et
// stricte (scripts/migrate.mjs, enchaînée par `&&` dans le Dockerfile). Nova ne
// migre plus lui-même : le faire après app.listen(), comme auparavant, revenait
// à servir des requêtes pendant que le schéma changeait — et à continuer quand
// la migration échouait (NOVA-P1-08).
//
// Ce qui reste ici est la VÉRIFICATION : connexion, schéma attendu, invariants
// de sécurité, rôle PostgreSQL. Elle passe avant l'ouverture du port, parce
// qu'une seule requête servie sur un schéma incomplet suffit à produire une
// écriture fausse ou à exposer un cabinet à un autre.
assertStartupReady()
  .then(demarrer)
  .catch((e) => {
    console.error(`\n[startup] ${e?.message ?? e}\n`);
    process.exit(1);
  });
