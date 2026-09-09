// =============================================================================
// Nova Comptabilité — application des migrations. AUTORITÉ UNIQUE.
// =============================================================================
// Applique supabase/migrations/*.sql dans l'ordre lexicographique, une migration
// par transaction, en suivant l'état dans la table _migrations.
//
// FAIL-CLOSED. Une migration en erreur arrête le processus avec un code de
// sortie non nul. C'est délibéré et non négociable : pour une comptabilité, un
// schéma partiellement appliqué est pire qu'un service indisponible. Un service
// arrêté se voit et se répare ; un verrou d'immuabilité absent ne se voit pas.
//
// Ce script remplace scripts/migrate-boot.mjs, qui appliquait les mêmes
// migrations en « best-effort » (chaque erreur journalisée puis ignorée, sortie
// toujours 0) et laissait donc démarrer l'API sur un schéma incomplet — défaut
// NOVA-P1-08 de la revue CTO 001. Il remplace aussi la migration in-process de
// server/migrate-runtime.ts, qui s'exécutait APRÈS l'ouverture du port.
//
//   Usage :  npm run migrate
//   Env   :  MIGRATION_DATABASE_URL (rôle propriétaire/admin, DDL) — recommandé
//            DATABASE_URL           (repli ; le rôle applicatif n'a pas le DDL)
//            PGSSL=require          (force SSL si l'URL ne le trahit pas)
//
// Le DDL exige des droits que le rôle applicatif n'a pas (et ne doit pas
// avoir, cf. NOVA-P0-02). En production, poser MIGRATION_DATABASE_URL sur le
// rôle propriétaire et DATABASE_URL sur nova_app.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] MIGRATION_DATABASE_URL ou DATABASE_URL requis.');
  process.exit(1);
}
console.log(`[migrate] connexion via ${process.env.MIGRATION_DATABASE_URL ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL'}.`);

const needsSsl = /neon\.tech|sslmode=require|render\.com|supabase\.co/.test(url)
  || process.env.PGSSL === 'require';

// Au démarrage d'un conteneur, le réseau interne de l'hébergeur n'est pas
// toujours prêt à l'instant précis où le processus démarre. On réessaie la
// CONNEXION — jamais une migration en erreur, qui reste fatale.
async function connectWithRetry(pool, attempts = 6, delayMs = 2500) {
  for (let i = 1; i <= attempts; i++) {
    try { return await pool.connect(); }
    catch (e) {
      console.warn(`[migrate] connexion tentative ${i}/${attempts} échouée : ${e.message}`);
      if (i === attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const dir = path.resolve('supabase/migrations');
if (!fs.existsSync(dir)) {
  console.error(`[migrate] dossier introuvable : ${dir}`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
let client;
try {
  client = await connectWithRetry(pool);
} catch (e) {
  console.error(`[migrate] base injoignable : ${e.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
}

let code = 0;
try {
  // Lecture d'abord, écriture seulement si nécessaire.
  //
  // Le rôle applicatif n'a PAS les droits DDL (et ne doit pas les avoir, cf.
  // NOVA-P0-02) : un `create table if not exists` échoue chez lui même quand la
  // table existe déjà. Or ce script est désormais enchaîné par `&&` avant le
  // démarrage. S'il exigeait le DDL en toutes circonstances, tout déploiement
  // dont le schéma est DÉJÀ à jour mais qui ne pose que DATABASE_URL cesserait
  // de redémarrer — une panne totale pour une base parfaitement saine.
  //
  // On ne réclame donc des droits d'écriture que s'il y a réellement quelque
  // chose à appliquer.
  let done = new Set();
  try {
    const { rows } = await client.query('select name from _migrations');
    done = new Set(rows.map((r) => r.name));
  } catch (e) {
    if (e.code !== '42P01') throw e; // 42P01 = relation inexistante
    console.log('[migrate] table _migrations absente : première application.');
    await client.query(
      'create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())');
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !done.has(f));

  if (pending.length === 0) {
    console.log(`[migrate] schéma déjà à jour (${files.length} migration(s) en base). Rien à appliquer.`);
    client.release();
    await pool.end().catch(() => {});
    process.exit(0);
  }

  if (!process.env.MIGRATION_DATABASE_URL) {
    console.warn(`[migrate] ${pending.length} migration(s) en attente et MIGRATION_DATABASE_URL non défini : `
      + "tentative avec DATABASE_URL, qui n'a normalement pas les droits DDL.");
  }

  let applied = 0;
  for (const f of pending) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    process.stdout.write(`[migrate] → ${f} … `);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into _migrations(name) values ($1)', [f]);
      await client.query('commit');
      console.log('OK');
      applied++;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      console.error(`ÉCHEC\n[migrate] ${f} : ${e.message}`);
      console.error('[migrate] Migration interrompue. Le schéma est incomplet : '
        + "l'application ne doit pas démarrer dans cet état. Corrigez la migration, "
        + 'puis relancez `npm run migrate`.');
      code = 1;
      break;
    }
  }
  if (code === 0) {
    console.log(`[migrate] ${applied} appliquée(s), ${files.length - applied} déjà en base.`);
  }
} catch (e) {
  console.error(`[migrate] erreur : ${e.message}`);
  code = 1;
} finally {
  client.release();
  await pool.end().catch(() => {});
}

process.exit(code);
