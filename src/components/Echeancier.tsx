import React, { useEffect, useState } from 'react';
import { Loader2, ArrowDownRight, ArrowUpRight, AlertTriangle } from 'lucide-react';
import { api, fmtMoney, type Echeancier as EcheancierData, type EcheanceItem } from '../lib/api';
import { cn } from '../lib/utils';

// Échéancier : créances à encaisser + dettes à payer, par date d'échéance.
export default function Echeancier({ dossierId, currency }: { dossierId: string; currency: string }) {
  const [data, setData] = useState<EcheancierData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const m = (n: number) => fmtMoney(n, currency);
  useEffect(() => { setLoading(true); api.echeancier(dossierId).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [dossierId]);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement de l'échéancier…</div>;
  if (error) return <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>;
  if (!data) return null;
  const r = data.resume;

  const Table = ({ title, items, kind }: { title: string; items: EcheanceItem[]; kind: 'creance' | 'dette' }) => (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          {kind === 'creance' ? <ArrowUpRight className="h-4 w-4 text-emerald-400" /> : <ArrowDownRight className="h-4 w-4 text-rose-400" />} {title}
        </span>
        <span className="font-mono text-sm text-zinc-300">{m(items.reduce((s, x) => s + x.montant, 0))}</span>
      </div>
      {items.length === 0 ? <p className="px-4 py-4 text-sm text-zinc-500">Rien à {kind === 'creance' ? 'encaisser' : 'payer'}.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500"><tr className="border-b border-white/10">
            <th className="px-4 py-2 font-medium">{kind === 'creance' ? 'Client' : 'Fournisseur'}</th><th className="px-4 py-2 font-medium">Pièce</th>
            <th className="px-4 py-2 font-medium">Échéance</th><th className="px-4 py-2 font-medium">Statut</th><th className="px-4 py-2 text-right font-medium">Montant</th>
          </tr></thead>
          <tbody className="divide-y divide-white/5">
            {items.map((x, i) => (
              <tr key={i} className="hover:bg-white/5">
                <td className="px-4 py-2 text-zinc-200">{x.tiers}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-500">{x.piece || '—'}</td>
                <td className="px-4 py-2 text-zinc-400">{x.echeance || '—'}</td>
                <td className={cn('px-4 py-2 text-xs', x.echu ? 'text-rose-400' : x.jours != null && x.jours <= 7 ? 'text-amber-400' : 'text-zinc-400')}>{x.statut}</td>
                <td className="px-4 py-2 text-right font-mono text-zinc-100">{m(x.montant)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi label="À encaisser" value={m(r.total_a_encaisser)} sub={r.creances_echues ? `dont ${m(r.creances_echues)} échu` : 'à jour'} tone="pos" />
        <Kpi label="À payer" value={m(r.total_a_payer)} sub={r.dettes_echues ? `dont ${m(r.dettes_echues)} échu` : 'à jour'} tone="neg" />
        <Kpi label="Sous 30 jours (net)" value={m(r.solde_net_30j)} sub={`+${m(r.a_encaisser_30j)} / −${m(r.a_payer_30j)}`} tone={r.solde_net_30j >= 0 ? 'pos' : 'neg'} highlight />
        <Kpi label="Échu (créances)" value={m(r.creances_echues)} sub={r.creances_echues ? 'à relancer' : '—'} tone={r.creances_echues ? 'neg' : undefined} />
      </div>
      {(r.creances_echues > 0 || r.dettes_echues > 0) && (
        <p className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300"><AlertTriangle className="h-4 w-4" /> {r.creances_echues > 0 && `${m(r.creances_echues)} de créances échues à relancer`}{r.creances_echues > 0 && r.dettes_echues > 0 && ' · '}{r.dettes_echues > 0 && `${m(r.dettes_echues)} de dettes échues à régler`}.</p>
      )}
      <Table title="Créances à encaisser (ventes)" items={data.creances} kind="creance" />
      <Table title="Dettes à payer (achats)" items={data.dettes} kind="dette" />
    </div>
  );
}

function Kpi({ label, value, sub, tone, highlight }: { label: string; value: string; sub?: string; tone?: 'pos' | 'neg'; highlight?: boolean }) {
  return (
    <div className={cn('rounded-2xl border p-4', highlight ? 'border-emerald-500/40 bg-emerald-500/[0.07]' : 'border-white/10 bg-white/5')}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cn('mt-1 font-mono text-lg font-bold', tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-100')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}
