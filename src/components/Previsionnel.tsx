import React, { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { Loader2, TrendingUp, Wallet, AlertTriangle, CalendarClock, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { api, fmtMoney, type CashForecast } from '../lib/api';
import { cn } from '../lib/utils';
import Echeancier from './Echeancier';

export default function Previsionnel({ dossierId, currency }: { dossierId: string; currency: string }) {
  const [view, setView] = useState<'prevision' | 'echeancier'>('prevision');
  const [data, setData] = useState<CashForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [delay, setDelay] = useState(30);
  const m = (n: number) => fmtMoney(n, currency);
  const short = (n: number) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));

  const load = async () => { setLoading(true); try { setData(await api.cashForecast(dossierId, 13, delay)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId, delay]);

  const toggle = (
    <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-0.5 text-sm">
      {([['prevision', 'Prévision de trésorerie'], ['echeancier', 'Échéancier']] as const).map(([k, label]) => (
        <button key={k} onClick={() => setView(k)} className={cn('rounded-lg px-3 py-1.5 font-medium transition-colors', view === k ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>{label}</button>
      ))}
    </div>
  );
  if (view === 'echeancier') return <div className="space-y-5">{toggle}<Echeancier dossierId={dossierId} currency={currency} /></div>;
  if (loading) return <div className="space-y-5">{toggle}<div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul du prévisionnel…</div></div>;
  if (!data) return null;

  const chart = data.weeks.map((w) => ({ label: w.weekStart.slice(5), balance: w.balance, net: w.net }));
  const risk = data.minBalance < 0;

  return (
    <div className="space-y-6">
      {toggle}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-300"><TrendingUp className="h-4 w-4 text-emerald-400" /> Prévisionnel de trésorerie · {data.horizonWeeks} semaines</div>
        <label className="flex items-center gap-2 text-sm text-zinc-400">Délai de règlement moyen
          <select value={delay} onChange={(e) => setDelay(Number(e.target.value))} className="rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1 text-sm outline-none">
            {[0, 15, 30, 45, 60, 90].map((d) => <option key={d} value={d}>{d} j</option>)}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi icon={Wallet} label="Trésorerie actuelle" value={m(data.currentCash)} tone={data.currentCash >= 0 ? 'pos' : 'neg'} />
        <Kpi icon={TrendingUp} label={`Solde projeté (${data.horizonWeeks} sem.)`} value={m(data.projectedBalance)} tone={data.projectedBalance >= 0 ? 'pos' : 'neg'} />
        <div className={cn('rounded-2xl border p-4', risk ? 'border-rose-500/30 bg-rose-500/10' : 'border-emerald-500/30 bg-emerald-500/10')}>
          <div className="flex items-center gap-2 text-xs text-zinc-400">{risk ? <AlertTriangle className="h-4 w-4" /> : <Wallet className="h-4 w-4" />} Plus bas solde projeté</div>
          <div className={cn('mt-2 font-mono text-lg font-bold', risk ? 'text-rose-400' : 'text-emerald-400')}>{m(data.minBalance)}</div>
          <div className="text-xs text-zinc-500">semaine du {data.minWeek}{risk ? ' · risque de tension' : ''}</div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="mb-3 text-sm text-zinc-300">Solde de trésorerie projeté</div>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={chart} margin={{ top: 5, right: 5, left: 5, bottom: 0 }}>
            <defs><linearGradient id="bal" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#34d399" stopOpacity={0.35} /><stop offset="100%" stopColor="#34d399" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={{ stroke: '#ffffff20' }} tickLine={false} />
            <YAxis tickFormatter={short} tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #ffffff20', borderRadius: 12, fontSize: 12 }} labelStyle={{ color: '#e4e4e7' }} formatter={(v: any) => [m(Number(v)), 'Solde']} />
            <ReferenceLine y={0} stroke="#fb7185" strokeDasharray="4 4" />
            <Area dataKey="balance" stroke="#34d399" strokeWidth={2} fill="url(#bal)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="mb-2 text-sm text-zinc-300">Mouvements attendus</div>
          {data.upcoming.length === 0 ? <p className="text-sm text-zinc-500">Aucun mouvement attendu — pas de créance/dette non lettrée ni de récurrence.</p> : (
            <ul className="divide-y divide-white/5 text-sm">
              {data.upcoming.map((f, i) => (
                <li key={i} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {f.amount >= 0 ? <ArrowUpRight className="h-4 w-4 shrink-0 text-emerald-400" /> : <ArrowDownRight className="h-4 w-4 shrink-0 text-rose-400" />}
                    <span className="font-mono text-xs text-zinc-500">{f.date}</span>
                    <span className="truncate text-zinc-300">{f.label}</span>
                  </span>
                  <span className={cn('whitespace-nowrap font-mono', f.amount >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{f.amount >= 0 ? '+' : ''}{m(f.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm text-zinc-300"><CalendarClock className="h-4 w-4 text-amber-400" /> Échéances déclaratives</div>
          {data.events.length === 0 ? <p className="text-sm text-zinc-500">Aucune obligation dans l'horizon.</p> : (
            <ul className="space-y-1.5 text-sm">
              {data.events.map((e, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="truncate text-zinc-300">{e.label}</span>
                  <span className="whitespace-nowrap font-mono text-xs text-amber-300">{e.date}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-zinc-500">Hypothèse : créances/dettes non lettrées encaissées/payées {data.delayDays} jours après leur date d'écriture ; récurrences actives projetées ; obligations sans montant.</p>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2 text-xs text-zinc-400"><Icon className="h-4 w-4" /> {label}</div>
      <div className={cn('mt-2 font-mono text-lg font-bold', tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-100')}>{value}</div>
    </div>
  );
}
