import React, { useEffect, useState } from 'react';
import { Loader2, ScrollText, ChevronRight, ShieldCheck, ShieldAlert, ShieldX, Wrench, X, Gauge } from 'lucide-react';
import { api, type DecisionSummary, type DecisionDetail, type ValidationReport, type QualityDashboard } from '../lib/api';
import { cn } from '../lib/utils';

// Decision Ledger — journal de preuves des décisions de Lexa (explicabilité / audit).
export default function LexaDecisions({ dossierId }: { dossierId: string }) {
  const [rows, setRows] = useState<DecisionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<DecisionDetail | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dash, setDash] = useState<QualityDashboard | null>(null);

  useEffect(() => { api.qualityDashboard(dossierId).then(setDash).catch(() => setDash(null)); }, [dossierId]);
  useEffect(() => { setLoading(true); api.decisions(dossierId).then(setRows).catch(() => setRows([])).finally(() => setLoading(false)); }, [dossierId]);
  const open = async (id: string) => { setOpenId(id); setSel(null); try { setSel(await api.decision(dossierId, id)); } catch { /* ignore */ } };

  const confColor = (c: number | null) => c == null ? 'text-zinc-500' : c >= 90 ? 'text-emerald-400' : c >= 70 ? 'text-amber-400' : 'text-rose-400';

  return (
    <section className="space-y-4">
      {dash?.available && <QualityPanel dash={dash} />}

      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><ScrollText className="h-4 w-4 text-emerald-400" /> Journal des décisions de Lexa</div>
        <p className="mt-1 text-sm text-zinc-500">Chaque décision de Lexa est enregistrée comme une preuve traçable : question, outils appelés, contrôles qualité (AQM) et score de confiance. Cliquez sur « Pourquoi ? » pour le raisonnement complet.</p>
      </div>

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-4 py-6 text-sm text-zinc-500">Aucune décision enregistrée pour l'instant. Le journal se remplit à chaque échange avec Lexa (après application de la migration 0056).</p>
        ) : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-2.5 font-medium">Date</th><th className="px-4 py-2.5 font-medium">Question</th>
              <th className="px-4 py-2.5 font-medium">Outils</th><th className="px-4 py-2.5 text-right font-medium">Confiance</th><th className="px-4 py-2.5"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-white/5">
                  <td className="px-4 py-2 font-mono text-xs text-zinc-500">{r.createdAt.replace('T', ' ').slice(0, 16)}</td>
                  <td className="max-w-[22rem] truncate px-4 py-2 text-zinc-200">{r.question || '—'}</td>
                  <td className="px-4 py-2 text-zinc-400"><span className="inline-flex items-center gap-1 text-xs"><Wrench className="h-3 w-3" />{r.tools.length}{r.nbValidations ? ` · ${r.nbValidations} AQM` : ''}</span></td>
                  <td className={cn('px-4 py-2 text-right font-mono', confColor(r.confidence))}>{r.confidence == null ? '—' : `${r.confidence}`}</td>
                  <td className="px-4 py-2 text-right"><button onClick={() => open(r.id)} className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-200 hover:bg-white/10">Pourquoi ? <ChevronRight className="h-3 w-3" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setOpenId(null)}>
          <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><ScrollText className="h-4 w-4 text-emerald-400" /> Raisonnement de Lexa</div>
              <button onClick={() => setOpenId(null)} className="text-zinc-500 hover:text-zinc-200"><X className="h-5 w-5" /></button>
            </div>
            {!sel ? <div className="flex items-center gap-2 py-6 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : (
              <div className="space-y-4 text-sm">
                <Field label="Question"><p className="text-zinc-200">{sel.question || '—'}</p></Field>
                <div className="flex flex-wrap gap-4 text-xs text-zinc-500">
                  <span>Palier : <b className="text-zinc-300">{sel.mode ?? '—'}</b></span>
                  <span>Modèle : <b className="text-zinc-300">{sel.model ?? '—'}</b></span>
                  {sel.confidence != null && <span>Confiance : <b className={confColor(sel.confidence)}>{sel.confidence}/100</b></span>}
                </div>
                <Field label={`Outils appelés (${sel.tools.length})`}>
                  <div className="flex flex-wrap gap-1.5">
                    {sel.tools.length === 0 ? <span className="text-zinc-500">Aucun (réponse directe).</span> :
                      sel.tools.map((t, i) => (
                        <span key={i} className={cn('rounded-md border px-2 py-0.5 font-mono text-xs', t.ok ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/25 bg-rose-500/10 text-rose-300')}>
                          {t.name}{t.verdict ? ` · ${t.verdict}` : ''}
                        </span>
                      ))}
                  </div>
                </Field>
                {sel.validations.length > 0 && (
                  <Field label="Contrôles qualité (AQM)">
                    <div className="space-y-2">
                      {sel.validations.map((v: { input: any; report: ValidationReport }, i: number) => <div key={i}><AqmMini report={v.report} /></div>)}
                    </div>
                  </Field>
                )}
                <Field label="Réponse"><p className="whitespace-pre-wrap text-zinc-300">{sel.answer || '—'}</p></Field>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const TOOL_LABELS: Record<string, string> = {
  valider_ecriture: 'Validation écriture', valider_facture: 'Validation facture', valider_declaration: 'Validation déclaration',
  situation_generale: 'Situation générale', balance_generale: 'Balance', grand_livre: 'Grand livre', analyse_mensuelle: 'Rapport mensuel',
  echeancier: 'Échéancier', ratios_financiers: 'Ratios', alertes: 'Alertes', controles_coherence: 'Contrôles', estimation_is: 'Estimation IS',
  memoriser: 'Mémoire', envoyer_email: 'Envoi email', tableau_flux_tresorerie: 'TFT', balance_agee: 'Balance âgée', catalogue: 'Catalogue',
};
const toolLabel = (n: string) => TOOL_LABELS[n] ?? n;

// Tableau de bord qualité (AQM) — synthèse du Decision Ledger par type d'action.
function QualityPanel({ dash }: { dash: QualityDashboard }) {
  const aqm = dash.aqm ?? { pass: 0, warn: 0, fail: 0 };
  const aqmTotal = aqm.pass + aqm.warn + aqm.fail;
  const pct = (n: number) => (aqmTotal ? (n / aqmTotal) * 100 : 0);
  const topTools = (dash.tools ?? []).slice(0, 8);
  const maxN = Math.max(1, ...topTools.map((t) => t.n));
  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Gauge className="h-4 w-4 text-emerald-400" /> Tableau de bord qualité (AQM)
        <span className="ml-auto text-xs font-normal text-zinc-500">{dash.since ? `depuis le ${dash.since}` : ''}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Décisions tracées" value={String(dash.total ?? 0)} />
        <Kpi label="Confiance moyenne" value={dash.avgConfidence == null ? '—' : `${dash.avgConfidence}/100`} tone={dash.avgConfidence == null ? undefined : dash.avgConfidence >= 90 ? 'pos' : dash.avgConfidence >= 70 ? 'warn' : 'neg'} />
        <Kpi label="Décisions à faible confiance" value={String(dash.lowConfidence ?? 0)} sub="< 70/100" tone={(dash.lowConfidence ?? 0) > 0 ? 'warn' : undefined} />
      </div>

      {aqmTotal > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-zinc-500"><span>Verdicts des contrôles AQM</span><span className="font-mono">{aqmTotal}</span></div>
          <div className="flex h-3 overflow-hidden rounded-full border border-white/10 bg-zinc-800">
            <div className="bg-emerald-500" style={{ width: `${pct(aqm.pass)}%` }} title={`Conforme : ${aqm.pass}`} />
            <div className="bg-amber-500" style={{ width: `${pct(aqm.warn)}%` }} title={`Vigilance : ${aqm.warn}`} />
            <div className="bg-rose-500" style={{ width: `${pct(aqm.fail)}%` }} title={`Bloquant : ${aqm.fail}`} />
          </div>
          <div className="mt-1 flex gap-4 text-xs text-zinc-400">
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500" /> {aqm.pass} conforme</span>
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-amber-500" /> {aqm.warn} vigilance</span>
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-rose-500" /> {aqm.fail} bloquant</span>
          </div>
        </div>
      )}

      {topTools.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Usage par type d'action</div>
          <div className="space-y-1">
            {topTools.map((t) => (
              <div key={t.name} className="flex items-center gap-2 text-sm">
                <span className="w-40 shrink-0 truncate text-zinc-300" title={t.name}>{toolLabel(t.name)}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <div className={cn('h-full', t.failRate > 20 ? 'bg-rose-500/70' : 'bg-emerald-500/70')} style={{ width: `${(t.n / maxN) * 100}%` }} />
                </div>
                <span className="w-10 shrink-0 text-right font-mono text-xs text-zinc-400">{t.n}</span>
                {t.n - t.ok > 0 && <span className="w-16 shrink-0 text-right font-mono text-xs text-rose-400">{t.failRate}% éch.</span>}
                {t.n - t.ok === 0 && <span className="w-16 shrink-0" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {(dash.lowConfidenceRecent ?? []).length > 0 && (
        <div>
          <div className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Décisions récentes à surveiller</div>
          <div className="space-y-1">
            {(dash.lowConfidenceRecent ?? []).map((d) => (
              <div key={d.id} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-zinc-500">{d.createdAt.replace('T', ' ')}</span>
                <span className="flex-1 truncate text-zinc-300">{d.question || '—'}</span>
                <span className={cn('font-mono', d.confidence >= 70 ? 'text-amber-400' : 'text-rose-400')}>{d.confidence}/100</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'pos' | 'warn' | 'neg' }) {
  const col = tone === 'pos' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-100';
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cn('mt-1 font-mono text-xl font-bold', col)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      {children}
    </div>
  );
}

function AqmMini({ report }: { report: ValidationReport }) {
  const Icon = report.verdict === 'PASS' ? ShieldCheck : report.verdict === 'WARNING' ? ShieldAlert : ShieldX;
  const txt = report.verdict === 'PASS' ? 'text-emerald-400' : report.verdict === 'WARNING' ? 'text-amber-400' : 'text-rose-400';
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between">
        <span className={cn('flex items-center gap-1.5 text-xs font-semibold', txt)}><Icon className="h-4 w-4" /> {report.verdict}</span>
        <span className="font-mono text-xs text-zinc-400">{report.score}/100</span>
      </div>
      <ul className="mt-2 space-y-1">
        {report.checks.filter((k) => k.level !== 'pass').map((k) => (
          <li key={k.code} className="text-xs text-zinc-400"><b className="text-zinc-300">{k.label}</b>{k.detail ? ` — ${k.detail}` : ''}</li>
        ))}
        {report.checks.every((k) => k.level === 'pass') && <li className="text-xs text-emerald-400">Tous les contrôles OK.</li>}
      </ul>
    </div>
  );
}
