import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

// ============================================================================
// DÉPLOIEMENT — migrate → verify → start, fail-closed (NOVA-P1-08).
//
// Avant, une migration en échec produisait un avertissement et l'API démarrait
// quand même, sur un schéma incomplet. Après la vague P0, cela voulait dire
// qu'une instance pouvait tourner sans verrou d'immuabilité et sans FORCE ROW
// LEVEL SECURITY — donc en exposant les cabinets les uns aux autres.
//
// Ce test LANCE RÉELLEMENT le processus (`tsx server/index.ts`) contre des
// bases manipulées, et regarde s'il ouvre son port ou s'il meurt. Vérifier la
// logique de `runStartupChecks()` en appelant la fonction ne prouverait pas que
// le port reste fermé : c'est le comportement du processus qui compte.
//
//   npm run test:startup
//
// Prérequis : MIGRATION_DATABASE_URL (rôle admin, pour fabriquer les bases de
// scénario) et DATABASE_URL (rôle applicatif). Les bases de test sont créées et
// détruites par le test lui-même.
// ============================================================================

let ok = 0, ko = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { ok++; console.log(`  PASS ${label} ${detail}`); }
  else { ko++; console.error(`  FAIL ${label} ${detail}`); }
};

const ADMIN_URL = process.env.MIGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/nova';
const APP_URL = process.env.DATABASE_URL ?? ADMIN_URL;

const avecBase = (url: string, base: string) => {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
};
const avecRole = (url: string, role: string, mdp: string) => {
  const u = new URL(url);
  u.username = role; u.password = mdp;
  return u.toString();
};

/**
 * Lance le vrai processus API et observe l'issue.
 * Retourne 'demarre' si le port s'ouvre, 'refuse' si le processus meurt.
 */
function lancerApi(env: Record<string, string>, timeoutMs = 25000): Promise<{
  issue: 'demarre' | 'refuse'; code: number | null; sortie: string;
}> {
  return new Promise((resolve) => {
    // Pas de shell intermédiaire : sur Windows, kill() ne traverse pas le shell
    // et le processus resterait vivant, faisant traîner le test indéfiniment.
    const p = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, ...env },
    });
    let sortie = '';
    let fini = false;
    const terminer = (issue: 'demarre' | 'refuse', code: number | null) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      try { p.kill(); } catch { /* déjà mort */ }
      resolve({ issue, code, sortie });
    };
    const lire = (d: Buffer) => {
      sortie += d.toString();
      // Le port est ouvert : le démarrage a réussi.
      if (/Nova Comptabilité API → port/.test(sortie)) terminer('demarre', null);
    };
    p.stdout.on('data', lire);
    p.stderr.on('data', lire);
    p.on('exit', (code) => terminer('refuse', code));
    p.on('error', () => terminer('refuse', -1));
    const minuteur = setTimeout(() => terminer('refuse', null), timeoutMs);
  });
}

async function sql(url: string, requete: string): Promise<any[]> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try { return (await pool.query(requete)).rows; }
  finally { await pool.end().catch(() => {}); }
}

// CREATE DATABASE ... TEMPLATE exige qu'aucune session ne soit connectée à la
// source. On passe donc par la base de maintenance 'postgres', jamais par la
// base applicative elle-même.
const MAINTENANCE_URL = avecBase(ADMIN_URL, 'postgres');

/** Crée une base de scénario par clonage de la base migrée de référence. */
async function creerBase(nom: string, source: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: MAINTENANCE_URL, max: 1 });
  try {
    await admin.query(`drop database if exists ${nom}`);
    await admin.query(`create database ${nom} template ${source}`);
  } finally { await admin.end().catch(() => {}); }
}

async function supprimerBase(nom: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: MAINTENANCE_URL, max: 1 });
  try { await admin.query(`drop database if exists ${nom}`); }
  catch { /* best-effort */ }
  finally { await admin.end().catch(() => {}); }
}

// Un port différent à chaque lancement : ce test démarre de vrais serveurs, et
// un processus resté vivant d'une exécution précédente ferait échouer le cas
// « l'API doit démarrer » pour une raison sans rapport avec ce qu'on teste.
let portSuivant = 4200 + Math.floor(Math.random() * 400);
const envProd = () => ({
  NODE_ENV: 'production',
  JWT_SECRET: 'test-startup-secret-suffisamment-long-32',
  PORT: String(portSuivant++),
});

async function main() {
  const baseSource = new URL(ADMIN_URL).pathname.replace(/^\//, '') || 'nova';
  const appRole = new URL(APP_URL).username;
  const appMdp = new URL(APP_URL).password;

  console.log('\n=== Cas 1 — base correcte et complète : l\'API DOIT démarrer ===');
  {
    const r = await lancerApi({ ...envProd(), DATABASE_URL: APP_URL });
    check('base complète : API démarre', r.issue === 'demarre',
      r.issue === 'demarre' ? '' : `(code ${r.code}) ${r.sortie.slice(-260)}`);
    check('les 4 contrôles sont annoncés OK',
      /MIGRATIONS_OK SCHEMA_VERSION_OK SECURITY_INVARIANTS_OK DATABASE_RUNTIME_ROLE_OK/.test(r.sortie));
  }

  console.log('\n=== Cas 1b — schéma à jour, rôle applicatif SANS droits DDL : migrate DOIT réussir ===');
  {
    // Le Dockerfile enchaîne `npm run migrate && npm run start`. Si migrate
    // exigeait le DDL en toutes circonstances, un déploiement dont le schéma est
    // déjà à jour mais qui ne pose que DATABASE_URL (rôle applicatif, sans DDL)
    // ne redémarrerait plus jamais. Ce cas verrouille ce comportement.
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const env = { ...process.env, DATABASE_URL: APP_URL };
      delete (env as Record<string, string | undefined>).MIGRATION_DATABASE_URL;
      const p = spawn(process.execPath, [path.resolve('scripts/migrate.mjs')], { env });
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { out += d.toString(); });
      p.on('exit', (code) => resolve({ code, out }));
    });
    check('schéma à jour + rôle sans DDL : migrate sort en 0', r.code === 0, `(code ${r.code}) ${r.out.slice(-160)}`);
    check('aucun DDL tenté quand il n\'y a rien à appliquer', /schéma déjà à jour/.test(r.out));
  }

  console.log('\n=== Cas 2 — migration volontairement cassée : migrate DOIT échouer ===');
  {
    const nom = 'nova_t_migbroken';
    await creerBase(nom, baseSource);
    const url = avecBase(ADMIN_URL, nom);

    // On exerce le VRAI script d'application des migrations, avec un dossier de
    // migrations contenant un fichier volontairement invalide. migrate.mjs
    // résout supabase/migrations depuis le répertoire courant, et importe pg
    // depuis sa propre position : on peut donc le lancer depuis un dossier
    // temporaire ne contenant que la migration cassée.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mig-'));
    fs.mkdirSync(path.join(tmp, 'supabase', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'supabase', 'migrations', '29990101000001_migration_cassee.sql'),
      'create table cassee_test(x int);\nselect cette_fonction_nexiste_pas();\n');

    const migrate = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [path.resolve('scripts/migrate.mjs')], {
        cwd: tmp,
        env: { ...process.env, MIGRATION_DATABASE_URL: url, DATABASE_URL: url },
      });
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { out += d.toString(); });
      p.on('exit', (code) => resolve({ code, out }));
    });
    check('migration invalide : migrate.mjs sort en code NON NUL', migrate.code === 1, `(code ${migrate.code})`);
    check('migrate.mjs dit que le schéma est incomplet', /schéma est incomplet/.test(migrate.out));
    check('la transaction est annulée (table non créée)',
      (await sql(url, "select to_regclass('public.cassee_test') is null as absente"))[0]?.absente === true);
    fs.rmSync(tmp, { recursive: true, force: true });

    // Et le corollaire : une migration restée en attente empêche l'API de démarrer.
    await sql(url, `delete from _migrations where name = (select max(name) from _migrations)`);
    const api = await lancerApi({ ...envProd(), DATABASE_URL: avecBase(avecRole(url, appRole, appMdp), nom) });
    check('migration en attente : API NE démarre PAS', api.issue === 'refuse', `(code ${api.code})`);
    check('le message nomme la cause', /migration\(s\) livrée\(s\) par le code mais ABSENTE/.test(api.sortie));
    await supprimerBase(nom);
  }

  console.log('\n=== Cas 3 — schéma incomplet (objet critique supprimé) : startup refusé ===');
  {
    const nom = 'nova_t_schemaincomplet';
    await creerBase(nom, baseSource);
    const url = avecBase(ADMIN_URL, nom);
    // Fonction critique retirée, migrations toutes marquées appliquées : c'est
    // le cas « la migration a tourné, puis quelqu'un a modifié la base ».
    await sql(url, 'drop function if exists dossier_role_for(uuid) cascade');
    const api = await lancerApi({ ...envProd(), DATABASE_URL: avecBase(avecRole(url, appRole, appMdp), nom) });
    check('fonction critique absente : API NE démarre PAS', api.issue === 'refuse', `(code ${api.code})`);
    check('le message nomme la fonction manquante', /dossier_role_for/.test(api.sortie));
    await supprimerBase(nom);
  }

  console.log('\n=== Cas 4 — base en retard sur le code (schéma N-1) : startup refusé ===');
  {
    const nom = 'nova_t_schemaancien';
    await creerBase(nom, baseSource);
    const url = avecBase(ADMIN_URL, nom);
    // La base « oublie » les trois migrations de la vague P0 : c'est exactement
    // « code en version N, base en version N-1 ».
    await sql(url, `delete from _migrations where name like '202609090000%'`);
    const api = await lancerApi({ ...envProd(), DATABASE_URL: avecBase(avecRole(url, appRole, appMdp), nom) });
    check('schéma en retard : API NE démarre PAS', api.issue === 'refuse', `(code ${api.code})`);
    check('le message dit d\'appliquer les migrations', /npm run migrate/.test(api.sortie));
    await supprimerBase(nom);
  }

  console.log('\n=== Cas 5 — rôle PostgreSQL dangereux : startup refusé ===');
  {
    // Rôle propriétaire + superutilisateur : celui que fournissent par défaut
    // la plupart des Postgres managés.
    const api = await lancerApi({ ...envProd(), DATABASE_URL: ADMIN_URL });
    check('rôle superutilisateur : API NE démarre PAS', api.issue === 'refuse', `(code ${api.code})`);
    check('le message nomme le motif', /SUPERUSER|BYPASSRLS|PROPRIÉTAIRE/.test(api.sortie));
  }

  console.log('\n=== Cas 6 — invariant P0 absent (verrou d\'immuabilité) : startup refusé ===');
  {
    const nom = 'nova_t_p0absent';
    await creerBase(nom, baseSource);
    const url = avecBase(ADMIN_URL, nom);
    // On remet le trigger dans son état d'AVANT la vague P0 : sans INSERT.
    // Les migrations restent marquées appliquées — c'est le scénario le plus
    // pernicieux, celui où _migrations dit « tout va bien » et où l'objet ment.
    await sql(url, `drop trigger if exists trg_protect_lines on entry_lines`);
    await sql(url, `create trigger trg_protect_lines before update or delete on entry_lines
                      for each row execute function protect_posted_lines()`);
    const api = await lancerApi({ ...envProd(), DATABASE_URL: avecBase(avecRole(url, appRole, appMdp), nom) });
    check('verrou d\'immuabilité incomplet : API NE démarre PAS', api.issue === 'refuse', `(code ${api.code})`);
    check('le message nomme NOVA-P0-03', /NOVA-P0-03|ne couvre pas l'INSERT/.test(api.sortie));

    // Même exercice sur l'isolation des vues (NOVA-P0-01).
    await sql(url, `alter view v_account_balances set (security_invoker = false)`);
    const api2 = await lancerApi({ ...envProd(), DATABASE_URL: avecBase(avecRole(url, appRole, appMdp), nom) });
    check('vue sans security_invoker : API NE démarre PAS', api2.issue === 'refuse', `(code ${api2.code})`);

    // Et sur FORCE ROW LEVEL SECURITY (NOVA-P0-02).
    await sql(url, `alter table entries no force row level security`);
    const api3 = await lancerApi({ ...envProd(), DATABASE_URL: avecBase(avecRole(url, appRole, appMdp), nom) });
    check('FORCE RLS levé sur entries : API NE démarre PAS', api3.issue === 'refuse', `(code ${api3.code})`);
    check('le message nomme NOVA-P0-02', /NOVA-P0-02|sans FORCE ROW LEVEL SECURITY/.test(api3.sortie));

    await supprimerBase(nom);
  }

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
}

main().catch((e) => { console.error('ERREUR', e); process.exitCode = 1; });
