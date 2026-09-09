import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db.js';
import { readDbIdentity, dangersFor } from './dbguard.js';

// ============================================================================
// VALIDATION DE DÉMARRAGE — mécanisme unique.
//
// Nova ne doit jamais servir une requête avant d'avoir prouvé que la base sur
// laquelle il s'appuie porte réellement les garanties que le code suppose.
// L'enchaînement est :
//
//     CONNEXION → SCHÉMA ATTENDU → INVARIANTS DE SÉCURITÉ → RÔLE RUNTIME → API
//
// et toute étape en échec est FAIL-CLOSED en production.
//
// ── Pourquoi ce module existe ───────────────────────────────────────────────
//
// Avant (défaut NOVA-P1-08 de la revue CTO 001), le démarrage était :
//
//     migrate-boot.mjs (chaque erreur ignorée, sortie toujours 0)
//       ;  ← point-virgule, pas &&  : l'étape suivante démarrait quoi qu'il arrive
//     npm run start
//       └─ app.listen()                    ← PORT OUVERT
//            └─ applyPendingMigrations()   ← migrations #2, APRÈS l'ouverture,
//                                            best-effort elles aussi
//
// Une migration en échec donnait donc un avertissement dans les journaux, et
// l'API servait un schéma incomplet. Après la vague P0, cela signifiait qu'une
// instance pouvait tourner SANS le verrou d'immuabilité des écritures, SANS
// l'isolation des vues et SANS FORCE ROW LEVEL SECURITY — c'est-à-dire en
// exposant les cabinets les uns aux autres, sans le moindre symptôme visible.
//
// ── Ce qui remplace ça ──────────────────────────────────────────────────────
//
// Les migrations sont appliquées par une AUTORITÉ UNIQUE et stricte
// (scripts/migrate.mjs, code de sortie non nul en cas d'échec), enchaînée par
// `&&` dans le Dockerfile. Ce module vérifie ENSUITE que le résultat est celui
// attendu — parce qu'un hébergeur peut remplacer la commande de démarrage et
// sauter l'étape de migration. Dans ce cas l'API refuse de démarrer et dit
// quoi faire, au lieu de migrer elle-même après avoir ouvert son port.
//
// ── Production / développement ──────────────────────────────────────────────
//
// Fail-closed en production, avertissement détaillé hors production — même
// contrat qu'assertAuthConfig() et assertDbRuntimeRole(). Le développement
// tourne presque toujours sur un Postgres superutilisateur, et un schéma en
// cours de construction y est normal. L'avertissement ne masque rien : il
// énumère précisément ce qui manque.
// ============================================================================

export interface Check {
  nom: string;
  ok: boolean;
  details: string[];
}

export interface StartupReport {
  checks: Check[];
  ok: boolean;
}

const ok = (nom: string): Check => ({ nom, ok: true, details: [] });
const ko = (nom: string, ...details: string[]): Check => ({ nom, ok: false, details });

// --- 1) Connexion ------------------------------------------------------------
// Au démarrage d'un conteneur, le réseau interne de l'hébergeur peut n'être pas
// encore prêt. On réessaie la CONNEXION — jamais un invariant en échec.

async function attendreBase(essais = 6, delaiMs = 2500): Promise<Check> {
  let derniere = '';
  for (let i = 1; i <= essais; i++) {
    try {
      await pool.query('select 1');
      return ok('connexion base');
    } catch (e: any) {
      derniere = e?.message ?? String(e);
      if (i < essais) {
        console.warn(`[startup] base injoignable (tentative ${i}/${essais}) : ${derniere}`);
        await new Promise((r) => setTimeout(r, delaiMs));
      }
    }
  }
  return ko('connexion base', `injoignable après ${essais} tentatives : ${derniere}`);
}

// --- 2) Schéma attendu -------------------------------------------------------
// Le code embarque ses migrations (supabase/migrations est dans l'image). On
// compare ce qu'il APPORTE à ce que la base a RÉELLEMENT appliqué. C'est ce qui
// détecte le cas « code en version N, base en version N-1 ».
//
// On lit le dossier plutôt que de maintenir une constante de version : une
// constante s'oublie au moment précis où elle compte, c'est-à-dire quand on
// ajoute une migration en urgence.

function migrationsLivrees(): string[] | null {
  for (const p of [path.resolve('supabase/migrations'), path.resolve(process.cwd(), 'supabase/migrations')]) {
    try {
      if (fs.existsSync(p)) return fs.readdirSync(p).filter((f) => f.endsWith('.sql')).sort();
    } catch { /* essai suivant */ }
  }
  return null;
}

export async function verifierSchema(): Promise<Check> {
  const nom = 'version du schéma';
  const livrees = migrationsLivrees();

  // Ne pas pouvoir vérifier n'est pas un succès. Si le dossier de migrations
  // n'est pas dans l'image, on ne sait rien de l'état de la base.
  if (!livrees) return ko(nom, 'dossier supabase/migrations introuvable : impossible de vérifier le schéma');
  if (livrees.length === 0) return ko(nom, 'aucune migration livrée par le code — image incomplète ?');

  let appliquees: Set<string>;
  try {
    const { rows } = await pool.query('select name from _migrations');
    appliquees = new Set(rows.map((r: any) => r.name));
  } catch (e: any) {
    return ko(nom, `table _migrations illisible (${e?.message}) — les migrations n'ont jamais été appliquées ?`);
  }

  const manquantes = livrees.filter((f) => !appliquees.has(f));
  const enTrop = [...appliquees].filter((f) => !livrees.includes(f));

  if (manquantes.length > 0) {
    const apercu = manquantes.slice(0, 5).join(', ');
    const reste = manquantes.length > 5 ? `, +${manquantes.length - 5} autres` : '';
    return ko(nom,
      `${manquantes.length} migration(s) livrée(s) par le code mais ABSENTE(S) de la base : ${apercu}${reste}`,
      'La base est en retard sur le code. Appliquez les migrations : `npm run migrate`.');
  }

  // Base en avance sur le code (retour arrière applicatif) : anormal, mais pas
  // dangereux en soi — le schéma contient plus que ce que le code attend.
  const c = ok(nom);
  if (enTrop.length > 0) {
    c.details.push(`⚠ ${enTrop.length} migration(s) en base mais absente(s) du code (retour arrière ?) : ${enTrop.slice(0, 3).join(', ')}`);
  }
  c.details.push(`${livrees.length} migration(s) livrée(s), toutes appliquées`);
  return c;
}

// --- 3) Invariants de sécurité ----------------------------------------------
// Vérifie que les objets qui PORTENT les garanties sont réellement en base.
// On ne se fie pas au nom d'une migration présente dans _migrations : une
// migration peut avoir été jouée puis un objet supprimé à la main.

interface LigneInvariants {
  protect_lines_insert: boolean;
  protect_lines_update: boolean;
  protect_lines_delete: boolean;
  protect_entries: boolean;
  balance_differe: boolean;
  post_check: boolean;
  periode_ouverte: boolean;
  vues_sans_invoker: number;
  tables_rls_sans_force: number;
  rls_core: number;
  fonctions_manquantes: string[];
}

const FONCTIONS_CRITIQUES = [
  'app_current_user_id', 'app_dossier_ids', 'app_cabinet_ids',
  'reverse_entry', 'dossier_delete', 'dossier_role_for',
  'protect_posted_lines', 'protect_posted_entries', 'check_entry_balanced',
];

// Tables cœur du périmètre locataire : elles DOIVENT être sous RLS.
const TABLES_CORE = ['entries', 'entry_lines', 'accounts', 'dossiers', 'cabinets', 'cabinet_members', 'dossier_access'];

export async function verifierInvariantsSecurite(): Promise<Check> {
  const nom = 'invariants de sécurité';
  let r: LigneInvariants;
  try {
    const { rows } = await pool.query(`
      select
        -- Verrou d'immuabilité des lignes : doit couvrir INSERT (NOVA-P0-03).
        -- tgtype : 2=BEFORE, 4=INSERT, 8=DELETE, 16=UPDATE
        coalesce((select (t.tgtype & 4) > 0 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                   where c.relname = 'entry_lines' and t.tgname = 'trg_protect_lines' and not t.tgisinternal), false) as protect_lines_insert,
        coalesce((select (t.tgtype & 16) > 0 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                   where c.relname = 'entry_lines' and t.tgname = 'trg_protect_lines' and not t.tgisinternal), false) as protect_lines_update,
        coalesce((select (t.tgtype & 8) > 0 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                   where c.relname = 'entry_lines' and t.tgname = 'trg_protect_lines' and not t.tgisinternal), false) as protect_lines_delete,
        exists(select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                where c.relname = 'entries' and t.tgname = 'trg_protect_entries' and not t.tgisinternal) as protect_entries,
        exists(select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                where c.relname = 'entry_lines' and t.tgname = 'trg_entry_balanced' and not t.tgisinternal) as balance_differe,
        exists(select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                where c.relname = 'entries' and t.tgname = 'trg_entry_post_check' and not t.tgisinternal) as post_check,
        exists(select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                where c.relname = 'entries' and t.tgname = 'trg_period_open' and not t.tgisinternal) as periode_ouverte,
        -- Isolation des vues (NOVA-P0-01) : aucune vue sans security_invoker.
        (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'v'
            and not coalesce((select option_value::boolean from pg_options_to_table(c.reloptions)
                               where option_name = 'security_invoker'), false)) as vues_sans_invoker,
        -- Frontière locataire (NOVA-P0-02) : RLS forcée partout où elle est active.
        (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and c.relrowsecurity and not c.relforcerowsecurity) as tables_rls_sans_force,
        -- Les tables cœur doivent être sous RLS, et pas seulement « pas sans FORCE ».
        (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and c.relname = any($1::text[]) and c.relrowsecurity and c.relforcerowsecurity) as rls_core,
        coalesce((select array_agg(f::text) from unnest($2::text[]) f
                   where to_regproc('public.' || f) is null), '{}'::text[]) as fonctions_manquantes
    `, [TABLES_CORE, FONCTIONS_CRITIQUES]);
    r = rows[0];
  } catch (e: any) {
    return ko(nom, `vérification impossible : ${e?.message}`);
  }

  const manques: string[] = [];

  if (!r.protect_lines_insert) {
    manques.push("le verrou d'immuabilité trg_protect_lines ne couvre pas l'INSERT "
      + '(NOVA-P0-03 : on peut ajouter des lignes à une écriture comptabilisée) — migration 0078 absente ?');
  }
  if (!r.protect_lines_update || !r.protect_lines_delete) {
    manques.push('trg_protect_lines ne couvre pas UPDATE et/ou DELETE sur entry_lines');
  }
  if (!r.protect_entries) manques.push("trg_protect_entries absent sur entries (en-tête d'écriture modifiable)");
  if (!r.balance_differe) manques.push("trg_entry_balanced absent : l'équilibre débit/crédit n'est plus imposé");
  if (!r.post_check) manques.push('trg_entry_post_check absent : équilibre non vérifié à la validation');
  if (!r.periode_ouverte) manques.push('trg_period_open absent : écriture possible dans un exercice clôturé');

  if (Number(r.vues_sans_invoker) > 0) {
    manques.push(`${r.vues_sans_invoker} vue(s) sans security_invoker `
      + '(NOVA-P0-01 : lecture inter-cabinet possible) — migration 0079 absente ?');
  }
  if (Number(r.tables_rls_sans_force) > 0) {
    manques.push(`${r.tables_rls_sans_force} table(s) sous RLS sans FORCE ROW LEVEL SECURITY `
      + '(NOVA-P0-02) — migration 0080 absente ?');
  }
  if (Number(r.rls_core) !== TABLES_CORE.length) {
    manques.push(`seulement ${r.rls_core}/${TABLES_CORE.length} tables cœur sous RLS+FORCE `
      + `(${TABLES_CORE.join(', ')})`);
  }
  const fm = (r.fonctions_manquantes ?? []) as string[];
  if (fm.length > 0) manques.push(`fonction(s) critique(s) absente(s) : ${fm.join(', ')}`);

  if (manques.length > 0) return ko(nom, ...manques);

  const c = ok(nom);
  c.details.push('verrous du ledger, isolation des vues et FORCE RLS en place');
  return c;
}

// --- 4) Rôle PostgreSQL du runtime -------------------------------------------
// Réutilise dbguard (vague P0) : une seule expression de la règle.

export async function verifierRoleRuntime(): Promise<Check> {
  const nom = 'rôle PostgreSQL du runtime';
  try {
    const id = await readDbIdentity();
    const dangers = dangersFor(id);
    if (dangers.length > 0) return ko(nom, ...dangers);
    const c = ok(nom);
    c.details.push(`rôle « ${id.role} » : NOSUPERUSER, NOBYPASSRLS, non propriétaire`);
    return c;
  } catch (e: any) {
    return ko(nom, `identité PostgreSQL non vérifiable : ${e?.message}`);
  }
}

// --- Orchestration -----------------------------------------------------------

export async function runStartupChecks(): Promise<StartupReport> {
  const checks: Check[] = [];

  const connexion = await attendreBase();
  checks.push(connexion);

  // Sans connexion, les trois autres contrôles ne peuvent rien affirmer. On ne
  // les marque pas « ok » par défaut : on dit qu'ils n'ont pas pu s'exécuter.
  if (!connexion.ok) {
    checks.push(ko('version du schéma', 'non vérifié — base injoignable'));
    checks.push(ko('invariants de sécurité', 'non vérifié — base injoignable'));
    checks.push(ko('rôle PostgreSQL du runtime', 'non vérifié — base injoignable'));
  } else {
    checks.push(await verifierSchema());
    checks.push(await verifierInvariantsSecurite());
    checks.push(await verifierRoleRuntime());
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

/**
 * Garde de démarrage — à appeler AVANT app.listen().
 *
 * Lève en production si un contrôle échoue. Hors production, journalise le
 * détail sans bloquer : un poste de développement tourne sur un Postgres
 * superutilisateur et parfois sur un schéma en cours de construction.
 */
export async function assertStartupReady(): Promise<void> {
  const prod = process.env.NODE_ENV === 'production';
  const rapport = await runStartupChecks();

  for (const c of rapport.checks) {
    const marque = c.ok ? '✓' : '✗';
    console.log(`[startup] ${marque} ${c.nom}`);
    for (const d of c.details) console.log(`[startup]     ${d}`);
  }

  if (rapport.ok) {
    console.log('[startup] MIGRATIONS_OK SCHEMA_VERSION_OK SECURITY_INVARIANTS_OK DATABASE_RUNTIME_ROLE_OK');
    return;
  }

  const echecs = rapport.checks.filter((c) => !c.ok);
  const detail = echecs
    .map((c) => `  ✗ ${c.nom}\n` + c.details.map((d) => `      · ${d}`).join('\n'))
    .join('\n');

  if (prod) {
    throw new Error(
      'Démarrage refusé : la base ne présente pas les garanties attendues.\n'
      + detail + '\n\n'
      + "Nova ne sert aucune requête tant que le schéma et les invariants de sécurité ne sont pas "
      + "vérifiés : sur une comptabilité, un schéma incomplet produit des données fausses ou "
      + "expose les cabinets les uns aux autres, sans erreur visible.\n"
      + 'Appliquez les migrations (`npm run migrate`) puis redémarrez.');
  }

  console.warn(`[startup] ⚠ contrôles en échec — toléré hors production, JAMAIS en prod :\n${detail}`);
}
