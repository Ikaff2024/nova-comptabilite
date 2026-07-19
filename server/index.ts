import './env.js'; // doit rester en premier (peuple process.env avant db/ai)
import { createApi } from './api.js';
import { runDailyPush } from './ai/watchdog.js';
import { applyPendingMigrations } from './migrate-runtime.js';
import { startNightlyScheduler } from './nightly-runner.js';

// Railway/Render fournissent PORT ; fallback local API_PORT puis 4000.
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
const app = createApi();

app.listen(port, () => {
  console.log(`Nova Comptabilité API → port ${port}`);
  // Applique les migrations en attente in-process (même base que l'API, quelle
  // que soit la commande de lancement). Best-effort : ne bloque pas le service.
  applyPendingMigrations()
    .catch((e) => console.warn('[migrate] non appliqué :', e?.message))
    // La veille lit une fonction créée par migration : on la démarre après.
    .finally(() => startNightlyScheduler());
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
