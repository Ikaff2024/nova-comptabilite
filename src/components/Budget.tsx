import React, { useEffect, useState } from 'react';
import { Loader2, Target, Plus, Trash2, FileSpreadsheet } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type BudgetReport } from '../lib/api';
import { downloadCsv } from '../lib/export';
import { cn } from '../lib/utils';

export default function Budget({ dossierId, dossierName, currency, fiscalYears }: { dossierId: string; dossierName: string; currency: string; fiscalYears: FiscalYear[] }) {
  const [fy, setFy] = useState(fiscalYears[0]?.id ?? '');
  const [data, setData] = useState<BudgetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = (n: number) => fmtMoney(n, currency);

  const load = async () => { if (!fy) return; setLoading(true); try { setData(await api.budgetReport(dossierId, fy)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId, fy]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.setBudget(dossierId, fy, code.trim(), Number(amount) || 0); setCode(''); setAmount(''); await load(); }
    catch (e: any) { setError(e.message); }
  };
  const remove = async (accountCode: string) => { setError(null); try { await api.deleteBudget(dossierId, fy, accountCode); await load(); } catch (e: any) { setError(e.message); } };

  const t = data?.totals;
  const charges = (data?.rows ?? []).filter((r) => r.classNo === 6);
  const produits = (data?.rows ?? []).filter((r) => r.classNo === 7);

  const exportCsv = () => {
    if (!data) return;
    const out: (string | number)[][] = [['Compte', 'Intitulé', 'Budget', 'Réalisé', 'Écart', '% réalisation']];
    for (const r of data.rows) out.push([r.account_code, r.label, r.budget, r.realise, r.ecart, r.pct ?? '']);
    downloadCsv(`budget_${dossierName}`.replace(/\s+/g, '-'), out);
  };

  // Pour une charge, réalisé > budget = dépassement (rouge). Pour un produit, réalisé < budget = manque (rouge).
  const ecartColor = (r: { classNo: number; ecart: number }) => {
    if (r.ecart === 0) return 'text-zinc-400';
    const good = r.classNo === 6 ? r.ecart < 0 : r.ecart > 0;
    return good ? 'text-emerald-400' : 'text-rose-400';
  };

  const Section = ({ title, rows, kind }: { title: string; rows: typeof charges; kind: 'charges' | 'produits' }) => (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
      <div className="border-b border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-200">{title}</div>
      {rows.length === 0 ? <p className="px-4 py-3 text-sm text-zinc-500">Aucune ligne. Ajoutez un budget ci-dessus.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500"><tr>
            <th className="px-4 py-2 font-medium">Compte</th><th className="px-4 py-2 text-right font-medium">Budget</th>
            <th className="px-4 py-2 text-right font-medium">Réalisé</th><th className="px-4 py-2 text-right font-medium">Écart</th>
            <th className="px-4 py-2 text-right font-medium">%</th><th className="px-4 py-2"></th>
          </tr></thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {rows.map((r) => (
              <tr key={r.account_code} className="hover:bg-white/5">
                <td className="px-4 py-2 text-zinc-300">{r.account_code} <span className="font-sans text-zinc-500">{r.label}</span></td>
                <td className="px-4 py-2 text-right text-zinc-400">{r.budget ? m(r.budget) : '—'}</td>
                <td className="px-4 py-2 text-right text-zinc-200">{r.realise ? m(r.realise) : '—'}</td>
                <td className={cn('px-4 py-2 text-right', ecartColor(r))}>{r.ecart ? m(r.ecart) : '—'}</td>
                <td className="px-4 py-2 text-right text-zinc-400">{r.pct != null ? `${r.pct}%` : '—'}</td>
                <td className="px-4 py-2 text-right">{r.budget ? <button onClick={() => remove(r.account_code)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button> : null}</td>
              </tr>
            ))}
          </tbody>
          {t && (
            <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
              <td className="px-4 py-2.5 font-sans font-semibold text-zinc-200">Total {title.toLowerCase()}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-zinc-100">{m(kind === 'charges' ? t.chargesBudget : t.produitsBudget)}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-zinc-100">{m(kind === 'charges' ? t.chargesRealise : t.produitsRealise)}</td>
              <td colSpan={3}></td>
            </tr></tfoot>
          )}
        </table>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Target className="h-4 w-4 text-emerald-400" /> Budget &amp; suivi budgétaire</div>
        <div className="flex items-center gap-2">
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <button onClick={exportCsv} disabled={!data} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><FileSpreadsheet className="h-4 w-4" /> CSV</button>
        </div>
      </div>

      <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div><label className="mb-1 block text-xs text-zinc-500">Compte (6x charge / 7x produit)</label><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="601" className="w-28 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
        <div><label className="mb-1 block text-xs text-zinc-500">Montant budgété ({currency})</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1200000" className="w-40 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
        <button type="submit" className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Définir</button>
      </form>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Charges" rows={charges} kind="charges" />
          <Section title="Produits" rows={produits} kind="produits" />
        </div>
      )}
    </div>
  );
}
