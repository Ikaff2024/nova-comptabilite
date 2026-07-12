import type { Client } from '../db.js';
import { pool } from '../db.js';

// ============================================================================
// Liaison des chats Telegram à un utilisateur + dossier, via un CODE.
// L'app crée un lien en attente (code) ; l'utilisateur envoie le code au bot ;
// le webhook associe le chat_id (fonctions SECURITY DEFINER, hors session).
// ============================================================================

function genCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans caractères ambigus
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

export async function listLinks(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    "select id, chat_id, link_code, label, (chat_id is not null) as linked, to_char(created_at,'YYYY-MM-DD') as created_at from telegram_links where dossier_id=$1 order by created_at desc",
    [dossierId]);
  return rows.map((r: any) => ({ id: r.id, code: r.link_code, label: r.label, linked: r.linked, created_at: r.created_at }));
}

export async function createLinkCode(c: Client, dossierId: string, userId: string, label?: string): Promise<{ code: string }> {
  const code = genCode();
  await c.query('insert into telegram_links(dossier_id, user_id, chat_id, link_code, label) values ($1,$2,null,$3,$4)', [dossierId, userId, code, label ?? null]);
  return { code };
}

export async function deleteLink(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from telegram_links where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Hors session (webhook) --------------------------------------------------
export async function resolveChat(chatId: string): Promise<{ userId: string; dossierId: string } | null> {
  const { rows } = await pool.query('select user_id, dossier_id from telegram_resolve($1)', [chatId]);
  return rows[0] ? { userId: rows[0].user_id, dossierId: rows[0].dossier_id } : null;
}

export async function linkByCode(code: string, chatId: string): Promise<{ userId: string; dossierId: string } | null> {
  const { rows } = await pool.query('select user_id, dossier_id from telegram_link_code($1,$2)', [code, chatId]);
  return rows[0] ? { userId: rows[0].user_id, dossierId: rows[0].dossier_id } : null;
}
