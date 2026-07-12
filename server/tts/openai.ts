// Fournisseur de synthèse vocale OpenAI (endpoint /v1/audio/speech).
// Activé par OPENAI_API_KEY. Reçoit un texte déjà nettoyé.
const apiKey = () => process.env.OPENAI_API_KEY ?? '';
const model = () => process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
export const DEFAULT_VOICE = 'nova'; // voix féminine par défaut

export function openaiEnabled(): boolean { return !!apiKey(); }

export async function synthOpenAI(text: string, voiceId?: string): Promise<Buffer | null> {
  if (!apiKey()) return null;
  const voice = voiceId || process.env.OPENAI_TTS_VOICE || DEFAULT_VOICE;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model(), voice, input: text, response_format: 'mp3' }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; } finally { clearTimeout(t); }
}
