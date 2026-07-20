import React, { useState } from 'react';
import { Loader2, Upload, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, type FiscalYear, type LedgerAnalysis } from '../lib/api';

// Import du grand livre (reprise des mouvements détaillés d'un autre logiciel).
// Complète l'import de balance : ici on reprend l'HISTORIQUE ligne à ligne.

async function readSmart(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

export default function ImportLedger({ dossierId, fiscalYears }: { dossierId: string; fiscalYears: FiscalYear[] }) {
  const openFy = fiscalYears.find((f) => f.status === 'open') ?? fiscalYears[0];
  const [fy, setFy] = useState(openFy?.id ?? '');
  const [csv, setCsv] = useState('');
  const [createMissing, setCreateMissing] = useState(true);
  const [analysis, setAnalysis] = useState<LedgerAnalysis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    setCsv(await readSmart(f)); setAnalysis(null); setDone(null);
  };

  const analyze = async () => {
    setBusy('a'); setError(null); setDone(null);
    try { setAnalysis(await api.analyzeLedgerImport(dossierId, csv, fy || undefined)); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const commit = async () => {
    if (!fy) { setError('Sélectionnez un exercice.'); return; }
    if (!confirm('Importer ces écritures dans le grand livre ? Elles sont comptabilisées (immuables) — à faire une seule fois, lors de la reprise.')) return;
    setBusy('c'); setError(null);
    try {
      const r = await api.commitLedgerImport(dossierId, csv, fy, createMissing);
      setDone(`${r.entriesCreated} écriture(s) importée(s) (${r.movements} mouvements)${r.accountsCreated ? `, ${r.accountsCreated} compte(s) créé(s)` : ''}.`);
      setAnalysis(null); setCsv('');
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const input = 'rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';
  const blockers = analysis && (!analysis.balanced || analysis.unbalanced.length > 0 || analysis.alreadyImported || (analysis.missingAccounts.length > 0 && !createMissing));

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Upload className="h-4 w-4 text-emerald-400" /> Import du grand livre (reprise des mouvements)</div>
        <p className="mt-1 text-xs text-zinc-500">Colonnes attendues : <span className="font-mono">Date ; Journal ; Pièce ; Compte ; Libellé ; Débit ; Crédit</span>. Les lignes sont regroupées en écritures par date + journal + pièce ; chaque écriture doit être équilibrée.</p>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div><label className="mb-1 block text-xs text-zinc-500">Exercice</label>
            <select value={fy} onChange={(e) => setFy(e.target.value)} className={input}>
              {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Fichier CSV</label>
            <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="text-xs text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-zinc-200" /></div>
          <label className="flex items-center gap-1.5 text-xs text-zinc-400"><input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} className="accent-emerald-500" /> créer les comptes absents</label>
        </div>

        <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setAnalysis(null); }} rows={6}
          placeholder="…ou collez ici le grand livre (CSV)"
          className="mt-3 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-emerald-500/50" />

        <div className="mt-3 flex items-center gap-3">
          <button onClick={analyze} disabled={busy === 'a' || !csv.trim()} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-50">
            {busy === 'a' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Analyser
          </button>
          {analysis && !blockers && (
            <button onClick={commit} disabled={busy === 'c'} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
              {busy === 'c' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Importer {analysis.entries} écriture(s)
            </button>
          )}
        </div>
      </div>

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {done && <p className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" /> {done}</p>}

      {analysis && (
        <div className="space-y-2 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm">
          <div className="grid gap-2 sm:grid-cols-4">
            <Stat label="Écritures" value={String(analysis.entries)} />
            <Stat label="Mouvements" value={String(analysis.movements)} />
            <Stat label="Total débit" value={analysis.totalDebit.toLocaleString('fr-FR')} />
            <Stat label="Équilibre" value={analysis.balanced ? '✓ équilibré' : '✗ déséquilibré'} tone={analysis.balanced ? 'ok' : 'bad'} />
          </div>
          {analysis.alreadyImported && <Warn>Un grand livre a déjà été importé pour ce dossier. Contre-passez les écritures « IMP- » avant de réimporter.</Warn>}
          {analysis.unbalanced.length > 0 && <Warn>{analysis.unbalanced.length} écriture(s) déséquilibrée(s) : {analysis.unbalanced.slice(0, 4).map((u) => `${u.date}/${u.journal} (écart ${u.ecart})`).join(', ')}… Vérifiez le regroupement par pièce.</Warn>}
          {analysis.missingAccounts.length > 0 && <Warn tone={createMissing ? 'info' : 'bad'}>{analysis.missingAccounts.length} compte(s) absent(s) du plan : {analysis.missingAccounts.slice(0, 8).join(', ')}{analysis.missingAccounts.length > 8 ? '…' : ''}. {createMissing ? 'Ils seront créés automatiquement.' : 'Cochez « créer les comptes absents ».'}</Warn>}
          {analysis.invalidDates > 0 && <Warn tone="info">{analysis.invalidDates} ligne(s) avec une date illisible seront ignorées.</Warn>}
          {analysis.outOfRange > 0 && <Warn tone="info">{analysis.outOfRange} écriture(s) hors des dates de l'exercice sélectionné.</Warn>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  return <div className="rounded-lg border border-white/5 bg-zinc-900/40 px-3 py-2">
    <div className="text-xs text-zinc-500">{label}</div>
    <div className={`font-mono text-sm font-semibold ${tone === 'bad' ? 'text-rose-400' : tone === 'ok' ? 'text-emerald-400' : 'text-zinc-100'}`}>{value}</div>
  </div>;
}
function Warn({ children, tone = 'bad' }: { children: React.ReactNode; tone?: 'bad' | 'info' }) {
  return <p className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${tone === 'info' ? 'bg-sky-500/10 text-sky-300' : 'bg-amber-500/10 text-amber-300'}`}><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{children}</p>;
}
