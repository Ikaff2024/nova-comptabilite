import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, PieChart, Layers, ChevronRight, CalendarRange, Printer, TrendingUp, Grid3x3, Settings2 } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type AnalyticSection, type AnalyticReport, type AnalyticDetail, type AnalyticMonthly, type AnalyticAxe, type AnalyticCross, currentFiscalYear } from '../lib/api';
import { printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';
import Rentabilite from './Rentabilite';
import AxesAnalytiques from './AxesAnalytiques';

export default function Analytique({ dossierId, currency, fiscalYears }: { dossierId: string; currency: string; fiscalYears: FiscalYear[] }) {
  const [sections, setSections] = useState<AnalyticSection[]>([]);
  const [report, setReport] = useState<AnalyticReport | null>(null);
  const [fy, setFy] = useState(currentFiscalYear(fiscalYears)?.id ?? '');
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'sections' | 'monthly' | 'croise' | 'rentabilite'>('sections');
  // Axe courant. Sans axe choisi, tout se comporte comme avant : c'est la
  // promesse faite aux dossiers mono-axe, qui sont la majorité.
  const [axes, setAxes] = useState<AnalyticAxe[]>([]);
  const [axe, setAxe] = useState('');
  const [showAxes, setShowAxes] = useState(false);
  const [cross, setCross] = useState<AnalyticCross | null>(null);
  const [crossB, setCrossB] = useState('');
  const [crossLoading, setCrossLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, AnalyticDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [monthly, setMonthly] = useState<AnalyticMonthly | null>(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const m = (n: number) => fmtMoney(n, currency);

  const loadAxes = async () => {
    try { setAxes(await api.analyticAxes(dossierId)); } catch { /* ignore */ }
  };
  useEffect(() => { loadAxes(); }, [dossierId]);

  const load = async () => {
    setLoading(true); setExpanded(null); setDetail({});
    try {
      const [s, r] = await Promise.all([
        api.analyticSections(dossierId, axe || undefined),
        api.analyticReport(dossierId, fy || undefined, axe || undefined),
      ]);
      setSections(s); setReport(r);
    }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); setMonthly(null); setCross(null); }, [dossierId, fy, axe]);

  useEffect(() => {
    if (view !== 'monthly' || monthly) return;
    setMonthlyLoading(true);
    api.analyticMonthly(dossierId, fy || undefined, axe || undefined).then(setMonthly).catch(() => {}).finally(() => setMonthlyLoading(false));
  }, [view, dossierId, fy, axe, monthly]);

  // Croisement : l'axe courant contre un autre. C'est la lecture que le mono-axe
  // interdisait — sans elle, deux axes ne sont que deux tableaux séparés.
  const autres = axes.filter((a) => a.id !== (axe ? axes.find((x) => x.id === axe || x.code === axe)?.id : axes.find((x) => x.isPrimary)?.id));
  useEffect(() => { if (!crossB && autres[0]) setCrossB(autres[0].id); }, [axes, axe]);
  useEffect(() => {
    if (view !== 'croise' || !crossB) return;
    const a = axe || axes.find((x) => x.isPrimary)?.id;
    if (!a) return;
    setCrossLoading(true); setCross(null);
    api.analyticCross(dossierId, a, crossB, fy || undefined).then(setCross).catch(() => {}).finally(() => setCrossLoading(false));
  }, [view, dossierId, fy, axe, crossB]);

  const toggleDetail = async (secCode: string) => {
    if (expanded === secCode) { setExpanded(null); return; }
    setExpanded(secCode);
    if (!detail[secCode]) {
      setDetailLoading(secCode);
      try { const d = await api.analyticDetail(dossierId, secCode, fy || undefined, axe || undefined); setDetail((prev) => ({ ...prev, [secCode]: d })); }
      catch { /* ignore */ } finally { setDetailLoading(null); }
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.createAnalyticSection(dossierId, code.trim(), label.trim(), axe || undefined); setCode(''); setLabel(''); await load(); await loadAxes(); }
    catch (e: any) { setError(e.message); }
  };
  const remove = async (s: AnalyticSection) => { if (!confirm(`Supprimer la section ${s.code} ? (les écritures gardent leur code)`)) return; setError(null); try { await api.deleteAnalyticSection(dossierId, s.id); await load(); await loadAxes(); } catch (e: any) { setError(e.message); } };

  const exportPdf = () => {
    if (!report) return;
    const fyLabel = fiscalYears.find((f) => f.id === fy)?.label ?? '';
    const rows = report.sections.map((s) => `<tr><td>${s.code !== '—' ? s.code + ' · ' : ''}${(s.label ?? '').replace(/[&<>]/g, '')}</td><td class="n">${m(s.produits)}</td><td class="n">${m(s.charges)}</td><td class="n">${m(s.resultat)}</td></tr>`).join('');
    const body = `
      <table><thead><tr><th>Section</th><th class="n">Produits</th><th class="n">Charges</th><th class="n">Résultat</th></tr></thead><tbody>
      ${rows}
      <tr class="tot"><td>Total</td><td class="n">${m(report.totals.produits)}</td><td class="n">${m(report.totals.charges)}</td><td class="n">${m(report.totals.resultat)}</td></tr>
      </tbody></table>`;
    printDocument(`Résultat analytique — ${fyLabel}`, `édité le ${nowStamp()} · devise ${currency}`, body);
  };

  const axeCourant = axe ? axes.find((a) => a.id === axe || a.code === axe) : axes.find((a) => a.isPrimary);
  const rescls = (n: number) => (n >= 0 ? 'text-emerald-400' : 'text-rose-400');

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Layers className="h-4 w-4 text-emerald-400" />
            Sections {axeCourant ? <>de l'axe <span className="text-emerald-400">{axeCourant.label}</span></> : 'analytiques (centres de coût)'}
          </div>
          <button onClick={() => setShowAxes((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10">
            <Settings2 className="h-3.5 w-3.5" /> {showAxes ? 'Masquer' : 'Gérer'} les axes{axes.length > 1 ? ` (${axes.length})` : ''}
          </button>
        </div>
        {showAxes && <AxesAnalytiques dossierId={dossierId} axes={axes} onChanged={async () => { await loadAxes(); await load(); }} />}
        <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div><label className="mb-1 block text-xs text-zinc-500">Code</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="COCODY" className="w-32 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
          <div className="flex-1 min-w-[12rem]"><label className="mb-1 block text-xs text-zinc-500">Intitulé</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Boutique Cocody" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
          <button type="submit" className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Ajouter</button>
        </form>
        {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
        {sections.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {sections.map((s) => (
              <span key={s.id} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-zinc-300">
                <span className="font-mono text-emerald-400">{s.code}</span> {s.label}
                <button onClick={() => remove(s)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
              </span>
            ))}
          </div>
        )}
        <p className="text-xs text-zinc-500">
          {axeCourant && !axeCourant.isPrimary
            ? <>Cet axe est <strong>secondaire</strong> : ses sections se renseignent à la saisie, en plus de l'axe principal. Une écriture porte au plus une valeur par axe.</>
            : <>Ventilez vos écritures en saisie (colonne « Analytique ») pour alimenter le résultat par section.</>}
        </p>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-sm">
            <button onClick={() => setView('sections')} className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors', view === 'sections' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}><PieChart className="h-4 w-4" /> Par section</button>
            <button onClick={() => setView('monthly')} className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors', view === 'monthly' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}><CalendarRange className="h-4 w-4" /> Vue mensuelle</button>
            {axes.length > 1 && (
              <button onClick={() => setView('croise')} title="Résultat au croisement de deux axes" className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors', view === 'croise' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}><Grid3x3 className="h-4 w-4" /> Croisé</button>
            )}
            <button onClick={() => setView('rentabilite')} title="Marge de l'activité rapprochée de ce qu'elle a demandé d'investir" className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors', view === 'rentabilite' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}><TrendingUp className="h-4 w-4" /> Rentabilité</button>
          </div>
          <div className="flex items-center gap-2">
            {/* Le sélecteur d'axe ne s'affiche que s'il y a un choix à faire. */}
            {axes.length > 1 && view !== 'rentabilite' && (
              <select value={axe} onChange={(e) => setAxe(e.target.value)} title="Axe d'analyse"
                className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-200 outline-none focus:border-sky-400">
                {axes.map((a) => <option key={a.id} value={a.id} className="bg-zinc-900 text-zinc-100">{a.label}</option>)}
              </select>
            )}
            <button onClick={exportPdf} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> PDF</button>
            <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
              {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
        </div>

        {view === 'rentabilite' ? <Rentabilite dossierId={dossierId} fiscalYearId={fy} currency={currency} />
          : view === 'croise' ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                <span className="text-zinc-300">{axeCourant?.label}</span> croisé avec
                <select value={crossB} onChange={(e) => setCrossB(e.target.value)}
                  className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
                  {autres.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
              {crossLoading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div>
                : !cross || cross.lignes.length === 0 ? <p className="text-sm text-zinc-500">Aucune donnée ventilée sur ces deux axes.</p> : (
                <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
                  <table className="w-full min-w-[40rem] text-right text-xs">
                    <thead className="border-b border-white/10 bg-white/5 uppercase text-zinc-400"><tr>
                      <th className="px-3 py-3 text-left font-medium">{cross.axeA.label} ╲ {cross.axeB.label}</th>
                      {cross.colonnes.map((c) => <th key={c.code} className="px-2 py-3 font-medium">{c.label}</th>)}
                      <th className="px-3 py-3 font-medium">Total</th>
                    </tr></thead>
                    <tbody className="divide-y divide-white/5 font-mono">
                      {cross.lignes.map((l) => (
                        <tr key={l.code} className="hover:bg-white/5">
                          <td className="px-3 py-2 text-left font-sans text-zinc-200">{l.label}</td>
                          {l.cells.map((v, i) => <td key={i} className={cn('px-2 py-2', v === 0 ? 'text-zinc-700' : rescls(v))}>{v === 0 ? '·' : m(v)}</td>)}
                          <td className={cn('px-3 py-2 font-semibold', rescls(l.total))}>{m(l.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
                      <td className="px-3 py-3 text-left font-sans font-semibold text-zinc-200">Total</td>
                      {cross.totauxColonnes.map((v, i) => <td key={i} className={cn('px-2 py-3 font-semibold', v === 0 ? 'text-zinc-700' : rescls(v))}>{v === 0 ? '·' : m(v)}</td>)}
                      <td className={cn('px-3 py-3 font-semibold', rescls(cross.total))}>{m(cross.total)}</td>
                    </tr></tfoot>
                  </table>
                </div>
              )}
              <p className="text-xs text-zinc-500">
                Chaque case est un <strong>résultat</strong> (produits − charges). Le total général est le même quel que soit le croisement :
                c'est le résultat analytique de l'exercice, simplement découpé autrement.
              </p>
            </div>
          )
          : loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div>
          : view === 'sections' ? (
            !report || report.sections.length === 0 ? <p className="text-sm text-zinc-500">Aucune charge/produit ventilé. Créez des sections et affectez-les en saisie.</p> : (
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                  <th className="px-4 py-3 font-medium">Section</th><th className="px-4 py-3 text-right font-medium">Produits</th>
                  <th className="px-4 py-3 text-right font-medium">Charges</th><th className="px-4 py-3 text-right font-medium">Résultat</th>
                </tr></thead>
                <tbody className="divide-y divide-white/5 font-mono">
                  {report.sections.map((s) => (
                    <React.Fragment key={s.code}>
                      <tr onClick={() => toggleDetail(s.code)} className="cursor-pointer hover:bg-white/5">
                        <td className="px-4 py-2 font-sans text-zinc-200">
                          <span className="inline-flex items-center gap-1.5">
                            <ChevronRight className={cn('h-3.5 w-3.5 text-zinc-500 transition-transform', expanded === s.code && 'rotate-90')} />
                            <span className="font-mono text-xs text-zinc-500">{s.code !== '—' ? s.code : ''}</span> {s.label}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-zinc-300">{s.produits ? m(s.produits) : '—'}</td>
                        <td className="px-4 py-2 text-right text-zinc-300">{s.charges ? m(s.charges) : '—'}</td>
                        <td className={cn('px-4 py-2 text-right font-medium', rescls(s.resultat))}>{m(s.resultat)}</td>
                      </tr>
                      {expanded === s.code && (
                        <tr className="bg-black/20">
                          <td colSpan={4} className="px-4 py-3">
                            {detailLoading === s.code ? <div className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Détail…</div>
                              : !detail[s.code] || detail[s.code].byAccount.length === 0 ? <p className="text-xs text-zinc-500">Aucun détail.</p> : (
                              <div className="space-y-1">
                                <div className="text-xs uppercase text-zinc-500">Détail par compte ({detail[s.code].lines.length} écriture{detail[s.code].lines.length > 1 ? 's' : ''})</div>
                                <table className="w-full text-xs">
                                  <tbody>
                                    {detail[s.code].byAccount.map((a) => (
                                      <tr key={a.accountCode} className="border-b border-white/5">
                                        <td className="py-1.5 pr-2 font-mono text-zinc-500">{a.accountCode}</td>
                                        <td className="py-1.5 pr-2 font-sans text-zinc-300">{a.accountLabel}</td>
                                        <td className="py-1.5 pr-2 text-zinc-600">{a.classNo === 7 ? 'produit' : 'charge'}</td>
                                        <td className={cn('py-1.5 text-right font-mono', a.classNo === 7 ? 'text-emerald-400/80' : 'text-zinc-300')}>{m(a.montant)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
                  <td className="px-4 py-3 font-sans font-semibold text-zinc-200">Total</td>
                  <td className="px-4 py-3 text-right font-semibold text-zinc-100">{m(report.totals.produits)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-zinc-100">{m(report.totals.charges)}</td>
                  <td className={cn('px-4 py-3 text-right font-semibold', rescls(report.totals.resultat))}>{m(report.totals.resultat)}</td>
                </tr></tfoot>
              </table>
            </div>
            )
          ) : (
            monthlyLoading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div>
              : !monthly || monthly.sections.length === 0 ? <p className="text-sm text-zinc-500">Aucune donnée mensuelle ventilée sur cet exercice.</p> : (
              <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
                <table className="w-full min-w-[52rem] text-right text-xs">
                  <thead className="border-b border-white/10 bg-white/5 uppercase text-zinc-400"><tr>
                    <th className="px-3 py-3 text-left font-medium">Section (résultat)</th>
                    {monthly.months.map((mo) => <th key={mo} className="px-2 py-3 font-medium">{mo}</th>)}
                    <th className="px-3 py-3 font-medium">Total</th>
                  </tr></thead>
                  <tbody className="divide-y divide-white/5 font-mono">
                    {monthly.sections.map((s) => (
                      <tr key={s.code} className="hover:bg-white/5">
                        <td className="px-3 py-2 text-left font-sans text-zinc-200"><span className="font-mono text-zinc-500">{s.code !== '—' ? s.code : ''}</span> {s.label}</td>
                        {s.monthly.map((v, i) => <td key={i} className={cn('px-2 py-2', v === 0 ? 'text-zinc-700' : rescls(v))}>{v === 0 ? '·' : m(v)}</td>)}
                        <td className={cn('px-3 py-2 font-semibold', rescls(s.total))}>{m(s.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
                    <td className="px-3 py-3 text-left font-sans font-semibold text-zinc-200">Total mensuel</td>
                    {monthly.monthTotals.map((v, i) => <td key={i} className={cn('px-2 py-3 font-semibold', v === 0 ? 'text-zinc-700' : rescls(v))}>{v === 0 ? '·' : m(v)}</td>)}
                    <td className={cn('px-3 py-3 font-semibold', rescls(monthly.monthTotals.reduce((a, b) => a + b, 0)))}>{m(monthly.monthTotals.reduce((a, b) => a + b, 0))}</td>
                  </tr></tfoot>
                </table>
              </div>
            )
          )}
      </section>
    </div>
  );
}
