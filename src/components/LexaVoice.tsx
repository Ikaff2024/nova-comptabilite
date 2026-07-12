import React, { useState } from 'react';
import { Volume2, Loader2 } from 'lucide-react';
import { api, type VoiceConfig } from '../lib/api';

const PROVIDER_LABEL: Record<string, string> = { elevenlabs: 'ElevenLabs', openai: 'OpenAI' };

export default function LexaVoice({ dossierId, voice, onChange }: { dossierId: string; voice: VoiceConfig; onChange: (v: { provider: string; voiceId: string | null }) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const provider = voice.provider;
  const voices = voice.catalog[provider] ?? [];

  const save = async (nextProvider: string, nextVoice: string | null) => {
    setBusy(true); setErr(null);
    try { const r = await api.setLexaVoice(dossierId, nextProvider, nextVoice); onChange(r); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Volume2 className="h-4 w-4 text-emerald-400" /> Voix de Lexa {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}</div>

      {voice.providers.length === 0 ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Aucun fournisseur de voix configuré côté serveur (<span className="font-mono">ELEVENLABS_API_KEY</span> ou <span className="font-mono">OPENAI_API_KEY</span>). Lexa utilise la voix du navigateur en attendant.</p>
      ) : (
        <>
          <div>
            <div className="mb-1.5 text-xs text-zinc-500">Fournisseur</div>
            <div className="flex flex-wrap gap-2">
              {voice.providers.map((p) => (
                <button key={p} onClick={() => save(p, null)} disabled={busy}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${p === provider ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-white/10 bg-white/5 text-zinc-300 hover:text-zinc-100'}`}>
                  {PROVIDER_LABEL[p] ?? p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs text-zinc-500">Voix</div>
            <div className="flex flex-wrap gap-2">
              {voices.map((v) => {
                const active = voice.voiceId === v.id || (voice.voiceId == null && voices[0]?.id === v.id);
                return (
                  <button key={v.id} onClick={() => save(provider, v.id)} disabled={busy} title={v.desc}
                    className={`rounded-lg border px-3 py-1.5 text-sm ${active ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-white/10 bg-white/5 text-zinc-300 hover:text-zinc-100'}`}>
                    {v.name} <span className="text-zinc-500">· {v.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-zinc-500">Le choix s'applique à ce dossier. Activez le haut-parleur et posez une question pour l'entendre.</p>
        </>
      )}
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400">{err}</p>}
    </div>
  );
}
