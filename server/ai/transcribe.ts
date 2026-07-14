// Transcription audio (notes vocales) via OpenAI. Activé par OPENAI_API_KEY.
const apiKey = () => process.env.OPENAI_API_KEY ?? '';
const model = () => process.env.OPENAI_STT_MODEL ?? 'whisper-1';

export function transcribeEnabled(): boolean { return !!apiKey(); }

// Transcrit un buffer audio (OGG/Opus de Telegram, ou autre) en texte français.
export async function transcribeAudio(buffer: Buffer, filename = 'audio.ogg'): Promise<string | null> {
  if (!apiKey()) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 45000);
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: 'audio/ogg' }), filename);
    form.append('model', model());
    form.append('language', 'fr');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey()}` }, body: form, signal: controller.signal,
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return typeof j?.text === 'string' ? j.text.trim() : null;
  } catch { return null; } finally { clearTimeout(t); }
}
