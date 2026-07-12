// ============================================================================
// Synthèse vocale serveur (ElevenLabs) pour Lexa. Voix féminine posée et
// crédible, prononciation naturelle des montants FCFA — nettement au-dessus de
// la synthèse du navigateur. Activée par ELEVENLABS_API_KEY. Le front bascule
// automatiquement sur la voix du navigateur si ce canal est absent/en échec.
// ============================================================================

const apiKey = () => process.env.ELEVENLABS_API_KEY ?? '';
// Voix par défaut : « Sarah » (féminine, posée, rassurante) — voix « premade »
// accessible même en offre gratuite. Surchargée par ELEVENLABS_VOICE_ID.
const voiceId = () => process.env.ELEVENLABS_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL';
const modelId = () => process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';

export function ttsEnabled(): boolean {
  return !!apiKey();
}

// Prépare le texte pour une lecture naturelle : retire le markdown et les
// emojis, développe la devise. On garde les nombres tels quels — ElevenLabs
// les lit correctement (contrairement à la synthèse du navigateur).
export function cleanForTts(s: string): string {
  return (s || '')
    .replace(/\*\*/g, '').replace(/^#{1,4}\s+/gm, '')
    .replace(/^\s*[-•*]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\|/g, ', ').replace(/[_`>]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/gu, '')
    .replace(/\bXOF\b/g, 'francs CFA').replace(/\bXAF\b/g, 'francs CFA').replace(/%/g, ' pour cent')
    .replace(/\n+/g, '. ').replace(/(\.\s*){2,}/g, '. ').replace(/[ \t]{2,}/g, ' ')
    .trim().slice(0, 2500); // borne le coût par requête
}

// Renvoie l'audio MP3 (Buffer) ou null si le canal est indisponible/en échec.
export async function synthesize(text: string): Promise<Buffer | null> {
  if (!ttsEnabled()) return null;
  const clean = cleanForTts(text);
  if (!clean) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId()}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: clean,
        model_id: modelId(),
        voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; } finally { clearTimeout(t); }
}
