import React, { useEffect, useState } from 'react';
import { Loader2, ClipboardCheck, CheckCircle2, Circle } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type RevisionReport, type RevisionAccount } from '../lib/api';
import { cn } from '../lib/utils';

export default function Revision({ dossierId, currency, fiscalYears }: { dossierId: string; currency: string; fiscalYears: FiscalYear[] }) {
  const [fy, setFy] = useState(fiscalYears[0]?.id ?? '');
  const [data, setData] = useState<RevisionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'todo' | 'reviewed'>('all');
  const [editNote, setEditNote] = useState<string | null>(null);
  const [noteVal, setNoteVal] = useState('');
  const m = (n: number) => fmtMoney(n, currency);

  const load = async () => { if (!fy) return; setLoading(true); try { setData(await api.revisionReport(dossierId, fy)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId, fy]);

  const toggle = async (a: RevisionAccount) => {
    const next = a.status === 'reviewed' ? 'todo' : 'reviewed';
    setData((d) => d ? { ...d, accounts: d.accounts.map((x) => x.account_code === a.account_code ? { ...x, status: next } : x), progress: { ...d.progress, reviewed: d.progress.reviewed + (next === 'reviewed' ? 1 : -1) } } : d);
    try { await api.setReview(dossierId, fy, a.account_code, { status: next }); } catch { load(); }
  };
  const saveNote = async (a: RevisionAccount) => {
    setEditNote(null);
    setData((d) => d ? { ...d, accounts: d.accounts.map((x) => x.account_code === a.account_code ? { ...x, note: noteVal } : x) } : d);
    try { await api.setReview(dossierId, fy, a.account_code, { note: noteVal }); } catch { load(); }
  };

  const accounts = (data?.accounts ?? []).filter((a) => filter === 'all' || a.status === filter);
  const cycles = [...new Set(accounts.map((a) => a.cycle))];
  const pct = data && data.progress.total ? Math.round((data.progress.reviewed / data.progress.total) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><ClipboardCheck className="h-4 w-4 text-emerald-400" /> Dossier de révision — justification des comptes</div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-xs">
            {([['all', 'Tous'], ['todo', 'À réviser'], ['reviewed', 'Justifiés']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setFilter(v)} className={cn('rounded-md px-2.5 py-1 font-medium', filter === v ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>{l}</button>
            ))}
          </div>
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
      </div>

      {data && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="mb-2 flex items-center justify-between text-sm"><span className="text-zinc-300">Avancement de la révision</span><span className="font-mono text-zinc-200">{data.progress.reviewed} / {data.progress.total} comptes justifiés</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} /></div>
        </div>
      )}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        : accounts.length === 0 ? <p className="text-sm text-zinc-500">Aucun compte à afficher pour ce filtre.</p>
        : cycles.map((cycle) => (
          <div key={cycle} className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <div className="border-b border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-200">{cycle}</div>
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-white/5">
                {accounts.filter((a) => a.cycle === cycle).map((a) => (
                  <tr key={a.account_code} className={cn('hover:bg-white/5', a.status === 'reviewed' && 'bg-emerald-500/[0.04]')}>
                    <td className="w-10 px-4 py-2.5">
                      <button onClick={() => toggle(a)} title={a.status === 'reviewed' ? 'Marquer à réviser' : 'Marquer justifié'}>
                        {a.status === 'reviewed' ? <CheckCircle2 className="h-5 w-5 text-emerald-400" /> : <Circle className="h-5 w-5 text-zinc-600 hover:text-zinc-400" />}
                      </button>
                    </td>
                    <td className="px-2 py-2.5 font-mono text-zinc-400">{a.account_code}</td>
                    <td className="px-2 py-2.5 text-zinc-300">{a.label}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-zinc-200">{m(a.balance)}</td>
                    <td className="px-4 py-2.5 w-2/5">
                      {editNote === a.account_code
                        ? <input value={noteVal} autoFocus onChange={(e) => setNoteVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveNote(a)} onBlur={() => saveNote(a)} placeholder="Justification…" className="w-full rounded border border-emerald-500/40 bg-zinc-900/60 px-2 py-1 text-sm outline-none" />
                        : <span onClick={() => { setEditNote(a.account_code); setNoteVal(a.note ?? ''); }} className="block cursor-text text-xs text-zinc-500">{a.note || '+ ajouter une note de justification'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
