import React, { useEffect, useState } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Loader2, RotateCcw, TrendingUp, Wallet, Landmark, ArrowDownRight, ArrowUpRight, Sparkles, AlertTriangle, Info, Receipt, Building2, FileText } from 'lucide-react';
import { api, fmtMoney, downloadAuthed, type DossierDashboard as DashData } from '../lib/api';
import { cn } from '../lib/utils';

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Saisie', ocr: 'Capture IA', mobile_money: 'Mobile Money', bank_import: 'Import', recurring: 'Récurrente', api: 'API', opening_balance: 'À-nouveaux',
};

export default function DossierDashboard({ dossierId, currency, onNavigate }: { dossierId: string; currency: string; onNavigate?: (tab: string) => void }) {
  const [d, setD] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async () => { setLoading(true); try { setD(await api.dossierDashboard(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const m = (n: number) => fmtMoney(n, currency);
  const short = (n: number) => {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1) + ' Md';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + ' M';
    if (a >= 1e3) return Math.round(n / 1e3) + ' k';
    return String(Math.round(n));
  };
  const monthLabel = (ym: string) => { const [, mm] = ym.split('-'); return ['', 'jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'][Number(mm)]; };

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul du tableau de bord…</div>;
  if (!d) return null;

  const chart = d.monthly.map((r) => ({ ...r, label: monthLabel(r.month) }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-zinc-400">Synthèse{d.fiscalYear ? ` · ${d.fiscalYear.label}` : ''}</div>
        <div className="flex items-center gap-2">
          <button onClick={() => downloadAuthed(`/api/dossiers/${dossierId}/activity-report`, 'rapport-activite.pdf')} title="Rapport d'activité du mois préparé par Lexa" className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20"><FileText className="h-4 w-4" /> Rapport d'activité</button>
          <button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10"><RotateCcw className="h-4 w-4" /> Actualiser</button>
        </div>
      </div>

      {/* Alertes */}
      {d.alerts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {d.alerts.map((a, i) => (
            <button key={i} onClick={() => a.tab && onNavigate?.(a.tab)}
              className={cn('flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
                a.level === 'warn' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-sky-500/30 bg-sky-500/10 text-sky-300',
                a.tab && 'hover:brightness-125')}>
              {a.level === 'warn' ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />} {a.message}
            </button>
          ))}
        </div>
      )}

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi icon={TrendingUp} label="Résultat" value={m(d.kpis.resultat)} tone={d.kpis.resultat >= 0 ? 'pos' : 'neg'} />
        <Kpi icon={Sparkles} label="Chiffre d'affaires" value={m(d.kpis.chiffreAffaires)} />
        <Kpi icon={Wallet} label="Trésorerie" value={m(d.kpis.tresorerie)} tone={d.kpis.tresorerie >= 0 ? 'pos' : 'neg'} />
        <Kpi icon={ArrowUpRight} label="Créances clients" value={m(d.kpis.creances)} />
        <Kpi icon={ArrowDownRight} label="Dettes fournisseurs" value={m(d.kpis.dettesFrs)} />
        <Kpi icon={Building2} label="VNC immobilisations" value={m(d.kpis.vncTotal)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Tendance */}
        <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm text-zinc-300"><TrendingUp className="h-4 w-4 text-emerald-400" /> Produits, charges & résultat (12 mois)</div>
          {chart.length === 0 ? <p className="py-10 text-center text-sm text-zinc-500">Pas encore de mouvements.</p> : (
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chart} margin={{ top: 5, right: 5, left: 5, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: '#a1a1aa', fontSize: 12 }} axisLine={{ stroke: '#ffffff20' }} tickLine={false} />
                <YAxis tickFormatter={short} tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: '#18181b', border: '1px solid #ffffff20', borderRadius: 12, fontSize: 12 }}
                  labelStyle={{ color: '#e4e4e7' }} formatter={(v: any, n: any) => [m(Number(v)), n]} />
                <Bar dataKey="produits" name="Produits" fill="#34d399" radius={[3, 3, 0, 0]} maxBarSize={18} />
                <Bar dataKey="charges" name="Charges" fill="#fb7185" radius={[3, 3, 0, 0]} maxBarSize={18} />
                <Line dataKey="resultat" name="Résultat" stroke="#38bdf8" strokeWidth={2} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* TVA + activité */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm text-zinc-300"><Receipt className="h-4 w-4 text-emerald-400" /> TVA du mois ({d.vat.period})</div>
            <div className="space-y-1 text-sm">
              <Row label="Collectée (443)" value={m(d.vat.collectee)} />
              <Row label="Déductible (445)" value={m(d.vat.deductible)} />
              <div className="mt-1 border-t border-white/10 pt-1">
                <Row label={d.vat.netDue > 0 ? 'À payer (4441)' : 'Crédit reportable'} value={m(d.vat.netDue || d.vat.creditReportable)} strong tone={d.vat.netDue > 0 ? 'neg' : 'pos'} />
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="mb-2 text-sm text-zinc-300">Activité</div>
            <div className="space-y-1 text-sm">
              <Row label="Écritures comptabilisées" value={String(d.activity.posted)} />
              <Row label="Ce mois-ci" value={String(d.activity.thisMonth)} />
              <Row label="Brouillons" value={String(d.activity.drafts)} />
              <Row label="Automatisation" value={`${d.activity.autoPct} %`} tone="pos" />
            </div>
          </div>
        </div>
      </div>

      {/* Top tiers + activité récente */}
      <div className="grid gap-4 lg:grid-cols-3">
        <TopList title="Top clients (créances)" icon={ArrowUpRight} rows={d.topClients} empty="Aucun client débiteur." m={m} />
        <TopList title="Top fournisseurs (dettes)" icon={ArrowDownRight} rows={d.topFournisseurs} empty="Aucun fournisseur créditeur." m={m} />
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="mb-2 text-sm text-zinc-300">Dernières écritures</div>
          {d.recent.length === 0 ? <p className="text-sm text-zinc-500">Aucune écriture.</p> : (
            <ul className="space-y-1.5 text-sm">
              {d.recent.map((r, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-zinc-300"><span className="font-mono text-xs text-zinc-500">{r.piece_ref}</span> {r.description}</span>
                  <span className="whitespace-nowrap font-mono text-xs text-zinc-400">{m(r.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
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

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'pos' | 'neg' }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-400">{label}</span>
      <span className={cn('font-mono', strong && 'font-bold', tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-amber-400' : 'text-zinc-200')}>{value}</span>
    </div>
  );
}

function TopList({ title, icon: Icon, rows, empty, m }: { title: string; icon: any; rows: { name: string; amount: number }[]; empty: string; m: (n: number) => string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm text-zinc-300"><Icon className="h-4 w-4 text-zinc-400" /> {title}</div>
      {rows.length === 0 ? <p className="text-sm text-zinc-500">{empty}</p> : (
        <ul className="space-y-1.5 text-sm">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-zinc-300">{r.name}</span>
              <span className="whitespace-nowrap font-mono text-xs text-zinc-400">{m(r.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
