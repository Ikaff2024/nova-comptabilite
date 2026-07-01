// Applique les migrations SQL (supabase/migrations/*.sql) dans l'ordre, via pg.
// Portable : local, CI, Neon (SSL auto). Suit les migrations appliquées dans _migrations.
//   Usage : DATABASE_URL=postgres://... node scripts/migrate.mjs
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL requis'); process.exit(1); }

const needsSsl = /neon\.tech|sslmode=require|render\.com|supabase\.co/.test(url) || process.env.PGSSL === 'require';
const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });

const dir = path.resolve('supabase/migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = await pool.connect();
try {
  await client.query('create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())');
  const { rows } = await client.query('select name from _migrations');
  const done = new Set(rows.map((r) => r.name));

  let applied = 0;
  for (const f of files) {
    if (done.has(f)) { console.log(`= déjà appliqué : ${f}`); continue; }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    process.stdout.write(`→ ${f} … `);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into _migrations(name) values ($1)', [f]);
      await client.query('commit');
      console.log('OK');
      applied++;
    } catch (e) {
      await client.query('rollback');
      console.error(`\nÉCHEC sur ${f} :`, e.message);
      process.exit(1);
    }
  }
  console.log(`\n${applied} migration(s) appliquée(s), ${files.length - applied} déjà en base.`);
} finally {
  client.release();
  await pool.end();
}
