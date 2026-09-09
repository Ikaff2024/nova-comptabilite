import { pool } from './db.js';

// ============================================================================
// Garde de démarrage sur l'IDENTITÉ POSTGRESQL du runtime.
//
// Toute l'étanchéité entre cabinets repose sur la RLS. Or la RLS ne s'applique
// pas à n'importe quel rôle : un superutilisateur l'ignore, un rôle BYPASSRLS
// l'ignore, et le propriétaire d'une table l'ignore tant qu'elle n'est pas en
// FORCE. Si DATABASE_URL désigne un de ces rôles, la frontière disparaît —
// SANS AUCUN SIGNE. L'application continue de fonctionner : elle montre
// simplement tous les cabinets à tout le monde.
//
// C'est le scénario reproduit par la revue CTO 001 (NOVA-P0-02) : même code,
// même contexte utilisateur, connexion en rôle propriétaire, et un utilisateur
// du cabinet B lisait l'écriture du cabinet A.
//
// Le risque n'est pas théorique : les Postgres managés (Railway, Neon,
// Supabase, RDS) fournissent par défaut une chaîne de connexion en
// propriétaire ou en superutilisateur. Il suffit de coller celle-là dans
// DATABASE_URL.
//
// La migration 0080 pose FORCE ROW LEVEL SECURITY, ce qui ferme le cas du
// propriétaire non-superutilisateur. Mais FORCE n'a AUCUN effet sur un
// superutilisateur ni sur un rôle BYPASSRLS — vérifié pendant la remédiation :
// avec FORCE partout, une connexion superutilisateur lisait toujours tout.
// Cette garde est donc la mesure principale, pas un complément décoratif.
//
// Même contrat qu'assertAuthConfig() : fail-closed en production, simple
// avertissement en développement pour ne pas gêner un Postgres local jetable.
// ============================================================================

export interface DbIdentity {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Tables portant une RLS et possédées par le rôle courant. */
  ownedTenantTables: string[];
  /** Tables sous RLS mais sans FORCE — la RLS y reste inopérante pour un propriétaire. */
  rlsWithoutForce: number;
}

/**
 * Interroge la base sur l'identité réellement utilisée par le pool applicatif.
 * On ne déduit rien de DATABASE_URL : la chaîne peut mentir (pgbouncer, rôle
 * changé par un `SET ROLE` d'infrastructure, alias). Seul `current_user` fait foi.
 */
export async function readDbIdentity(): Promise<DbIdentity> {
  const { rows } = await pool.query(`
    select
      current_user as role,
      (select rolsuper     from pg_roles where rolname = current_user) as superuser,
      (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls,
      coalesce((
        select array_agg(c.relname::text order by c.relname)
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
           and pg_get_userbyid(c.relowner) = current_user
      ), '{}'::text[]) as owned_tenant_tables,
      (select count(*)
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relrowsecurity and not c.relforcerowsecurity) as rls_without_force
  `);
  const r = rows[0] ?? {};
  return {
    role: String(r.role ?? 'inconnu'),
    superuser: !!r.superuser,
    bypassRls: !!r.bypass_rls,
    ownedTenantTables: (r.owned_tenant_tables ?? []) as string[],
    rlsWithoutForce: Number(r.rls_without_force ?? 0),
  };
}

/** Motifs pour lesquels l'identité courante peut contourner la RLS. */
export function dangersFor(id: DbIdentity): string[] {
  const d: string[] = [];
  if (id.superuser) {
    d.push(`le rôle « ${id.role} » est SUPERUSER : il ignore la RLS, quelle que soit la configuration des tables`);
  }
  if (id.bypassRls) {
    d.push(`le rôle « ${id.role} » a l'attribut BYPASSRLS : il ignore la RLS`);
  }
  if (id.ownedTenantTables.length > 0) {
    const apercu = id.ownedTenantTables.slice(0, 5).join(', ');
    const reste = id.ownedTenantTables.length > 5 ? `, +${id.ownedTenantTables.length - 5} autres` : '';
    d.push(
      `le rôle « ${id.role} » est PROPRIÉTAIRE de ${id.ownedTenantTables.length} table(s) sous RLS `
      + `(${apercu}${reste}) : un propriétaire peut lever FORCE ROW LEVEL SECURITY à tout moment`);
  }
  return d;
}

/**
 * Garde de démarrage — appelée au boot, après que le pool est joignable.
 *
 * Refuse de démarrer en production si l'identité PostgreSQL du runtime peut
 * contourner l'isolation entre cabinets. Hors production, journalise sans
 * bloquer : un Postgres de développement tourne presque toujours en superuser.
 *
 * Ne lève PAS si la base est injoignable : ce n'est pas le rôle de cette garde,
 * et faire échouer le démarrage sur une base temporairement absente
 * transformerait un incident réseau en panne totale. L'indisponibilité est
 * déjà signalée par /api/health.
 */
export async function assertDbRuntimeRole(): Promise<void> {
  const prod = process.env.NODE_ENV === 'production';

  let id: DbIdentity;
  try {
    id = await readDbIdentity();
  } catch (e: any) {
    console.warn(`[dbguard] identité PostgreSQL non vérifiable (${e?.message}) — contrôle reporté.`);
    return;
  }

  const dangers = dangersFor(id);

  if (dangers.length === 0) {
    console.log(
      `[dbguard] rôle « ${id.role} » : NOSUPERUSER, NOBYPASSRLS, non propriétaire — isolation applicable.`
      + (id.rlsWithoutForce > 0
        ? ` ⚠ ${id.rlsWithoutForce} table(s) sous RLS sans FORCE (migration 0080 non appliquée ?).`
        : ''));
    return;
  }

  const detail = dangers.map((d) => `  · ${d}`).join('\n');

  if (prod) {
    throw new Error(
      'Identité PostgreSQL dangereuse en production : démarrage refusé.\n'
      + detail + '\n\n'
      + "Avec ce rôle, la RLS ne s'applique pas et TOUS les cabinets voient les données "
      + "de tous les autres, sans aucune erreur visible.\n"
      + 'Corrigez DATABASE_URL pour utiliser le rôle applicatif restreint (nova_app : '
      + 'NOSUPERUSER, NOBYPASSRLS, non propriétaire des tables). Les migrations, elles, '
      + 'peuvent continuer à passer par MIGRATION_DATABASE_URL avec un rôle privilégié.');
  }

  console.warn(
    `[dbguard] ⚠ le rôle « ${id.role} » peut contourner la RLS — toléré hors production, JAMAIS en prod :\n${detail}`);
}
