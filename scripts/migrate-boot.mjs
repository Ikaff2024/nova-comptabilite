// Migration « best-effort » exécutée au DÉMARRAGE du conteneur.
// Applique les migrations en attente (suivies dans _migrations), mais ne fait
// JAMAIS échouer le démarrage : une migration en erreur est journalisée et
// ignorée (rollback), puis on passe à la suivante. Ainsi l'API démarre
// toujours, et les migrations applicables (nouvelles colonnes/tables) passent.
// Pour une application stricte (CI/local), utiliser scripts/migrate.mjs.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// Les migrations (DDL) requièrent un rôle avec droits de création de schéma.
// Si MIGRATION_DATABASE_URL est défini (rôle owner/admin), on l'utilise pour les
// migrations ; sinon on retombe sur DATABASE_URL (rôle applicatif restreint, qui
// n'a en général PAS les droits DDL → migrations « ignorées », à appliquer à la main).
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.warn('[migrate-boot] Aucune URL de base — démarrage sans migration.'); process.exit(0); }
console.log(`[migrate-boot] connexion via ${process.env.MIGRATION_DATABASE_URL ? 'MIGRATION_DATABASE_URL (admin)' : 'DATABASE_URL (runtime)'}.`);

const needsSsl = /neon\.tech|sslmode=require|render\.com|supabase\.co/.test(url) || process.env.PGSSL === 'require';

// La base peut ne pas être joignable à l'instant précis du démarrage du
// conteneur (réseau interne pas encore prêt). On réessaie la connexion.
async function connectWithRetry(pool, attempts = 6, delayMs = 2500) {
  for (let i = 1; i <= attempts; i++) {
    try { return await pool.connect(); }
    catch (e) {
      console.warn(`[migrate-boot] connexion tentative ${i}/${attempts} échouée : ${e.message}`);
      if (i === attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function run() {
  const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
  const client = await connectWithRetry(pool);
  try {
    await client.query('create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())');
    const { rows } = await client.query('select name from _migrations');
    const done = new Set(rows.map((r) => r.name));
    const dir = path.resolve('supabase/migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    let applied = 0, skipped = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into _migrations(name) values ($1) on conflict do nothing', [f]);
        await client.query('commit');
        console.log(`[migrate-boot] OK ${f}`);
        applied++;
      } catch (e) {
        try { await client.query('rollback'); } catch { /* ignore */ }
        console.warn(`[migrate-boot] IGNORÉ ${f} : ${e.message}`);
        skipped++;
      }
    }
    console.log(`[migrate-boot] ${applied} appliquée(s), ${skipped} ignorée(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

// Ne jamais bloquer le démarrage, quoi qu'il arrive.
run().catch((e) => console.warn('[migrate-boot] erreur globale ignorée :', e.message)).finally(() => process.exit(0));
