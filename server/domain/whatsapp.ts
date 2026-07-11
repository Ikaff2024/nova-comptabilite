import type { Client } from '../db.js';
import { pool } from '../db.js';
import { normalizePhone } from '../whatsapp/provider.js';

// ============================================================================
// Liaison des numéros WhatsApp à un utilisateur + dossier. La résolution
// (webhook, hors session) passe par la fonction SECURITY DEFINER whatsapp_resolve.
// ============================================================================

export async function listLinks(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    'select id, phone, label, to_char(created_at,\'YYYY-MM-DD\') as created_at from whatsapp_links where dossier_id=$1 order by created_at desc',
    [dossierId]);
  return rows;
}

export async function createLink(c: Client, dossierId: string, userId: string, phone: string, label?: string): Promise<{ id: string }> {
  const p = normalizePhone(phone);
  if (p.length < 8) throw new Error('Numéro invalide (format international attendu, ex. 2250700000000).');
  try {
    const { rows } = await c.query(
      'insert into whatsapp_links(dossier_id, user_id, phone, label) values ($1,$2,$3,$4) returning id',
      [dossierId, userId, p, label ?? null]);
    return { id: rows[0].id };
  } catch (e: any) {
    if (String(e.message).includes('whatsapp_links_phone_key') || e.code === '23505') throw new Error('Ce numéro est déjà relié à un dossier.');
    throw e;
  }
}

export async function deleteLink(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from whatsapp_links where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Résolution numéro -> (utilisateur, dossier) sans session (pool + SECURITY DEFINER).
export async function resolvePhone(phone: string): Promise<{ userId: string; dossierId: string } | null> {
  const { rows } = await pool.query('select user_id, dossier_id from whatsapp_resolve($1)', [normalizePhone(phone)]);
  return rows[0] ? { userId: rows[0].user_id, dossierId: rows[0].dossier_id } : null;
}
