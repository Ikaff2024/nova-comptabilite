import React, { useEffect, useState } from 'react';
import { Loader2, Gauge, TrendingUp, Banknote, CheckCircle2, XCircle, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type CreditScore } from '../lib/api';
import { cn } from '../lib/utils';

const RATING_COLOR: Record<string, string> = { A: '#34d399', B: '#a3e635', C: '#fbbf24', D: '#fb7185' };

export default function Scoring({ dossierId, currency, fiscalYears }: { dossierId: string; currency: string; fiscalYears: FiscalYear[] }) {
  const [fy, setFy] = useState(fiscalYears[0]?.id ?? '');
  const [data, setData] = useState<CreditScore | null>(null);
  const [loading, setLoading] = useState(true);
  const m = (n: number) => fmtMoney(n, currency);

  const load = async () => { setLoading(true); try { setData(await api.creditScore(dossierId, fy || undefined)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId, fy]);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul du score…</div>;
  if (!data) return null;
  const color = RATING_COLOR[data.rating] ?? '#a1a1aa';
  const circ = 2 * Math.PI * 52;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-300"><Gauge className="h-4 w-4 text-emerald-400" /> Santé financière & financement</div>
        <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
          {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Jauge de score */}
        <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="relative h-32 w-32">
            <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
              <circle cx="60" cy="60" r="52" fill="none" stroke="#ffffff14" strokeWidth="12" />
              <circle cx="60" cy="60" r="52" fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
                strokeDasharray={circ} strokeDashoffset={circ * (1 - data.score / 100)} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-3xl font-bold text-zinc-50">{data.score}</span>
              <span className="text-xs text-zinc-500">/ 100</span>
            </div>
          </div>
          <div className="mt-3 rounded-full px-4 py-1 text-lg font-bold" style={{ background: `${color}22`, color }}>Note {data.rating}</div>
        </div>

        {/* Axes */}
        <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="mb-3 text-sm text-zinc-300">Détail par axe</div>
          <div className="space-y-3">
            {data.axes.map((a) => (
              <div key={a.key}>
                <div className="mb-1 flex items-center justify-between text-sm"><span className="text-zinc-300">{a.label} <span className="text-xs text-zinc-500">· pond. {Math.round(a.weight * 100)}%</span></span><span className="font-mono text-zinc-200">{a.score}</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full transition-all" style={{ width: `${a.score}%`, background: a.score >= 70 ? '#34d399' : a.score >= 50 ? '#fbbf24' : '#fb7185' }} /></div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-4 text-xs">
            {data.strengths.length > 0 && <span className="flex items-center gap-1.5 text-emerald-400"><ArrowUpRight className="h-3.5 w-3.5" /> Points forts : {data.strengths.join(', ')}</span>}
            {data.weaknesses.length > 0 && <span className="flex items-center gap-1.5 text-rose-400"><ArrowDownRight className="h-3.5 w-3.5" /> À renforcer : {data.weaknesses.join(', ')}</span>}
          </div>
        </div>
      </div>

      {/* Offre de financement */}
      <div className={cn('rounded-2xl border p-5', data.financing.eligible ? 'border-emerald-500/30 bg-emerald-500/[0.08]' : 'border-white/10 bg-white/5')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {data.financing.eligible ? <CheckCircle2 className="h-6 w-6 text-emerald-400" /> : <XCircle className="h-6 w-6 text-zinc-500" />}
            <div>
              <div className="flex items-center gap-2 font-semibold text-zinc-100"><Banknote className="h-4 w-4 text-emerald-400" /> Finance embarquée — avance de trésorerie</div>
              <p className="mt-0.5 max-w-2xl text-sm text-zinc-400">{data.financing.note}</p>
            </div>
          </div>
          {data.financing.eligible && <div className="text-right"><div className="text-xs text-zinc-400">Montant indicatif</div><div className="font-mono text-2xl font-bold text-emerald-400">{m(data.financing.amount)}</div></div>}
        </div>
      </div>

      {/* Indicateurs clés */}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Metric label="Trésorerie" value={m(data.metrics.tresorerie)} />
        <Metric label="Résultat" value={m(data.metrics.resultat)} />
        <Metric label="Chiffre d'affaires" value={m(data.metrics.ca)} />
        <Metric label="CA mensuel moyen" value={m(data.metrics.caMensuel)} />
        <Metric label="Créances clients" value={m(data.metrics.creances)} />
        <Metric label="Capitaux propres" value={m(data.metrics.capitauxPropres)} />
        <Metric label="Dettes financières" value={m(data.metrics.dettesFin)} />
        <Metric label="Créances > 90 j" value={m(data.metrics.overdue90)} tone={data.metrics.overdue90 > 0 ? 'warn' : undefined} />
      </div>
      <p className="flex items-center gap-1.5 text-xs text-zinc-500"><TrendingUp className="h-3.5 w-3.5" /> Score indicatif calculé à partir de la comptabilité (rentabilité, autonomie, trésorerie, recouvrement, croissance). Non contractuel.</p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={cn('mt-1 font-mono text-sm font-semibold', tone === 'warn' ? 'text-amber-400' : 'text-zinc-100')}>{value}</div>
    </div>
  );
}
