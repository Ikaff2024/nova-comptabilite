import React, { useEffect, useState } from 'react';
import { Loader2, Gauge, Bot, Mic, Mail, Radio } from 'lucide-react';
import { api, type UsageSummary } from '../lib/api';
import { cn } from '../lib/utils';

// Suivi des coûts d'API par client (page propriétaire). Coûts estimés en USD.
const PERIODS = [
  { d: 7, l: '7 j' }, { d: 30, l: '30 j' }, { d: 90, l: '90 j' }, { d: 365, l: '12 mois' },
];
const PROVIDER_ICON: Record<string, any> = { anthropic: Bot, elevenlabs: Mic, openai_tts: Mic, whisper: Radio, resend: Mail };
const PROVIDER_COLOR: Record<string, string> = {
  anthropic: 'bg-emerald-500', elevenlabs: 'bg-sky-500', openai_tts: 'bg-violet-500', whisper: 'bg-amber-500', resend: 'bg-pink-500',
};
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default function ApiCosts() {
  const [days, setDays] = useState(30);
  const [u, setU] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { let on = true; setLoading(true); api.usage(days).then((x) => { if (on) { setU(x); setLoading(false); } }); return () => { on = false; }; }, [days]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Gauge className="h-4 w-4 text-emerald-400" /> Coûts d'API par client <span className="text-xs text-zinc-500">(estimation USD)</span></div>
        <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
          {PERIODS.map((p) => (
            <button key={p.d} onClick={() => setDays(p.d)} className={cn('rounded-md px-3 py-1 text-xs', days === p.d ? 'bg-emerald-500 font-semibold text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>{p.l}</button>
          ))}
        </div>
      </div>

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : !u ? null : u.indisponible ? (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm text-zinc-500">Le suivi des coûts s'activera dès la prochaine mise à jour de la base.</div>
      ) : (
        <>
          {/* Total + répartition par service */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-5">
              <div className="text-sm text-zinc-400">Coût total · {u.days} j</div>
              <div className="mt-2 font-display text-3xl font-bold tracking-tight text-emerald-400">{usd(u.total.costUsd)}</div>
              <div className="mt-1 text-[11px] text-zinc-500">{u.total.appels} appel(s) facturable(s)</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:col-span-2">
              <div className="mb-3 text-sm text-zinc-300">Par service</div>
              {u.parProvider.length === 0 ? <div className="text-sm text-zinc-500">Aucune consommation sur la période.</div> : (
                <>
                  <div className="flex h-3 overflow-hidden rounded-full">
                    {u.parProvider.map((p) => (
                      <div key={p.provider} className={cn('h-full', PROVIDER_COLOR[p.provider] ?? 'bg-zinc-600')}
                        style={{ width: `${u.total.costUsd > 0 ? (p.cost / u.total.costUsd) * 100 : 0}%` }} title={`${p.label}: ${usd(p.cost)}`} />
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-zinc-400">
                    {u.parProvider.map((p) => {
                      const Icon = PROVIDER_ICON[p.provider] ?? Bot;
                      return (
                        <span key={p.provider} className="flex items-center gap-1.5">
                          <span className={cn('h-2 w-2 rounded-full', PROVIDER_COLOR[p.provider] ?? 'bg-zinc-600')} />
                          <Icon className="h-3.5 w-3.5 text-zinc-500" /> {p.label} · <span className="font-mono text-zinc-300">{usd(p.cost)}</span>
                        </span>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Détail par client */}
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 text-right font-medium">Lexa (IA)</th>
                <th className="px-4 py-3 text-right font-medium">Voix</th>
                <th className="px-4 py-3 text-right font-medium">Autres</th>
                <th className="px-4 py-3 text-right font-medium">Appels</th>
                <th className="px-4 py-3 text-right font-medium">Coût total</th>
              </tr></thead>
              <tbody className="divide-y divide-white/5">
                {u.dossiers.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-zinc-500">Aucune consommation sur la période.</td></tr>
                ) : u.dossiers.map((d) => {
                  const voix = (d.providers.elevenlabs ?? 0) + (d.providers.openai_tts ?? 0);
                  const autres = d.costUsd - (d.providers.anthropic ?? 0) - voix;
                  return (
                    <tr key={d.dossierId} className="hover:bg-white/5">
                      <td className="px-4 py-3 font-medium text-zinc-200">{d.raisonSociale}</td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-300">{usd(d.providers.anthropic ?? 0)}</td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-400">{usd(voix)}</td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-400">{usd(Math.max(0, autres))}</td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-500">{d.appels}</td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-emerald-400">{usd(d.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-zinc-500">Estimations basées sur les barèmes publics (Anthropic, ElevenLabs, OpenAI). Sert au pilotage de la marge par abonnement — à comparer au prix facturé au client.</p>
        </>
      )}
    </section>
  );
}
