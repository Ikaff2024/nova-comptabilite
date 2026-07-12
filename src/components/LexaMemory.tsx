import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Brain } from 'lucide-react';
import { api } from '../lib/api';

type Mem = { id: string; content: string; source: string; created_at: string };

export default function LexaMemory({ dossierId }: { dossierId: string }) {
  const [items, setItems] = useState<Mem[] | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.lexaMemory(dossierId).then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, [dossierId]);

  const add = async () => {
    if (!content.trim()) return;
    setBusy(true); setErr(null);
    try { await api.lexaRemember(dossierId, content.trim()); setContent(''); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (id: string) => { setErr(null); try { await api.lexaForget(dossierId, id); await load(); } catch (e: any) { setErr(e.message); } };

  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Brain className="h-4 w-4 text-emerald-400" /> Mémoire de Lexa</div>
      <p className="text-xs text-zinc-500">Ce que Lexa retient sur votre entreprise (préférences, spécificités). Elle apprend au fil des échanges ; vous pouvez aussi lui apprendre une consigne durable ici.</p>
      <div className="flex gap-2">
        <input value={content} onChange={(e) => setContent(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="Ex. Nos ventes sont toujours réglées en Mobile Money." className="flex-1 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
        <button onClick={add} disabled={busy || !content.trim()} className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</button>
      </div>
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400">{err}</p>}
      {items === null ? <div className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> …</div>
        : items.length === 0 ? <p className="text-xs text-zinc-600">Lexa n'a encore rien mémorisé sur cette entreprise.</p> : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-2 rounded-lg border border-white/10 bg-zinc-900/40 px-3 py-1.5 text-sm text-zinc-300">
              <span className="flex-1">{it.content}</span>
              <span className="mt-0.5 shrink-0 text-[10px] uppercase text-zinc-600">{it.source === 'user' ? 'vous' : 'Lexa'}</span>
              <button onClick={() => del(it.id)} className="mt-0.5 shrink-0 text-zinc-600 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
