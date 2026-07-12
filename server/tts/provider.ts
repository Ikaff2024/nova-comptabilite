// ============================================================================
// Synthèse vocale de Lexa — répartiteur multi-fournisseurs (ElevenLabs, OpenAI).
// Le propriétaire choisit le fournisseur + la voix par dossier (voir agent).
// Nettoyage du texte partagé. Le front bascule sur la voix du navigateur si
// aucun fournisseur n'est disponible/en échec.
// ============================================================================
import { elevenlabsEnabled, synthElevenLabs } from './elevenlabs.js';
import { openaiEnabled, synthOpenAI } from './openai.js';

export type TtsProvider = 'elevenlabs' | 'openai';

// Catalogue de voix proposées dans la page propriétaire (voix féminines posées).
export const VOICE_CATALOG: Record<TtsProvider, { id: string; name: string; desc: string }[]> = {
  elevenlabs: [
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', desc: 'Posée, rassurante' },
    { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', desc: 'Professionnelle' },
    { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', desc: 'Claire, pédagogue' },
    { id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Bella', desc: 'Lumineuse, chaleureuse' },
    { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', desc: 'Douce, veloutée' },
  ],
  openai: [
    { id: 'nova', name: 'Nova', desc: 'Posée, professionnelle' },
    { id: 'shimmer', name: 'Shimmer', desc: 'Claire, douce' },
    { id: 'coral', name: 'Coral', desc: 'Chaleureuse' },
    { id: 'sage', name: 'Sage', desc: 'Calme, mature' },
  ],
};

export function providersAvailable(): TtsProvider[] {
  const a: TtsProvider[] = [];
  if (elevenlabsEnabled()) a.push('elevenlabs');
  if (openaiEnabled()) a.push('openai');
  return a;
}

export function ttsEnabled(): boolean { return providersAvailable().length > 0; }

// Prépare le texte pour une lecture naturelle : retire markdown/emojis, développe
// devises et sigles. On garde les nombres (les moteurs les lisent bien).
export function cleanForTts(s: string): string {
  return (s || '')
    .replace(/\*\*/g, '').replace(/^#{1,4}\s+/gm, '')
    .replace(/^\s*[-•*]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\|/g, ', ').replace(/[_`>]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/gu, '')
    .replace(/\bSYSCOHADA\b/gi, 'Sisco-ada').replace(/\bOHADA\b/gi, 'Oada').replace(/\bAUDCIF\b/gi, 'Od-cif')
    .replace(/(\d)\s?[kK]\b/g, '$1 mille').replace(/(\d)\s?M\b/g, '$1 millions')
    .replace(/\bXOF\b/g, 'francs CFA').replace(/\bXAF\b/g, 'francs CFA').replace(/%/g, ' pour cent')
    .replace(/\n+/g, '. ').replace(/(\.\s*){2,}/g, '. ').replace(/[ \t]{2,}/g, ' ')
    .trim().slice(0, 2500);
}

// Renvoie l'audio MP3 (Buffer) ou null si indisponible/en échec. Le fournisseur
// demandé est honoré s'il est disponible, sinon on prend le premier disponible.
export async function synthesize(text: string, provider?: TtsProvider, voiceId?: string): Promise<Buffer | null> {
  const clean = cleanForTts(text);
  if (!clean) return null;
  const avail = providersAvailable();
  if (!avail.length) return null;
  const p: TtsProvider = provider && avail.includes(provider) ? provider : avail[0];
  return p === 'openai' ? synthOpenAI(clean, voiceId) : synthElevenLabs(clean, voiceId);
}
