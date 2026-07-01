import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ============================================================================
// Auth maison, sans dépendance : hachage scrypt + JWT HS256.
// Choix « own your core » : pas de lib externe pour la brique sécurité.
// ============================================================================

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 jours

// --- Mot de passe (scrypt) ---------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

// --- JWT HS256 ---------------------------------------------------------------

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlJson = (obj: unknown) => b64url(JSON.stringify(obj));

function sign(data: string): string {
  return b64url(createHmac('sha256', JWT_SECRET).update(data).digest());
}

export interface TokenPayload { sub: string; email: string; name?: string; iat: number; exp: number; }

export function issueToken(user: { id: string; email: string; name?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    sub: user.id, email: user.email, name: user.name,
    iat: now, exp: now + TOKEN_TTL_SECONDS,
  };
  const head = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson(payload);
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = sign(`${head}.${body}`);
  // comparaison à temps constant
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64').toString()) as TokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
