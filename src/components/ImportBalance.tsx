import React, { useRef, useState } from 'react';
import { Loader2, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Wand2, ArrowRight } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type ImportBalanceAnalysis } from '../lib/api';
import { cn } from '../lib/utils';

const SAMPLE = `Compte;Libellé;Débit;Crédit
101;Capital social;;5000000
211;Terrains;3000000;
411;Clients;1250000;
401;Fournisseurs;;850000
521;Banque;2600000;
571;Caisse;150000;
120;Report à nouveau;;1150000`;

export default function ImportBalance({ dossierId, dossierName, fiscalYears, currency }: {
  dossierId: string; dossierName: string; fiscalYears: FiscalYear[]; currency: string;
}) {
  const openFy = fiscalYears.find((f) => f.status === 'open') ?? fiscalYears[0];
  const [csv, setCsv] = useState('');
  const [fiscalYearId, setFiscalYearId] = useState(openFy?.id ?? '');
  const [date, setDate] = useState(openFy?.start_date ?? new Date().toISOString().slice(0, 10));
  const [createMissing, setCreateMissing] = useState(true);
  const [analysis, setAnalysis] = useState<ImportBalanceAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const analyze = async () => {
    setAnalyzing(true); setError(null); setDone(null); setAnalysis(null);
    try { setAnalysis(await api.analyzeBalanceImport(dossierId, { csv, fiscalYearId })); }
    catch (e: any) { setError(e.message); }
    finally { setAnalyzing(false); }
  };

  const commit = async () => {
    if (!fiscalYearId || !date) { setError('Choisissez un exercice et une date.'); return; }
    if (!confirm(`Générer l'écriture d'à-nouveaux (reprise) au ${date} ?`)) return;
    setCommitting(true); setError(null); setDone(null);
    try {
      const r = await api.commitBalanceImport(dossierId, { csv, fiscalYearId, date, createMissing });
      setDone(`Reprise comptabilisée : ${r.lines} comptes${r.accountsCreated ? `, ${r.accountsCreated} compte(s) créé(s)` : ''}, total ${fmtMoney(r.totalDebit, currency)}.`);
      setAnalysis(null); setCsv('');
    } catch (e: any) { setError(e.message); }
    finally { setCommitting(false); }
  };

  const onFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result ?? '')); setAnalysis(null); setDone(null); };
    reader.readAsText(f, 'utf-8');
  };

  const canCommit = analysis && analysis.balanced && !analysis.alreadyImported && analysis.lines.length >= 2
    && (analysis.missingCount === 0 || createMissing);

  const missingBlocked = !!analysis && analysis.missingCount > 0 && !createMissing;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-zinc-300"><Upload className="h-4 w-4 text-emerald-400" /> Reprise de balance (migration depuis un autre logiciel)</div>
        <p className="mt-1 text-sm text-zinc-500">Collez ou importez votre balance (CSV). Nova la contrôle puis génère une écriture d'à-nouveaux dans le journal <span className="font-mono">AN</span>. La balance doit être équilibrée (Σ débit = Σ crédit).</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs uppercase text-zinc-400">Balance (CSV : Compte ; Libellé ; Débit ; Crédit)</label>
            <div className="flex gap-2">
              <button onClick={() => { setCsv(SAMPLE); setAnalysis(null); setDone(null); }} className="text-xs text-zinc-400 hover:text-emerald-400">Exemple</button>
              <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-emerald-400"><FileSpreadsheet className="h-3.5 w-3.5" /> Fichier…</button>
              <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </div>
          </div>
          <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setAnalysis(null); setDone(null); }} rows={10}
            placeholder={SAMPLE}
            className="w-full rounded-xl border border-white/10 bg-zinc-900/60 p-3 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs uppercase text-zinc-400">Exercice</label>
            <select value={fiscalYearId} onChange={(e) => setFiscalYearId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
              {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}{f.status === 'closed' ? ' (clôturé)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase text-zinc-400">Date de l'à-nouveau</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
          </div>
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} className="mt-0.5 accent-emerald-500" />
            <span>Créer les comptes absents du plan<br /><span className="text-xs text-zinc-500">recommandé pour une reprise complète</span></span>
          </label>
          <button onClick={analyze} disabled={analyzing || !csv.trim()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-40">
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Analyser
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {done && <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {done}</p>}

      {analysis && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <Kpi label="Comptes" value={String(analysis.lines.length)} />
            <Kpi label="Total débit" value={fmtMoney(analysis.totalDebit, currency)} />
            <Kpi label="Total crédit" value={fmtMoney(analysis.totalCredit, currency)} />
            <div className={cn('rounded-2xl border p-4', analysis.balanced ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-rose-500/30 bg-rose-500/10')}>
              <div className="text-sm text-zinc-400">Équilibre</div>
              <div className={cn('mt-2 font-mono text-lg font-bold', analysis.balanced ? 'text-emerald-400' : 'text-rose-400')}>
                {analysis.balanced ? '✓ équilibrée' : `écart ${fmtMoney(analysis.diff, currency)}`}
              </div>
            </div>
          </div>

          {analysis.alreadyImported && (
            <p className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300"><AlertTriangle className="h-4 w-4" /> Une balance d'ouverture existe déjà pour cet exercice. Contre-passez-la avant de réimporter.</p>
          )}
          {analysis.missingCount > 0 && (
            <p className={cn('flex items-center gap-2 rounded-lg px-3 py-2 text-sm', createMissing ? 'bg-sky-500/10 text-sky-300' : 'bg-amber-500/10 text-amber-300')}>
              <AlertTriangle className="h-4 w-4" /> {analysis.missingCount} compte(s) absent(s) du plan — {createMissing ? 'ils seront créés automatiquement.' : 'activez « Créer les comptes absents » ou ajoutez-les au plan.'}
            </p>
          )}

          <div className="max-h-96 overflow-auto rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 border-b border-white/10 bg-zinc-900 text-xs uppercase text-zinc-400">
                <tr><th className="px-4 py-2.5 font-medium">Compte</th><th className="px-4 py-2.5 font-medium">Intitulé</th><th className="px-4 py-2.5 text-right font-medium">Débit</th><th className="px-4 py-2.5 text-right font-medium">Crédit</th><th className="px-4 py-2.5 font-medium">État</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {analysis.lines.map((l) => (
                  <tr key={l.accountCode} className="hover:bg-white/5">
                    <td className="px-4 py-2 text-zinc-300">{l.accountCode}</td>
                    <td className="px-4 py-2 font-sans text-zinc-400">{l.existingLabel ?? l.label ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-300">{l.debit ? fmtMoney(l.debit, currency) : '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-300">{l.credit ? fmtMoney(l.credit, currency) : '—'}</td>
                    <td className="px-4 py-2">
                      {l.status === 'ok'
                        ? <span className="text-xs text-emerald-400">au plan</span>
                        : <span className={cn('text-xs', createMissing ? 'text-sky-400' : 'text-amber-400')}>{createMissing ? 'à créer' : 'absent'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <button onClick={commit} disabled={!canCommit || committing}
              className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">
              {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              Comptabiliser la reprise
            </button>
          </div>
          {missingBlocked && <p className="text-right text-xs text-amber-400">Import bloqué tant que des comptes sont absents.</p>}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="text-sm text-zinc-400">{label}</div>
      <div className="mt-2 font-mono text-lg font-bold text-zinc-100">{value}</div>
    </div>
  );
}
