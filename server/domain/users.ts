import type { Client } from '../db.js';

// Accès aux comptes utilisateurs via les fonctions SECURITY DEFINER (0008).

export async function registerUser(c: Client, email: string, passwordHash: string, name: string): Promise<string> {
  const { rows } = await c.query('select register_user($1,$2,$3) as id', [email, passwordHash, name]);
  return rows[0].id;
}

export async function getUserForLogin(
  c: Client, email: string,
): Promise<{ id: string; password_hash: string; name: string | null; email: string } | null> {
  const { rows } = await c.query('select * from get_user_for_login($1)', [email]);
  return rows[0] ?? null;
}

export async function getUser(
  c: Client, id: string,
): Promise<{ id: string; email: string; name: string | null } | null> {
  const { rows } = await c.query('select * from get_user($1)', [id]);
  return rows[0] ?? null;
}
