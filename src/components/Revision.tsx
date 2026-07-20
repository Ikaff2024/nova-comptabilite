import React, { useEffect, useState } from 'react';
import { Loader2, ClipboardCheck, CheckCircle2, Circle, ShieldCheck, AlertTriangle, ChevronDown } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type RevisionReport, type RevisionAccount, type InterModuleReport, type CoherenceNiveau, type QualityScore } from '../lib/api';
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

      <QualityScorePanel dossierId={dossierId} fy={fy} />
      <CoherencePanel dossierId={dossierId} fy={fy} currency={currency} />

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

// AQM 2.0 — cohérence inter-modules : la paie/les immos correspondent-elles à la
// compta ? Panneau repliable en tête de la révision.
const NIVEAU_STYLE: Record<CoherenceNiveau, { chip: string; label: string; ring: string }> = {
  haute: { chip: 'bg-rose-500/15 text-rose-300 border-rose-500/30', label: 'Risque élevé', ring: 'text-rose-400' },
  moyenne: { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30', label: 'À vérifier', ring: 'text-amber-400' },
  info: { chip: 'bg-sky-500/15 text-sky-300 border-sky-500/30', label: 'Info', ring: 'text-sky-400' },
  ok: { chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', label: 'Cohérent', ring: 'text-emerald-400' },
};

function CoherencePanel({ dossierId, fy, currency }: { dossierId: string; fy: string; currency: string }) {
  const [data, setData] = useState<InterModuleReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);
  const m = (n: number) => fmtMoney(n, currency);

  useEffect(() => { let on = true; setLoading(true); api.coherence(dossierId, fy || undefined).then((d) => { if (on) setData(d); }).catch(() => { if (on) setData(null); }).finally(() => { if (on) setLoading(false); }); return () => { on = false; }; }, [dossierId, fy]);

  if (loading) return <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Contrôle de cohérence inter-modules…</div>;
  if (!data || data.controles.length === 0) return null;

  const gStyle = NIVEAU_STYLE[data.niveauGlobal];
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]">
        <ShieldCheck className={cn('h-5 w-5', gStyle.ring)} />
        <div className="flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">Cohérence inter-modules <span className="text-xs font-normal text-zinc-500">(AQM 2.0)</span></div>
          <div className="text-xs text-zinc-500">Paie, immobilisations et comptabilité racontent-elles la même histoire ?{data.exercice ? ` · ${data.exercice}` : ''}</div>
        </div>
        <span className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', gStyle.chip)}>{gStyle.label}</span>
        {(data.resume.haute + data.resume.moyenne) > 0 && <span className="flex items-center gap-1 text-xs text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> {data.resume.haute + data.resume.moyenne}</span>}
        <ChevronDown className={cn('h-4 w-4 text-zinc-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="divide-y divide-white/5 border-t border-white/10">
          {data.controles.map((chk) => {
            const s = NIVEAU_STYLE[chk.niveau];
            return (
              <div key={chk.regle} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', s.chip)}>{s.label}</span>
                  <span className="text-sm font-medium text-zinc-200">{chk.libelle}</span>
                  <span className="text-xs text-zinc-500">· {chk.module}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-400">{chk.explication}</p>
                {(chk.attendu !== 0 || chk.constate !== 0) && (
                  <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                    <span className="text-zinc-500">Attendu <span className="font-mono text-zinc-300">{m(chk.attendu)}</span></span>
                    <span className="text-zinc-500">Constaté <span className="font-mono text-zinc-300">{m(chk.constate)}</span></span>
                    {chk.ecart !== 0 && <span className="text-zinc-500">Écart <span className={cn('font-mono', chk.niveau === 'ok' ? 'text-zinc-300' : s.ring)}>{m(chk.ecart)}</span></span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Score de qualité comptable : fiabilité de la tenue (distinct du score crédit).
const RATING_COLOR: Record<string, string> = { A: '#34d399', B: '#a3e635', C: '#fbbf24', D: '#fb7185' };

function QualityScorePanel({ dossierId, fy }: { dossierId: string; fy: string }) {
  const [d, setD] = useState<QualityScore | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { let on = true; setLoading(true); api.qualityScore(dossierId, fy || undefined).then((x) => { if (on) setD(x); }).catch(() => { if (on) setD(null); }).finally(() => { if (on) setLoading(false); }); return () => { on = false; }; }, [dossierId, fy]);

  if (loading) return <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Score de qualité…</div>;
  if (!d) return null;
  const color = RATING_COLOR[d.rating] ?? '#a1a1aa';

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-3">
          <div className="relative flex h-16 w-16 items-center justify-center">
            <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
              <circle cx="32" cy="32" r="28" fill="none" stroke="#ffffff14" strokeWidth="6" />
              <circle cx="32" cy="32" r="28" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 28} strokeDashoffset={2 * Math.PI * 28 * (1 - d.score / 100)} />
            </svg>
            <span className="absolute font-mono text-lg font-bold text-zinc-50">{d.score}</span>
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">Qualité comptable <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: `${color}22`, color }}>Note {d.rating}</span></div>
            <div className="text-xs text-zinc-500">Fiabilité de la tenue · sur 100</div>
          </div>
        </div>
        <div className="flex flex-1 flex-wrap gap-x-5 gap-y-1">
          {d.axes.map((a) => (
            <div key={a.key} className="min-w-[130px]" title={a.detail}>
              <div className="flex items-center justify-between text-xs"><span className="text-zinc-400">{a.label}</span><span className="font-mono text-zinc-200">{a.score}</span></div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full" style={{ width: `${a.score}%`, background: a.score >= 70 ? '#34d399' : a.score >= 50 ? '#fbbf24' : '#fb7185' }} /></div>
            </div>
          ))}
        </div>
      </div>
      {(d.forces.length > 0 || d.faiblesses.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {d.forces.length > 0 && <span className="text-emerald-300">↗ Points forts : {d.forces.join(', ')}</span>}
          {d.faiblesses.length > 0 && <span className="text-rose-300">↘ À fiabiliser : {d.faiblesses.join(', ')}</span>}
        </div>
      )}
    </div>
  );
}
