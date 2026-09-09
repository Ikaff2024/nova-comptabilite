import pg from 'pg';
import { dangersFor, type DbIdentity } from './dbguard.js';
import { closePool } from './db.js';

// ============================================================================
// SÉCURITÉ — garde d'identité PostgreSQL au démarrage (NOVA-P0-02).
//
// La revue CTO 001 a reproduit ceci : même code, même contexte utilisateur,
// mais DATABASE_URL pointant sur un rôle propriétaire — et un utilisateur du
// cabinet B lisait « SECRET-A-CONFIDENTIEL », l'écriture du cabinet A. Sans
// erreur, sans log. L'API ne doit plus pouvoir démarrer dans cet état.
//
// Ce test crée de VRAIS rôles PostgreSQL et interroge la base avec chacun, au
// lieu de simuler la lecture d'identité. Un test qui se contenterait d'appeler
// dangersFor() sur des objets fabriqués vérifierait la logique de décision mais
// pas la détection — or c'est la détection qui a manqué pendant six mois.
//
//   npm run test:dbguard   (nécessite DATABASE_URL + un rôle pouvant créer des rôles)
//
// La création de rôles exige des droits d'administration : ce test s'exécute
// donc avec l'URL d'administration (MIGRATION_DATABASE_URL si présente, sinon
// DATABASE_URL, ce qui est le cas en CI où l'on est postgres).
// ============================================================================

let ok = 0, ko = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { ok++; console.log(`  PASS ${label} ${detail}`); }
  else { ko++; console.error(`  FAIL ${label} ${detail}`); }
};

const ADMIN_URL = process.env.MIGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/nova';

/** Lit l'identité telle que la verrait dbguard, mais via une connexion donnée. */
async function identityVia(url: string): Promise<DbIdentity> {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await p.query(`
      select
        current_user as role,
        (select rolsuper     from pg_roles where rolname = current_user) as superuser,
        (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls,
        coalesce((
          select array_agg(c.relname::text order by c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname='public' and c.relkind='r' and c.relrowsecurity
             and pg_get_userbyid(c.relowner) = current_user
        ), '{}'::text[]) as owned_tenant_tables,
        (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname='public' and c.relkind='r'
            and c.relrowsecurity and not c.relforcerowsecurity) as rls_without_force
    `);
    const r = rows[0];
    return {
      role: String(r.role), superuser: !!r.superuser, bypassRls: !!r.bypass_rls,
      ownedTenantTables: (r.owned_tenant_tables ?? []) as string[],
      rlsWithoutForce: Number(r.rls_without_force ?? 0),
    };
  } finally { await p.end(); }
}

function urlAvecRole(base: string, role: string, mdp: string): string {
  const u = new URL(base);
  u.username = role; u.password = mdp;
  return u.toString();
}

async function main() {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });

  // Rôles jetables, recréés à chaque exécution.
  await admin.query(`
    do $$ begin
      -- rôle sain : ce que DATABASE_URL DOIT désigner
      if not exists (select 1 from pg_roles where rolname='nova_guard_sain') then
        create role nova_guard_sain login password 'x' nosuperuser nobypassrls;
      end if;
      execute 'alter role nova_guard_sain nosuperuser nobypassrls';
      grant usage on schema public to nova_guard_sain;
      grant select on all tables in schema public to nova_guard_sain;

      -- rôle dangereux : BYPASSRLS
      if not exists (select 1 from pg_roles where rolname='nova_guard_bypass') then
        create role nova_guard_bypass login password 'x';
      end if;
      execute 'alter role nova_guard_bypass nosuperuser bypassrls';
      grant usage on schema public to nova_guard_bypass;
      grant select on all tables in schema public to nova_guard_bypass;

      -- rôle dangereux : SUPERUSER
      if not exists (select 1 from pg_roles where rolname='nova_guard_super') then
        create role nova_guard_super login password 'x';
      end if;
      execute 'alter role nova_guard_super superuser';
    end $$;
  `);

  console.log('\n--- 1) Rôle applicatif sain : le démarrage doit être AUTORISÉ ---');
  const sain = await identityVia(urlAvecRole(ADMIN_URL, 'nova_guard_sain', 'x'));
  const dangersSain = dangersFor(sain);
  check('rôle sain : aucun motif de refus', dangersSain.length === 0,
    dangersSain.length ? `(${dangersSain.join(' | ')})` : `(${sain.role})`);
  check('rôle sain : détecté NOSUPERUSER', sain.superuser === false);
  check('rôle sain : détecté NOBYPASSRLS', sain.bypassRls === false);
  check('rôle sain : ne possède aucune table locataire', sain.ownedTenantTables.length === 0);

  console.log('\n--- 2) Rôle BYPASSRLS : le démarrage doit être REFUSÉ ---');
  const byp = await identityVia(urlAvecRole(ADMIN_URL, 'nova_guard_bypass', 'x'));
  check('BYPASSRLS détecté', byp.bypassRls === true);
  check('BYPASSRLS : démarrage refusé', dangersFor(byp).length > 0,
    `(${dangersFor(byp)[0] ?? ''})`);

  console.log('\n--- 3) Rôle SUPERUSER : le démarrage doit être REFUSÉ ---');
  const sup = await identityVia(urlAvecRole(ADMIN_URL, 'nova_guard_super', 'x'));
  check('SUPERUSER détecté', sup.superuser === true);
  check('SUPERUSER : démarrage refusé', dangersFor(sup).length > 0,
    `(${dangersFor(sup)[0] ?? ''})`);

  console.log('\n--- 4) Rôle PROPRIÉTAIRE des tables : le démarrage doit être REFUSÉ ---');
  // C'est l'identité qui a joué les migrations : elle possède les tables.
  const owner = await identityVia(ADMIN_URL);
  check('propriétaire : possède des tables sous RLS', owner.ownedTenantTables.length > 0,
    `(${owner.ownedTenantTables.length} table(s), rôle ${owner.role})`);
  check('propriétaire : démarrage refusé', dangersFor(owner).length > 0);

  console.log('\n--- 5) FORCE ROW LEVEL SECURITY posé partout (migration 0080) ---');
  check('aucune table sous RLS sans FORCE', owner.rlsWithoutForce === 0,
    `(${owner.rlsWithoutForce} table(s) sans FORCE)`);

  // Nettoyage : on ne laisse pas traîner de rôles de test.
  await admin.query(`
    do $$ begin
      revoke all on all tables in schema public from nova_guard_sain, nova_guard_bypass;
      revoke usage on schema public from nova_guard_sain, nova_guard_bypass;
    exception when others then null; end $$;`);
  await admin.query(`drop role if exists nova_guard_sain`);
  await admin.query(`drop role if exists nova_guard_bypass`);
  await admin.query(`drop role if exists nova_guard_super`);
  await admin.end();

  console.log(`\n${ok} PASS / ${ko} FAIL`);
  if (ko) process.exitCode = 1;
  await closePool();
}

main().catch(async (e) => {
  console.error('ERREUR', e);
  process.exitCode = 1;
  await closePool().catch(() => {});
});
