import React, { useEffect, useState } from 'react';
import { Loader2, Building2, Activity, FolderKanban, BookOpen, Gauge, ShieldAlert } from 'lucide-react';
import { api, type PlatformOverview } from '../lib/api';
import { cn } from '../lib/utils';

// Console éditeur Nova : suivi transverse de tous les cabinets clients.
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const COUNTRY: Record<string, string> = {
  CI: "Côte d'Ivoire", SN: 'Sénégal', BJ: 'Bénin', BF: 'Burkina Faso', ML: 'Mali', TG: 'Togo', NE: 'Niger',
  GW: 'Guinée-Bissau', CM: 'Cameroun', GA: 'Gabon', CG: 'Congo', TD: 'Tchad', CF: 'Centrafrique',
  GQ: 'Guinée équ.', CD: 'RD Congo', GN: 'Guinée', KM: 'Comores',
};

function since(iso: string | null): string {
  if (!iso) return 'jamais';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  if (days < 30) return `il y a ${days} j`;
  if (days < 365) return `il y a ${Math.floor(days / 30)} mois`;
  return `il y a ${Math.floor(days / 365)} an(s)`;
}

export default function PlatformConsole() {
  const [d, setD] = useState<PlatformOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { let on = true; setLoading(true); api.platformOverview().then((x) => { if (on) { setD(x); setLoading(false); } }).catch((e) => { if (on) { setError(e.message); setLoading(false); } }); return () => { on = false; }; }, []);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>;
  if (error) return <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300"><ShieldAlert className="h-4 w-4" /> {error}</div>;
  if (!d) return null;

  const t = d.totals;
  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-emerald-400"><Gauge className="h-3.5 w-3.5" /> Console éditeur</div>
        <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">Nos cabinets clients</h1>
        <p className="mt-1 text-zinc-400">Vue transverse de la plateforme Nova — volumétrie, activité et coûts d'API par cabinet.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi icon={Building2} label="Cabinets" value={String(t.cabinets)} />
        <Kpi icon={Activity} label="Actifs (30 j)" value={String(t.actifs30j)} highlight
          hint={`${t.cabinets ? Math.round((t.actifs30j / t.cabinets) * 100) : 0}% du parc`} />
        <Kpi icon={FolderKanban} label="Dossiers" value={String(t.dossiers)} />
        <Kpi icon={BookOpen} label="Écritures" value={t.ecritures.toLocaleString('fr-FR')} />
        <Kpi icon={Gauge} label="Coût API · 30 j" value={usd(t.cost30d)} valueClass="text-amber-400"
          hint={`total cumulé ${usd(t.costTotal)}`} />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
            <th className="px-4 py-3 font-medium">Cabinet</th>
            <th className="px-4 py-3 font-medium">Pays</th>
            <th className="px-4 py-3 text-right font-medium">Dossiers</th>
            <th className="px-4 py-3 text-right font-medium">Membres</th>
            <th className="px-4 py-3 text-right font-medium">Écritures</th>
            <th className="px-4 py-3 text-right font-medium">Coût 30 j</th>
            <th className="px-4 py-3 text-right font-medium">Coût total</th>
            <th className="px-4 py-3 font-medium">Activité</th>
          </tr></thead>
          <tbody className="divide-y divide-white/5">
            {d.cabinets.map((c) => {
              const stale = !c.lastActivity || (Date.now() - new Date(c.lastActivity).getTime()) > 30 * 86400000;
              return (
                <tr key={c.cabinetId} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 font-medium text-zinc-200">{c.name}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{COUNTRY[c.country] ?? c.country}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{c.dossiers}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{c.membres}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{c.ecritures.toLocaleString('fr-FR')}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-amber-300/90">{usd(c.cost30d)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{usd(c.costTotal)}</td>
                  <td className={cn('px-4 py-2.5 text-xs', stale ? 'text-zinc-500' : 'text-emerald-400')}>{since(c.lastActivity)}</td>
                </tr>
              );
            })}
            {d.cabinets.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-zinc-500">Aucun cabinet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-500">Coûts d'API estimés (Anthropic, ElevenLabs, OpenAI). « Activité » = écriture ou appel d'API le plus récent. Vue réservée aux opérateurs Nova.</p>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, highlight, hint, valueClass }: {
  icon: any; label: string; value: string; highlight?: boolean; hint?: string; valueClass?: string;
}) {
  return (
    <div className={cn('relative overflow-hidden rounded-2xl border p-5', highlight ? 'border-emerald-500/30 bg-emerald-500/[0.07]' : 'border-white/10 bg-white/5')}>
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-400">{label}</span>
        <Icon className={cn('h-4 w-4', highlight ? 'text-emerald-400' : 'text-zinc-500')} />
      </div>
      <div className={cn('mt-3 font-display text-2xl font-bold tracking-tight', valueClass ?? (highlight ? 'text-emerald-400' : 'text-white'))}>{value}</div>
      {hint && <div className="mt-1 text-[11px] leading-tight text-zinc-500">{hint}</div>}
    </div>
  );
}
