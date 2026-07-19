import type { Client } from '../db.js';

// Accès aux comptes utilisateurs via les fonctions SECURITY DEFINER (0008).

export async function registerUser(c: Client, email: string, passwordHash: string, name: string): Promise<string> {
  const { rows } = await c.query('select register_user($1,$2,$3) as id', [email, passwordHash, name]);
  return rows[0].id;
}

export async function getUserForLogin(
  c: Client, email: string,
): Promise<{ id: string; password_hash: string; name: string | null; email: string; totp_secret: string | null; totp_enabled: boolean; is_platform_admin: boolean } | null> {
  const { rows } = await c.query('select * from get_user_for_login($1)', [email]);
  return rows[0] ?? null;
}

export async function getUser(
  c: Client, id: string,
): Promise<{ id: string; email: string; name: string | null; totp_enabled: boolean; is_platform_admin: boolean } | null> {
  const { rows } = await c.query('select * from get_user($1)', [id]);
  return rows[0] ?? null;
}

// --- 2FA ---------------------------------------------------------------------
export async function totpSetPending(c: Client, secret: string): Promise<void> {
  await c.query('select totp_set_pending($1)', [secret]);
}
export async function totpEnable(c: Client): Promise<void> { await c.query('select totp_enable()'); }
export async function totpDisable(c: Client): Promise<void> { await c.query('select totp_disable()'); }

// --- Membres du cabinet ------------------------------------------------------
export async function listMembers(c: Client, cabinetId: string): Promise<any[]> {
  const { rows } = await c.query('select * from cabinet_members_list($1)', [cabinetId]);
  return rows.map((r: any) => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at }));
}
export async function addMember(c: Client, cabinetId: string, email: string, role: string): Promise<{ id: string }> {
  try {
    const { rows } = await c.query('select cabinet_member_add($1,$2,$3) as id', [cabinetId, email, role]);
    return { id: rows[0].id };
  } catch (e: any) {
    if (String(e.message).includes('USER_NOT_FOUND')) throw new Error("Aucun compte Nova avec cet email. La personne doit d'abord créer son compte.");
    throw e;
  }
}
// --- Périmètre d'un membre : accès à tous les dossiers, ou à une sélection ---
export async function getMemberAccess(c: Client, cabinetId: string, userId: string): Promise<{
  restricted: boolean; dossiers: { id: string; raisonSociale: string; granted: boolean }[];
}> {
  const { rows } = await c.query('select * from cabinet_member_access_get($1,$2)', [cabinetId, userId]);
  return {
    restricted: !!rows[0]?.restricted,
    dossiers: rows.map((r: any) => ({ id: r.dossier_id, raisonSociale: r.raison_sociale, granted: !!r.granted })),
  };
}

export async function setMemberAccess(c: Client, cabinetId: string, userId: string, restricted: boolean, dossierIds: string[]): Promise<void> {
  await c.query('select cabinet_member_access_set($1,$2,$3,$4::uuid[])', [cabinetId, userId, !!restricted, dossierIds ?? []]);
}

export async function setMemberRole(c: Client, cabinetId: string, userId: string, role: string): Promise<void> {
  await c.query('select cabinet_member_set_role($1,$2,$3)', [cabinetId, userId, role]);
}
export async function removeMember(c: Client, cabinetId: string, userId: string): Promise<void> {
  await c.query('select cabinet_member_remove($1,$2)', [cabinetId, userId]);
}

export async function renameCabinet(c: Client, cabinetId: string, name: string): Promise<void> {
  await c.query('select cabinet_rename($1,$2)', [cabinetId, name]);
}

// Nom d'affichage de l'utilisateur courant.
export async function setMyName(c: Client, name: string): Promise<void> {
  await c.query('select user_set_name($1)', [name]);
}
