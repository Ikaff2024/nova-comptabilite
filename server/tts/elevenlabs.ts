// Fournisseur de synthèse vocale ElevenLabs. Reçoit un texte déjà nettoyé.
const apiKey = () => process.env.ELEVENLABS_API_KEY ?? '';
const model = () => process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';
export const DEFAULT_VOICE = 'hpp4J3VqNfWAUOO0d1Us'; // « Bella » (retenue comme la plus naturelle)

export function elevenlabsEnabled(): boolean { return !!apiKey(); }

export async function synthElevenLabs(text: string, voiceId?: string): Promise<Buffer | null> {
  if (!apiKey()) return null;
  const vid = voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model(), voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true } }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; } finally { clearTimeout(t); }
}
