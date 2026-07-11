import type { Client } from '../db.js';

// ============================================================================
// Portail client : gestion des accès dossier restreints (rôle 'client') et
// lecture du rôle effectif du demandeur. S'appuie sur les fonctions
// SECURITY DEFINER (0034) qui contrôlent le périmètre (admins du cabinet).
// L'isolation des données reste assurée par la RLS (dossier_access).
// ============================================================================

export type EffectiveRole = 'staff' | 'gestionnaire' | 'collaborateur' | 'client' | 'lecture' | null;

// Rôle du demandeur sur un dossier ; null s'il n'y a aucun accès.
export async function myDossierRole(c: Client, dossierId: string): Promise<EffectiveRole> {
  const { rows } = await c.query('select dossier_role_for($1) as role', [dossierId]);
  return (rows[0]?.role ?? null) as EffectiveRole;
}

// Un rôle 'client'/'lecture' est restreint (consultation + dépôt de pièces).
export function isRestricted(role: EffectiveRole): boolean {
  return role === 'client' || role === 'lecture';
}

export async function grantClient(c: Client, dossierId: string, email: string): Promise<{ userId: string }> {
  if (!email?.trim()) throw new Error('Email requis.');
  try {
    const { rows } = await c.query('select dossier_client_grant($1,$2) as uid', [dossierId, email.trim()]);
    return { userId: rows[0].uid };
  } catch (e: any) {
    if (String(e.message).includes('USER_NOT_FOUND')) {
      throw new Error("Aucun compte Nova avec cet email. La personne doit d'abord créer son compte, puis vous l'invitez.");
    }
    throw e;
  }
}

export async function listClients(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query('select * from dossier_clients_list($1)', [dossierId]);
  return rows.map((r: any) => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at }));
}

export async function revokeClient(c: Client, dossierId: string, userId: string): Promise<void> {
  await c.query('select dossier_client_revoke($1,$2)', [dossierId, userId]);
}
