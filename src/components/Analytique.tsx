import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, PieChart, Layers } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type AnalyticSection, type AnalyticReport } from '../lib/api';
import { cn } from '../lib/utils';

export default function Analytique({ dossierId, currency, fiscalYears }: { dossierId: string; currency: string; fiscalYears: FiscalYear[] }) {
  const [sections, setSections] = useState<AnalyticSection[]>([]);
  const [report, setReport] = useState<AnalyticReport | null>(null);
  const [fy, setFy] = useState(fiscalYears[0]?.id ?? '');
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = (n: number) => fmtMoney(n, currency);

  const load = async () => {
    setLoading(true);
    try { const [s, r] = await Promise.all([api.analyticSections(dossierId), api.analyticReport(dossierId, fy || undefined)]); setSections(s); setReport(r); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [dossierId, fy]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.createAnalyticSection(dossierId, code.trim(), label.trim()); setCode(''); setLabel(''); await load(); }
    catch (e: any) { setError(e.message); }
  };
  const remove = async (s: AnalyticSection) => { if (!confirm(`Supprimer la section ${s.code} ? (les écritures gardent leur code)`)) return; setError(null); try { await api.deleteAnalyticSection(dossierId, s.id); await load(); } catch (e: any) { setError(e.message); } };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Layers className="h-4 w-4 text-emerald-400" /> Sections analytiques (centres de coût)</div>
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
        <p className="text-xs text-zinc-500">Ventilez vos écritures en saisie (colonne « Analytique ») pour alimenter le résultat par section.</p>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><PieChart className="h-4 w-4 text-emerald-400" /> Résultat analytique</div>
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div>
          : !report || report.sections.length === 0 ? <p className="text-sm text-zinc-500">Aucune charge/produit ventilé. Créez des sections et affectez-les en saisie.</p> : (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                <th className="px-4 py-3 font-medium">Section</th><th className="px-4 py-3 text-right font-medium">Produits</th>
                <th className="px-4 py-3 text-right font-medium">Charges</th><th className="px-4 py-3 text-right font-medium">Résultat</th>
              </tr></thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {report.sections.map((s) => (
                  <tr key={s.code} className="hover:bg-white/5">
                    <td className="px-4 py-2 font-sans text-zinc-200"><span className="font-mono text-xs text-zinc-500">{s.code !== '—' ? s.code : ''}</span> {s.label}</td>
                    <td className="px-4 py-2 text-right text-zinc-300">{s.produits ? m(s.produits) : '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-300">{s.charges ? m(s.charges) : '—'}</td>
                    <td className={cn('px-4 py-2 text-right font-medium', s.resultat >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{m(s.resultat)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
                <td className="px-4 py-3 font-sans font-semibold text-zinc-200">Total</td>
                <td className="px-4 py-3 text-right font-semibold text-zinc-100">{m(report.totals.produits)}</td>
                <td className="px-4 py-3 text-right font-semibold text-zinc-100">{m(report.totals.charges)}</td>
                <td className={cn('px-4 py-3 text-right font-semibold', report.totals.resultat >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{m(report.totals.resultat)}</td>
              </tr></tfoot>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
