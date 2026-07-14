// ============================================================================
// Canal Telegram via Bot API. Réception par webhook, envoi via sendMessage.
// Le token du bot (@BotFather) active le canal. Un secret de webhook optionnel
// (TELEGRAM_WEBHOOK_SECRET) est vérifié via l'en-tête X-Telegram-Bot-Api-Secret-Token.
// ============================================================================

const token = () => process.env.TELEGRAM_BOT_TOKEN ?? '';
const secret = () => process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

export function telegramEnabled(): boolean {
  return !!token();
}

// Sans secret configuré, on ne bloque pas (phase d'intégration).
export function verifySecret(header?: string): boolean {
  if (!secret()) return true;
  return header === secret();
}

export interface TelegramUpdate { chatId: string; text: string; firstName?: string; voiceFileId?: string }

export function parseUpdate(body: any): TelegramUpdate | null {
  const msg = body?.message ?? body?.edited_message;
  const chatId = msg?.chat?.id;
  if (chatId == null) return null;
  const voiceFileId = msg?.voice?.file_id ?? msg?.audio?.file_id ?? undefined;
  return { chatId: String(chatId), text: String(msg?.text ?? ''), firstName: msg?.from?.first_name, voiceFileId };
}

// Télécharge un fichier Telegram (note vocale) et renvoie ses octets.
export async function downloadFile(fileId: string): Promise<Buffer | null> {
  if (!token()) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token()}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const j: any = await r.json();
    const path = j?.result?.file_path;
    if (!path) return null;
    const f = await fetch(`https://api.telegram.org/file/bot${token()}/${path}`);
    if (!f.ok) return null;
    return Buffer.from(await f.arrayBuffer());
  } catch { return null; }
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  if (!telegramEnabled()) return;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    await fetch(`https://api.telegram.org/bot${token()}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: controller.signal,
    });
  } catch { /* best-effort */ } finally { clearTimeout(t); }
}
