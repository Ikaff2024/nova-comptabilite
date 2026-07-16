import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Target, Plus, Trash2, FileSpreadsheet, Upload, Printer, CheckCircle2, TrendingUp, Gauge, Sparkles } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type BudgetReport, type RollingForecast } from '../lib/api';
import BudgetCopilot from './BudgetCopilot';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

const SAMPLE_BUDGET = `Compte;Libellé;Montant
601;Achats de marchandises;12 000 000
622;Locations;3 600 000
661;Charges de personnel;18 000 000
701;Ventes de marchandises;45 000 000
706;Services vendus;8 000 000`;

export default function Budget({ dossierId, dossierName, currency, fiscalYears }: { dossierId: string; dossierName: string; currency: string; fiscalYears: FiscalYear[] }) {
  const [fy, setFy] = useState(fiscalYears[0]?.id ?? '');
  const [data, setData] = useState<BudgetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const m = (n: number) => fmtMoney(n, currency);

  const load = async () => { if (!fy) return; setLoading(true); try { setData(await api.budgetReport(dossierId, fy)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId, fy]);

  // Forecast glissant (réel à date → projection fin d'année).
  const [view, setView] = useState<'budget' | 'forecast' | 'copilote'>('budget');
  const [fc, setFc] = useState<RollingForecast | null>(null);
  const [fcLoading, setFcLoading] = useState(false);
  useEffect(() => {
    if (view !== 'forecast' || !fy) return;
    setFcLoading(true); setFc(null);
    api.rollingForecast(dossierId, fy).then(setFc).catch((e) => setError(e.message)).finally(() => setFcLoading(false));
  }, [view, dossierId, fy]);

  const doImport = async () => {
    setImporting(true); setError(null); setImportMsg(null);
    try {
      const r = await api.importBudget(dossierId, fy, csv);
      setImportMsg(`${r.imported} ligne(s) importée(s)${r.errors.length ? ` — ${r.errors.length} rejetée(s) : ${r.errors.slice(0, 4).map((e) => `${e.accountCode} (${e.reason})`).join(', ')}${r.errors.length > 4 ? '…' : ''}` : '.'}`);
      setCsv(''); await load();
    } catch (e: any) { setError(e.message); } finally { setImporting(false); }
  };
  const onFile = (f: File) => { const r = new FileReader(); r.onload = () => setCsv(String(r.result ?? '')); r.readAsText(f, 'utf-8'); };

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

  // État comparatif budget / réalisé (document imprimable).
  const exportPdf = () => {
    if (!data || !t) return;
    const esc = (s: string) => (s ?? '').replace(/[&<>]/g, '');
    const block = (title: string, rows: typeof charges, budget: number, realise: number) => `
      <h2>${title}</h2>
      <table><thead><tr><th>Compte</th><th>Intitulé</th><th class="n">Budget</th><th class="n">Réalisé</th><th class="n">Écart</th><th class="n">%</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${r.account_code}</td><td>${esc(r.label)}</td><td class="n">${r.budget ? m(r.budget) : '—'}</td><td class="n">${r.realise ? m(r.realise) : '—'}</td><td class="n">${r.ecart ? m(r.ecart) : '—'}</td><td class="n">${r.pct != null ? r.pct + '%' : '—'}</td></tr>`).join('') || '<tr><td colspan="6">Aucune ligne</td></tr>'}
        <tr class="tot"><td colspan="2">Total ${title.toLowerCase()}</td><td class="n">${m(budget)}</td><td class="n">${m(realise)}</td><td class="n">${m(realise - budget)}</td><td class="n">${budget ? Math.round((realise / budget) * 100) + '%' : '—'}</td></tr>
      </tbody></table>`;
    const ecartResultat = t.resultatRealise - t.resultatBudget;
    const body = `
      ${block('Charges', charges, t.chargesBudget, t.chargesRealise)}
      ${block('Produits', produits, t.produitsBudget, t.produitsRealise)}
      <h2>Résultat</h2>
      <table><tbody>
        <tr class="tot"><td>Résultat budgété</td><td class="n">${m(t.resultatBudget)}</td></tr>
        <tr class="tot"><td>Résultat réalisé</td><td class="n">${m(t.resultatRealise)}</td></tr>
        <tr class="tot"><td>Écart (réalisé − budgété)</td><td class="n">${m(ecartResultat)}</td></tr>
      </tbody></table>
      <p style="margin-top:10px;font-size:11px;color:#666">Écart = réalisé − budgété. Pour une charge, un écart négatif est favorable (sous-consommation) ; pour un produit, un écart positif est favorable.</p>`;
    printDocument(`État comparatif budget / réalisé — ${dossierName}`, `${fiscalYears.find((f) => f.id === fy)?.label ?? ''} · devise ${currency} · édité le ${nowStamp()}`, body);
  };

  // Pour une charge, réalisé > budget = dépassement (rouge). Pour un produit, réalisé < budget = manque (rouge).
  const ecartColor = (r: { classNo: number; ecart: number }) => {
    if (r.ecart === 0) return 'text-zinc-400';
    const good = r.classNo === 6 ? r.ecart < 0 : r.ecart > 0;
    return good ? 'text-emerald-400' : 'text-rose-400';
  };

  const Card = ({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) => (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={cn('mt-1.5 font-mono text-lg font-bold', tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-100')}>{value}</div>
    </div>
  );

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
        <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-0.5 text-sm">
          {([['budget', 'Budget vs réalisé', Target], ['forecast', 'Forecast glissant', TrendingUp], ['copilote', 'Copilote Lexa', Sparkles]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setView(k)}
              className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors', view === k ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <button onClick={() => setShowImport((v) => !v)} className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20"><Upload className="h-4 w-4" /> Importer</button>
          <button onClick={exportPdf} disabled={!data} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><Printer className="h-4 w-4" /> État comparatif</button>
          <button onClick={exportCsv} disabled={!data} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><FileSpreadsheet className="h-4 w-4" /> CSV</button>
        </div>
      </div>

      {view === 'budget' ? (<>
      {showImport && (
        <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-zinc-300">Import du budget (CSV : <span className="font-mono text-zinc-400">Compte ; Libellé ; Montant</span>) — comptes de classe 6 et 7</div>
            <div className="flex gap-2">
              <button onClick={() => setCsv(SAMPLE_BUDGET)} className="text-xs text-zinc-400 hover:text-emerald-400">Exemple</button>
              <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-emerald-400"><FileSpreadsheet className="h-3.5 w-3.5" /> Fichier…</button>
              <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </div>
          </div>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} placeholder={SAMPLE_BUDGET}
            className="w-full rounded-xl border border-white/10 bg-zinc-900/60 p-3 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />
          <button onClick={doImport} disabled={importing || !csv.trim()} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Importer le budget</button>
          {importMsg && <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {importMsg}</p>}
          <p className="text-xs text-zinc-500">Les montants acceptent les espaces de milliers et la virgule décimale. Un compte déjà budgété est mis à jour.</p>
        </div>
      )}

      {t && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card label="Résultat budgété" value={m(t.resultatBudget)} tone={t.resultatBudget >= 0 ? 'pos' : 'neg'} />
          <Card label="Résultat réalisé" value={m(t.resultatRealise)} tone={t.resultatRealise >= 0 ? 'pos' : 'neg'} />
          <Card label="Écart (réalisé − budgété)" value={m(t.resultatRealise - t.resultatBudget)} tone={t.resultatRealise - t.resultatBudget >= 0 ? 'pos' : 'neg'} />
        </div>
      )}

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
      </>) : view === 'forecast' ? (
        <ForecastView fc={fc} loading={fcLoading} currency={currency} />
      ) : (
        <BudgetCopilot dossierId={dossierId} fy={fy} currency={currency} onApplied={() => { setView('budget'); load(); }} />
      )}
    </div>
  );
}

// Forecast glissant : réel à date, écart de rythme, et projection de fin d'année.
function ForecastView({ fc, loading, currency }: { fc: RollingForecast | null; loading: boolean; currency: string }) {
  const m = (n: number) => fmtMoney(n, currency);
  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Projection…</div>;
  if (!fc) return null;
  const t = fc.totals;
  const p = fc.period;
  const charges = fc.rows.filter((r) => r.classNo === 6);
  const produits = fc.rows.filter((r) => r.classNo === 7);

  const Table = ({ title, rows }: { title: string; rows: RollingForecast['rows'] }) => (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
      <div className="border-b border-white/10 px-4 py-2.5 text-xs uppercase text-zinc-400">{title}</div>
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs uppercase text-zinc-500"><tr className="border-b border-white/10">
          <th className="px-3 py-2 text-left font-medium">Compte</th><th className="px-3 py-2 text-left font-medium">Intitulé</th>
          <th className="px-3 py-2 text-right font-medium">Budget an.</th><th className="px-3 py-2 text-right font-medium">Réel à date</th>
          <th className="px-3 py-2 text-right font-medium">Écart rythme</th><th className="px-3 py-2 text-right font-medium">Projeté fin d'année</th>
          <th className="px-3 py-2 text-right font-medium">vs budget</th>
        </tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.account_code} className="border-b border-white/5">
            <td className="px-3 py-1.5 font-mono text-xs text-zinc-400">{r.account_code}</td>
            <td className="px-3 py-1.5 text-zinc-300">{r.label}</td>
            <td className="px-3 py-1.5 text-right font-mono text-zinc-400">{r.budget ? m(r.budget) : '—'}</td>
            <td className="px-3 py-1.5 text-right font-mono text-zinc-200">{m(r.realise)}</td>
            <td className={cn('px-3 py-1.5 text-right font-mono', r.ecartRythme > 0 ? 'text-amber-400' : 'text-zinc-500')}>{r.budget ? (r.ecartRythme > 0 ? '+' : '') + m(r.ecartRythme) : '—'}</td>
            <td className="px-3 py-1.5 text-right font-mono font-semibold text-emerald-300">{m(r.projete)}</td>
            <td className={cn('px-3 py-1.5 text-right font-mono', !r.budget ? 'text-zinc-600' : r.ecartProjete > 0 ? 'text-rose-400' : 'text-emerald-400')}>{r.budget ? (r.ecartProjete > 0 ? '+' : '') + m(r.ecartProjete) : '—'}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-zinc-300">
        <Gauge className="h-4 w-4 text-emerald-400" />
        <span><b className="text-zinc-100">{p.monthsElapsed} mois</b> écoulés sur « {p.label} » ({Math.round(p.fractionElapsed * 100)} %).</span>
        <span className="text-zinc-500">Projection = extrapolation linéaire du rythme (run-rate), hors saisonnalité.</span>
      </div>

      {!fc.hasBudget && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">Aucun budget saisi pour cet exercice : la projection s'appuie sur le seul rythme du réalisé. Saisissez un budget (onglet « Budget vs réalisé ») pour obtenir les écarts.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <FCard label="Résultat réalisé à date" value={m(t.resultatRealise)} tone={t.resultatRealise >= 0 ? 'pos' : 'neg'} />
        <FCard label="Résultat projeté (fin d'année)" value={m(t.resultatProjete)} tone={t.resultatProjete >= 0 ? 'pos' : 'neg'} highlight />
        {fc.hasBudget && <FCard label="Projeté − budget" value={(t.resultatProjete - t.resultatBudget >= 0 ? '+' : '') + m(t.resultatProjete - t.resultatBudget)} tone={t.resultatProjete - t.resultatBudget >= 0 ? 'pos' : 'neg'} />}
      </div>

      <Table title="Produits (classe 7)" rows={produits} />
      <Table title="Charges (classe 6)" rows={charges} />
    </div>
  );
}

function FCard({ label, value, tone, highlight }: { label: string; value: string; tone?: 'pos' | 'neg'; highlight?: boolean }) {
  return (
    <div className={cn('rounded-2xl border p-4', highlight ? 'border-emerald-500/40 bg-emerald-500/[0.07]' : 'border-white/10 bg-white/5')}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cn('mt-1 font-mono text-xl font-bold', tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-100')}>{value}</div>
    </div>
  );
}
