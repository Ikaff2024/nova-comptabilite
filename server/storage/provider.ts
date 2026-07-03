import crypto from 'node:crypto';

// ============================================================================
// Stockage d'objets. 'db' (octets en base) par défaut ; 'r2' (Cloudflare R2,
// S3-compatible) si les variables d'env sont présentes. Signature AWS SigV4
// maison (aucune dépendance), comme le reste du projet.
// ============================================================================

interface R2Config { accountId: string; accessKey: string; secretKey: string; bucket: string }

function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (accountId && accessKey && secretKey && bucket) return { accountId, accessKey, secretKey, bucket };
  return null;
}

export function storageMode(): 'db' | 'r2' {
  return r2Config() ? 'r2' : 'db';
}

const sha256hex = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

// Signe et exécute une requête S3 (R2) en SigV4. region = 'auto', service = 's3'.
async function r2Request(method: 'PUT' | 'GET', key: string, body?: Buffer, contentType?: string): Promise<Response> {
  const cfg = r2Config()!;
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = '/' + cfg.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + cfg.secretKey, dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`https://${host}${canonicalUri}`, { method, headers, body });
}

export async function putObject(key: string, contentType: string, body: Buffer): Promise<void> {
  const res = await r2Request('PUT', key, body, contentType);
  if (!res.ok) throw new Error(`R2 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function getObject(key: string): Promise<Buffer> {
  const res = await r2Request('GET', key);
  if (!res.ok) throw new Error(`R2 GET ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
