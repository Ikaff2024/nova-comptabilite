import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ============================================================================
// Auth maison, sans dépendance : hachage scrypt + JWT HS256.
// Choix « own your core » : pas de lib externe pour la brique sécurité.
// ============================================================================

const DEFAUT_DEV = 'dev-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET ?? DEFAUT_DEV;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 jours

/**
 * Garde de démarrage — appelée au boot (index.ts).
 *
 * Le secret JWT a un repli « dev-secret-change-me » pour que le développement
 * local tourne sans configuration. Mais si ce repli sert EN PRODUCTION, tout
 * jeton devient forgeable : n'importe qui signe un jeton pour n'importe quel
 * compte et prend la main. Le serveur ne doit pas démarrer dans cet état.
 *
 * Fail-closed en production uniquement : en local, on se contente d'un
 * avertissement pour ne pas gêner le développement.
 */
export function assertAuthConfig(): void {
  const secret = process.env.JWT_SECRET;
  const prod = process.env.NODE_ENV === 'production';
  const faible = !secret || secret === DEFAUT_DEV || secret.length < 24;
  if (faible && prod) {
    throw new Error(
      'JWT_SECRET absent ou trop faible en production : démarrage refusé. '
      + 'Posez une variable JWT_SECRET d\'au moins 24 caractères aléatoires '
      + '(sinon tout jeton d\'authentification est forgeable).');
  }
  if (faible) {
    console.warn('[auth] ⚠ JWT_SECRET faible ou absent — toléré hors production, JAMAIS en prod.');
  }
}

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

// --- 2FA TOTP (RFC 6238) — maison, base32 + HMAC-SHA1 ------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(secret: string, email: string, issuer = 'Nova Comptabilité'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

// Vérifie un code TOTP (fenêtre ±1 pas de 30 s pour tolérer le décalage d'horloge).
export function verifyTotp(secret: string, code: string, window = 1): boolean {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (timingSafeEqual(Buffer.from(hotp(key, counter + i)), Buffer.from(clean))) return true;
  }
  return false;
}
