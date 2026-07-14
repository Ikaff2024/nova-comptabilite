import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Gauge, ClipboardCheck, CheckCircle2, TrendingUp } from 'lucide-react';
import { api, fmtMoney, type DossierAlerts, type FinancialRatios, type CoherenceReport } from '../lib/api';
import { cn } from '../lib/utils';

// Analyse & révision : alertes, ratios financiers et contrôles de cohérence.
// Surface UI des moteurs d'analyse (aussi accessibles à Lexa).

const NIV_BADGE: Record<string, string> = {
  haute: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  moyenne: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
};
const NIV_DOT: Record<string, string> = { haute: 'bg-rose-400', moyenne: 'bg-amber-400', info: 'bg-sky-400' };
const RATIO_COLOR: Record<string, string> = { bon: 'text-emerald-400', moyen: 'text-amber-400', faible: 'text-rose-400' };

export default function AnalyseFinanciere({ dossierId, currency }: { dossierId: string; currency: string }) {
  const [alerts, setAlerts] = useState<DossierAlerts | null>(null);
  const [ratios, setRatios] = useState<FinancialRatios | null>(null);
  const [controls, setControls] = useState<CoherenceReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let on = true; setLoading(true);
    Promise.allSettled([api.dossierAlerts(dossierId), api.dossierRatios(dossierId), api.dossierControls(dossierId)])
      .then(([a, r, c]) => { if (!on) return; if (a.status === 'fulfilled') setAlerts(a.value); if (r.status === 'fulfilled') setRatios(r.value); if (c.status === 'fulfilled') setControls(c.value); setLoading(false); });
    return () => { on = false; };
  }, [dossierId]);

  const m = (n: number) => fmtMoney(n, currency);
  const fmtRatio = (v: number | null, unite: string) => v == null ? '—' : unite === 'pourcent' ? `${v} %` : unite === 'jours' ? `${v} j` : unite === 'montant' ? m(v) : String(v);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Analyse en cours…</div>;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display text-2xl font-bold tracking-tight">Analyse & révision</h2>
        <p className="mt-1 text-sm text-zinc-400">Points d'attention, ratios financiers et contrôles de cohérence — les mêmes analyses que Lexa peut restituer.</p>
      </div>

      {/* Alertes */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><AlertTriangle className="h-4 w-4 text-amber-400" /> Points d'attention {alerts && <span className="text-xs font-normal text-zinc-500">({alerts.resume.total})</span>}</div>
        {!alerts || alerts.alertes.length === 0 ? (
          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-400"><CheckCircle2 className="h-4 w-4 text-emerald-400" /> Rien à signaler dans l'immédiat.</div>
        ) : (
          <div className="space-y-2">
            {alerts.alertes.map((a, i) => (
              <div key={i} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-3">
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', NIV_DOT[a.niveau])} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{a.titre}</span>
                    {a.montant != null && <span className="font-mono text-sm text-zinc-300">{m(a.montant)}</span>}
                    {a.echeance && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-zinc-300">échéance {a.echeance}</span>}
                  </div>
                  {a.detail && <div className="text-xs text-zinc-500">{a.detail}</div>}
                </div>
                <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px]', NIV_BADGE[a.niveau])}>{a.niveau}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Ratios financiers */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Gauge className="h-4 w-4 text-emerald-400" /> Ratios financiers {ratios && <span className="text-xs font-normal text-zinc-500">· CA {m(ratios.chiffreAffaires)}</span>}</div>
        {!ratios ? <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-500">Indisponible (états financiers requis).</div> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ratios.ratios.map((r) => (
                <div key={r.cle} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-300">{r.libelle}</span>
                    <span className={cn('font-display text-lg font-bold', r.niveau ? RATIO_COLOR[r.niveau] : 'text-white')}>{fmtRatio(r.valeur, r.unite)}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">{r.formule}</div>
                  {r.commentaire && <div className="mt-1 text-[11px] leading-tight text-zinc-500">{r.commentaire}</div>}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm">
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500"><TrendingUp className="h-3.5 w-3.5" /> Grandes masses</div>
              {[['Fonds de roulement', 'fondsRoulement'], ['BFR', 'bfr'], ['Trésorerie nette', 'tresorerieNette'], ['Capitaux propres', 'capitauxPropres']].map(([lbl, key]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-zinc-400">{lbl} :</span>
                  <span className={cn('font-mono', (ratios.soldes[key] ?? 0) < 0 ? 'text-rose-400' : 'text-zinc-200')}>{m(ratios.soldes[key] ?? 0)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* Contrôles de cohérence */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><ClipboardCheck className="h-4 w-4 text-sky-400" /> Contrôles de cohérence {controls && <span className="text-xs font-normal text-zinc-500">({controls.nbComptesAnalyses} comptes analysés)</span>}</div>
        {!controls || controls.anomalies.length === 0 ? (
          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-400"><CheckCircle2 className="h-4 w-4 text-emerald-400" /> Aucune incohérence détectée sur les soldes.</div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                <th className="px-4 py-2.5 font-medium">Compte</th>
                <th className="px-4 py-2.5 font-medium">Anomalie</th>
                <th className="px-4 py-2.5 text-right font-medium">Solde</th>
                <th className="px-4 py-2.5 font-medium">Niveau</th>
              </tr></thead>
              <tbody className="divide-y divide-white/5">
                {controls.anomalies.map((a, i) => (
                  <tr key={i} className="hover:bg-white/5">
                    <td className="px-4 py-2.5"><span className="font-mono text-zinc-300">{a.compte}</span> <span className="text-zinc-500">{a.intitule}</span></td>
                    <td className="px-4 py-2.5 text-zinc-400">{a.explication}</td>
                    <td className={cn('px-4 py-2.5 text-right font-mono', a.solde < 0 ? 'text-rose-400' : 'text-zinc-300')}>{m(a.solde)} <span className="text-[11px] text-zinc-500">{a.sens}</span></td>
                    <td className="px-4 py-2.5"><span className={cn('rounded-full border px-2 py-0.5 text-[11px]', NIV_BADGE[a.niveau])}>{a.niveau}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
