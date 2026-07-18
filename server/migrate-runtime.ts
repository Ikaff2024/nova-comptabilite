import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { pool } from './db.js';

// ============================================================================
// Application des migrations AU DÉMARRAGE DU SERVEUR (in-process), via le pool
// de l'application — donc exactement la même base que celle qu'interroge l'API,
// et QUEL QUE SOIT la commande de lancement (utile si l'hébergeur override le
// CMD du conteneur). Best-effort : ne fait jamais échouer le démarrage ; une
// migration en erreur est journalisée et ignorée. Suivi dans _migrations.
// ============================================================================

function migrationsDir(): string | null {
  for (const p of [path.resolve('supabase/migrations'), path.resolve(process.cwd(), 'supabase/migrations')]) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

export async function applyPendingMigrations(): Promise<{ applied: number; skipped: number } | null> {
  const dir = migrationsDir();
  if (!dir) { console.warn('[migrate] dossier supabase/migrations introuvable — ignoré.'); return null; }

  // Les migrations (DDL) requièrent un rôle avec droits sur le schéma. Si
  // MIGRATION_DATABASE_URL est défini (rôle owner/admin), on l'utilise via un pool
  // dédié ; sinon on retombe sur le pool applicatif (rôle restreint, sans DDL).
  const adminUrl = process.env.MIGRATION_DATABASE_URL;
  let ownPool: pg.Pool | null = null;
  let client;
  try {
    if (adminUrl) {
      const needsSsl = /neon\.tech|sslmode=require|render\.com|supabase\.co/.test(adminUrl) || process.env.PGSSL === 'require';
      ownPool = new pg.Pool({ connectionString: adminUrl, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
      client = await ownPool.connect();
      console.log('[migrate] connexion via MIGRATION_DATABASE_URL (rôle admin).');
    } else {
      client = await pool.connect();
    }
  }
  catch (e: any) { console.warn('[migrate] connexion impossible, migrations ignorées :', e.message); if (ownPool) await ownPool.end().catch(() => {}); return null; }
  try {
    await client.query('create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())');
    const { rows } = await client.query('select name from _migrations');
    const done = new Set(rows.map((r: any) => r.name));
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
        console.log(`[migrate] OK ${f}`);
        applied++;
      } catch (e: any) {
        try { await client.query('rollback'); } catch { /* ignore */ }
        console.warn(`[migrate] IGNORÉ ${f} : ${e.message}`);
        skipped++;
      }
    }
    if (applied || skipped) console.log(`[migrate] ${applied} appliquée(s), ${skipped} ignorée(s).`);
    return { applied, skipped };
  } catch (e: any) {
    console.warn('[migrate] erreur globale ignorée :', e.message);
    return null;
  } finally {
    try { client.release(); } catch { /* ignore */ }
    if (ownPool) await ownPool.end().catch(() => {});
  }
}
