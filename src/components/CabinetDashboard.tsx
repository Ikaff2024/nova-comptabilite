import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Building2, Sparkles, CalendarDays, TrendingUp, ChevronRight, AlertTriangle, Bot } from 'lucide-react';
import { api, fmtMoney, type DashboardData, type CabinetTriage } from '../lib/api';
import { cn } from '../lib/utils';

const SOURCE_COLOR: Record<string, string> = {
  'Capture IA': 'bg-emerald-500', 'Mobile Money': 'bg-sky-500', 'Manuelle': 'bg-zinc-500',
  'Import bancaire': 'bg-violet-500', 'Récurrente': 'bg-amber-500', 'API': 'bg-pink-500', 'À-nouveaux': 'bg-teal-500',
};

export default function CabinetDashboard({ cabinetName, onOpen, onDemo, refresh }: { cabinetName: string; onOpen: (id: string) => void; onDemo: (id: string) => void; refresh?: number }) {
  const [d, setD] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

  useEffect(() => { let on = true; setLoading(true); api.dashboard().then((x) => { if (on) { setD(x); setLoading(false); } }); return () => { on = false; }; }, [refresh]);

  const seedDemo = async () => { setSeeding(true); try { const { dossierId } = await api.seedDemo(); onDemo(dossierId); } finally { setSeeding(false); } };

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>;
  if (!d) return null;

  if (d.totalEntries === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Tableau de bord</h1>
          <p className="mt-1 text-zinc-400">{cabinetName}</p>
        </div>
        <div className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/5 p-10 text-center">
          <div className="rounded-full bg-emerald-500/10 p-4 text-emerald-400"><Sparkles className="h-8 w-8" /></div>
          <h2 className="mt-4 font-display text-xl font-semibold">Découvrez Nova en 30 secondes</h2>
          <p className="mt-2 max-w-md text-zinc-400">Chargez un dossier de démonstration pré-rempli (ventes, achats, Mobile Money) et parcourez la capture, la balance et les états financiers — sans rien saisir.</p>
          <button onClick={seedDemo} disabled={seeding}
            className="mt-6 flex items-center gap-2 rounded-lg bg-emerald-500 px-6 py-3 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Créer un dossier de démonstration
          </button>
          <p className="mt-3 text-xs text-zinc-500">Ou créez votre propre dossier depuis l'onglet « Portefeuille ».</p>
        </div>
      </div>
    );
  }

  const totalSources = d.sourceBreakdown.reduce((s, x) => s + x.count, 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Tableau de bord</h1>
        <p className="mt-1 text-zinc-400">{cabinetName} · vue d'ensemble du portefeuille</p>
      </div>

      <TriagePanel onOpen={onOpen} />

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={Building2} label="Dossiers actifs" value={String(d.dossierCount)} />
        <Kpi icon={CalendarDays} label="Écritures ce mois" value={String(d.entriesThisMonth)} />
        <Kpi icon={Bot} label="Auto-codé par l'IA" value={`${d.autoCodedPct}%`} highlight
          hint="Part des écritures générées par capture / Mobile Money / import" />
        <Kpi icon={TrendingUp} label="Résultat cumulé" value={fmtMoney(d.resultatCumule, 'XOF')}
          valueClass={d.resultatCumule >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Portefeuille */}
        <div className="lg:col-span-2 space-y-4">
          <h3 className="font-display text-lg font-semibold">Portefeuille</h3>
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Dossier</th>
                  <th className="px-4 py-3 text-right font-medium">Écritures</th>
                  <th className="px-4 py-3 text-right font-medium">Auto</th>
                  <th className="px-4 py-3 text-right font-medium">Résultat</th>
                  <th className="px-4 py-3 font-medium">Dernière</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {d.perDossier.map((p) => (
                  <tr key={p.id} onClick={() => onOpen(p.id)} className="group cursor-pointer hover:bg-white/5">
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-200">{p.raisonSociale}</div>
                      {p.needsSetup && <span className="text-xs text-amber-500">à initialiser</span>}
                      {p.drafts > 0 && <span className="ml-2 text-xs text-amber-400">{p.drafts} brouillon(s)</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-zinc-300">{p.entries}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={cn('font-mono', p.autoPct >= 50 ? 'text-emerald-400' : 'text-zinc-400')}>{p.autoPct}%</span>
                    </td>
                    <td className={cn('px-4 py-3 text-right font-mono', p.resultat >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtMoney(p.resultat, p.currency)}</td>
                    <td className="px-4 py-3 text-zinc-500">{p.lastDate ?? '—'}</td>
                    <td className="px-4 py-3 text-right"><ChevronRight className="h-4 w-4 text-zinc-600 group-hover:text-emerald-400" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Répartition des sources */}
          {totalSources > 0 && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="mb-3 flex items-center gap-2 text-sm text-zinc-300"><Sparkles className="h-4 w-4 text-emerald-400" /> Origine des écritures</div>
              <div className="flex h-3 overflow-hidden rounded-full">
                {d.sourceBreakdown.map((s) => (
                  <div key={s.source} className={cn('h-full', SOURCE_COLOR[s.label] ?? 'bg-zinc-600')} style={{ width: `${(s.count / totalSources) * 100}%` }} title={`${s.label}: ${s.count}`} />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-400">
                {d.sourceBreakdown.map((s) => (
                  <span key={s.source} className="flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', SOURCE_COLOR[s.label] ?? 'bg-zinc-600')} />
                    {s.label} · {Math.round((s.count / totalSources) * 100)}%
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Alertes */}
        <div className="space-y-4">
          <h3 className="font-display text-lg font-semibold">Alertes</h3>
          {d.alerts.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm text-zinc-500">Rien à signaler ✅</div>
          ) : (
            <div className="space-y-2">
              {d.alerts.map((a, i) => (
                <motion.button key={i} onClick={() => onOpen(a.dossierId)}
                  initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                  className="flex w-full items-start gap-3 rounded-xl border border-amber-500/15 bg-amber-500/5 p-3 text-left hover:bg-amber-500/10">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <div>
                    <div className="text-sm text-zinc-200">{a.dossierName}</div>
                    <div className="text-xs text-zinc-400">{a.message}</div>
                  </div>
                </motion.button>
              ))}
            </div>
          )}
        </div>
      </div>
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
      <div className={cn('mt-3 font-display text-3xl font-bold tracking-tight', valueClass ?? (highlight ? 'text-emerald-400' : 'text-white'))}>{value}</div>
      {hint && <div className="mt-1 text-[11px] leading-tight text-zinc-500">{hint}</div>}
    </div>
  );
}

// Copilote du cabinet : par quoi commencer ce matin. S'appuie sur les digests
// de la veille nocturne — on ne recalcule pas tout le portefeuille à l'affichage.
function TriagePanel({ onOpen }: { onOpen: (id: string) => void }) {
  const [t, setT] = useState<CabinetTriage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => { try { setT(await api.cabinetTriage()); } catch { /* non bloquant */ } };
  useEffect(() => { load(); }, []);

  const runAll = async () => {
    setBusy(true); setError(null);
    try { await api.runCabinetTriage(); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (!t) return null;
  const rien = t.dossiers.length === 0 && t.jamaisAnalyses.length === 0;
  if (rien) return null;

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 font-display text-lg font-semibold text-zinc-100">
            <Sparkles className="h-5 w-5 text-emerald-400" /> Par quoi commencer
          </div>
          <p className="mt-0.5 text-sm text-zinc-400">
            {t.resume.dossiers === 0 ? 'Aucun dossier encore analysé.'
              : <>{t.resume.critiques} dossier(s) critique(s) · {t.resume.aTraiter} point(s) à traiter sur {t.resume.dossiers} dossier(s) analysé(s).</>}
          </p>
        </div>
        <button onClick={runAll} disabled={busy} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Analyser le portefeuille
        </button>
      </div>

      {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {t.parCategorie.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {t.parCategorie.slice(0, 6).map((c) => (
            <span key={c.categorie} className="rounded-full border border-white/10 bg-zinc-900/50 px-3 py-1 text-xs text-zinc-300">
              {c.libelle} · <span className="font-mono text-zinc-100">{c.dossiers}</span> dossier(s)
            </span>
          ))}
        </div>
      )}

      {t.dossiers.filter((d) => d.haute + d.moyenne > 0).length > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
          {t.dossiers.filter((d) => d.haute + d.moyenne > 0).slice(0, 8).map((d) => (
            <button key={d.dossierId} onClick={() => onOpen(d.dossierId)}
              className="flex w-full items-start gap-3 border-b border-white/5 px-4 py-3 text-left last:border-0 hover:bg-white/5">
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', d.haute > 0 ? 'bg-rose-400' : 'bg-amber-400')} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-zinc-100">{d.raisonSociale}</div>
                <div className="truncate text-xs text-zinc-500">{d.points.map((p) => p.titre).join(' · ') || '—'}</div>
              </div>
              <span className="shrink-0 text-xs text-zinc-500">
                {d.haute > 0 && <span className="text-rose-300">{d.haute} urgent(s)</span>}
                {d.haute > 0 && d.moyenne > 0 && ' · '}
                {d.moyenne > 0 && <span className="text-amber-300">{d.moyenne} à voir</span>}
              </span>
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
            </button>
          ))}
        </div>
      )}

      {t.jamaisAnalyses.length > 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          {t.jamaisAnalyses.length} dossier(s) jamais analysé(s) — lancez « Analyser le portefeuille », ou activez la veille dans chaque dossier (onglet Lexa).
        </p>
      )}
    </section>
  );
}
