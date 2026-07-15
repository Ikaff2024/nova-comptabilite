// Migration « best-effort » exécutée au DÉMARRAGE du conteneur.
// Applique les migrations en attente (suivies dans _migrations), mais ne fait
// JAMAIS échouer le démarrage : une migration en erreur est journalisée et
// ignorée (rollback), puis on passe à la suivante. Ainsi l'API démarre
// toujours, et les migrations applicables (nouvelles colonnes/tables) passent.
// Pour une application stricte (CI/local), utiliser scripts/migrate.mjs.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.warn('[migrate-boot] DATABASE_URL absent — démarrage sans migration.'); process.exit(0); }

const needsSsl = /neon\.tech|sslmode=require|render\.com|supabase\.co/.test(url) || process.env.PGSSL === 'require';

async function run() {
  const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
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
