import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Smartphone, ArrowDownLeft, ArrowUpRight, CheckCircle2, Download } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type MMProposal } from '../lib/api';

const PROVIDERS = [
  { v: 'wave', l: 'Wave' }, { v: 'om', l: 'Orange Money' }, { v: 'momo', l: 'MTN MoMo' }, { v: 'moov', l: 'Moov Money' },
];

type Row = MMProposal & { include: boolean };

export default function MobileMoney({
  dossierId, fiscalYears, currency, onImported,
}: {
  dossierId: string; fiscalYears: FiscalYear[]; currency: string; onImported: () => void;
}) {
  const [provider, setProvider] = useState('wave');
  const [content, setContent] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [treasury, setTreasury] = useState('521');
  const [fy, setFy] = useState(fiscalYears[0]?.id ?? '');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: any[] } | null>(null);

  const analyze = async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await api.mmParse(dossierId, provider, content);
      setRows(r.proposals.map((p) => ({ ...p, include: !p.alreadyImported })));
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs!.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const selected = rows?.filter((r) => r.include && !r.alreadyImported) ?? [];

  const doImport = async () => {
    setImporting(true); setError(null);
    try {
      const entries = selected.map((r) => ({
        externalRef: r.externalRef, date: r.date, description: r.description,
        direction: r.direction, amount: r.amount, counterAccount: r.counterAccount,
        channel: r.channel, counterparty: r.counterparty,
      }));
      const res = await api.mmImport(dossierId, { fiscalYearId: fy, treasuryCode: treasury, entries });
      setResult(res);
      onImported();
      // marque les importés comme déjà importés
      const done = new Set(entries.map((e) => e.externalRef));
      setRows((rs) => rs!.map((r) => (done.has(r.externalRef) ? { ...r, alreadyImported: true, include: false } : r)));
    } catch (e: any) { setError(e.message); } finally { setImporting(false); }
  };

  return (
    <div className="space-y-6">
      {/* Saisie du relevé */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="mb-4 flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-emerald-400" />
          <h3 className="font-display text-lg font-semibold">Importer un relevé Mobile Money</h3>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Opérateur</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}
              className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
              {PROVIDERS.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
            </select>
          </div>
        </div>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6}
          placeholder={"Collez l'export CSV du relevé (date, type, montant, contrepartie, id)…\n2024-07-02;Paiement reçu;150000;Boutique Awa;TX1001"}
          className="mt-3 w-full rounded-lg border border-white/10 bg-zinc-900/60 p-3 font-mono text-xs outline-none focus:border-emerald-500/50" />
        <div className="mt-3 flex justify-end">
          <button onClick={analyze} disabled={loading || !content.trim()}
            className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Analyser le relevé
          </button>
        </div>
        {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      </div>

      {result && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          <CheckCircle2 className="h-4 w-4" /> {result.imported} écriture(s) importée(s) · {result.skipped} déjà présente(s){result.errors.length ? ` · ${result.errors.length} erreur(s)` : ''}.
        </div>
      )}

      {/* Réconciliation */}
      {rows && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex items-end gap-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Compte de trésorerie (Mobile Money)</label>
                <input value={treasury} onChange={(e) => setTreasury(e.target.value)}
                  className="w-28 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Exercice</label>
                <select value={fy} onChange={(e) => setFy(e.target.value)}
                  className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
                  {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </div>
            </div>
            <button onClick={doImport} disabled={importing || selected.length === 0}
              className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">
              {importing && <Loader2 className="h-4 w-4 animate-spin" />} Importer {selected.length} écriture(s)
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-3 py-3"></th>
                  <th className="px-3 py-3 font-medium">Date</th>
                  <th className="px-3 py-3 font-medium">Sens</th>
                  <th className="px-3 py-3 font-medium">Tiers</th>
                  <th className="px-3 py-3 text-right font-medium">Montant</th>
                  <th className="px-3 py-3 font-medium">Compte contrepartie</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {rows.map((r, i) => (
                  <tr key={r.externalRef} className={r.alreadyImported ? 'opacity-40' : 'hover:bg-white/5'}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={r.include} disabled={r.alreadyImported}
                        onChange={(e) => setRow(i, { include: e.target.checked })} className="accent-emerald-500" />
                    </td>
                    <td className="px-3 py-2 text-zinc-400">{r.date}</td>
                    <td className="px-3 py-2">
                      {r.direction === 'in'
                        ? <span className="inline-flex items-center gap-1 text-emerald-400"><ArrowDownLeft className="h-3.5 w-3.5" /> Encaiss.</span>
                        : <span className="inline-flex items-center gap-1 text-rose-400"><ArrowUpRight className="h-3.5 w-3.5" /> Décaiss.</span>}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">{r.counterparty || <span className="text-zinc-600">—</span>}{r.alreadyImported && <span className="ml-2 text-xs text-amber-500">déjà importé</span>}</td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-200">{fmtMoney(r.amount, currency)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input value={r.counterAccount} disabled={r.alreadyImported}
                          onChange={(e) => setRow(i, { counterAccount: e.target.value })}
                          className="w-20 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1 font-mono text-sm outline-none focus:border-emerald-500/50" />
                        <span className="text-xs text-zinc-500">{r.counterLabel}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">Le compte de trésorerie (Mobile Money) est imputé sur chaque mouvement ; la contrepartie est pré-suggérée (règles + apprentissage) et modifiable. Les mouvements déjà importés sont ignorés (déduplication).</p>
        </motion.div>
      )}
    </div>
  );
}
