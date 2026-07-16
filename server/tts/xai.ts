// Fournisseur de synthèse vocale xAI (Grok TTS). Reçoit un texte déjà nettoyé.
// Endpoint POST https://api.x.ai/v1/tts — auth Bearer, sortie MP3, français
// supporté (language: 'fr'). optimize_streaming_latency réduit le délai avant
// le premier son.
const apiKey = () => process.env.XAI_API_KEY ?? '';
export const DEFAULT_VOICE = 'eve';

export function xaiEnabled(): boolean { return !!apiKey(); }

export async function synthXai(text: string, voiceId?: string): Promise<Buffer | null> {
  if (!apiKey()) return null;
  const vid = voiceId || process.env.XAI_TTS_VOICE || DEFAULT_VOICE;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey()}`, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: text.slice(0, 15000),
        voice_id: vid,
        language: 'fr',
        speed: 1.0,
        optimize_streaming_latency: 2,               // 0-2 : minimise le délai avant le 1er son
        output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; } finally { clearTimeout(t); }
}
