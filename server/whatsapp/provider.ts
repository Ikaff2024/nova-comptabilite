import crypto from 'node:crypto';

// ============================================================================
// Canal WhatsApp via Meta Cloud API (Graph). Réception par webhook, envoi via
// /{phone_number_id}/messages. La logique métier (routage vers l'agent/capture)
// vit ailleurs ; ce module ne fait que parler à Meta.
// ============================================================================

const GRAPH = 'https://graph.facebook.com/v21.0';

const token = () => process.env.WHATSAPP_TOKEN ?? '';
const phoneId = () => process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const verifyToken = () => process.env.WHATSAPP_VERIFY_TOKEN ?? '';
const appSecret = () => process.env.WHATSAPP_APP_SECRET ?? '';

export function whatsappEnabled(): boolean {
  return !!(token() && phoneId());
}

// Numéro tel que Meta l'envoie : chiffres uniquement (E.164 sans '+').
export function normalizePhone(p: string): string {
  return String(p ?? '').replace(/[^0-9]/g, '');
}

// Handshake de vérification du webhook (GET).
export function verifyWebhook(mode: string, tok: string): boolean {
  return mode === 'subscribe' && !!verifyToken() && tok === verifyToken();
}

// Vérifie la signature Meta (X-Hub-Signature-256). Sans app secret configuré,
// on ne bloque pas (utile en phase d'intégration) mais on le signale.
export function verifySignature(rawBody: string, header?: string): boolean {
  if (!appSecret()) return true;
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret()).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface InboundMessage {
  from: string;                 // numéro E.164 sans '+'
  type: 'text' | 'image' | 'document' | 'audio' | 'other';
  text?: string;
  mediaId?: string;
  mimeType?: string;
}

// Extrait les messages entrants d'un payload webhook Meta.
export function parseInbound(body: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        const base = { from: normalizePhone(m.from) };
        if (m.type === 'text') out.push({ ...base, type: 'text', text: m.text?.body ?? '' });
        else if (m.type === 'image') out.push({ ...base, type: 'image', mediaId: m.image?.id, mimeType: m.image?.mime_type });
        else if (m.type === 'document') out.push({ ...base, type: 'document', mediaId: m.document?.id, mimeType: m.document?.mime_type });
        else if (m.type === 'audio') out.push({ ...base, type: 'audio', mediaId: m.audio?.id, mimeType: m.audio?.mime_type });
        else out.push({ ...base, type: 'other' });
      }
    }
  }
  return out;
}

async function graph(path: string, init: RequestInit): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${path}`, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${token()}`, ...(init.headers ?? {}) } });
  } finally { clearTimeout(t); }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`WhatsApp Graph ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

// Envoie un message texte (tronqué à la limite WhatsApp).
export async function sendText(to: string, body: string): Promise<void> {
  if (!whatsappEnabled()) return;
  const text = (body ?? '').slice(0, 4096) || '…';
  await graph(`${phoneId()}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }),
  });
}

// Télécharge un média entrant (2 appels Graph : métadonnée -> URL -> binaire).
export async function downloadMedia(mediaId: string): Promise<{ dataBase64: string; mimeType: string }> {
  const meta = await graph(mediaId, { method: 'GET' });
  const url: string = meta.url;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  let res: Response;
  try { res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` }, signal: controller.signal }); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Error(`Téléchargement média WhatsApp ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { dataBase64: buf.toString('base64'), mimeType: meta.mime_type ?? 'image/jpeg' };
}
