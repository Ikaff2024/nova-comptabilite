import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Pin, Sparkles, ShieldCheck } from 'lucide-react';
import { api, type Mapping } from '../lib/api';

export default function RulesTab({ dossierId }: { dossierId: string }) {
  const [rows, setRows] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => { setLoading(true); try { setRows(await api.mappings(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const manual = rows.filter((r) => r.source === 'manual');
  const learned = rows.filter((r) => r.source === 'learned');

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyword.trim() || !code.trim()) return;
    setBusy(true); setError(null);
    try { await api.createRule(dossierId, keyword.trim(), code.trim()); setKeyword(''); setCode(''); await load(); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const promote = async (m: Mapping) => { await api.createRule(dossierId, m.keyword, m.account_code); await load(); };
  const remove = async (m: Mapping) => { await api.deleteMapping(dossierId, m.id); await load(); };

  return (
    <div className="space-y-8">
      {/* Règles manuelles */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-400" />
          <h3 className="font-display text-lg font-semibold">Règles de codification</h3>
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">priorité absolue</span>
        </div>
        <p className="mb-5 text-sm text-zinc-400">
          Forcez l'IA : quand un libellé ou un tiers correspond, le compte indiqué est imposé (« orange » → 628, « loyer » → 6221).
        </p>

        <form onSubmit={add} className="mb-5 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[12rem]">
            <label className="mb-1 block text-xs text-zinc-500">Libellé / tiers contient…</label>
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="orange"
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
          </div>
          <div className="w-32">
            <label className="mb-1 block text-xs text-zinc-500">Compte</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="628"
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" />
          </div>
          <button type="submit" disabled={busy}
            className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter
          </button>
        </form>
        {error && <p className="mb-4 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

        {loading ? (
          <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        ) : manual.length === 0 ? (
          <p className="text-sm text-zinc-500">Aucune règle manuelle. L'IA s'appuie sur le plan et l'apprentissage.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {manual.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="flex items-center gap-3">
                  <span className="rounded-md bg-white/5 px-2 py-1 text-zinc-200">{m.keyword}</span>
                  <span className="text-zinc-500">→</span>
                  <span className="font-mono text-emerald-400">{m.account_code}</span>
                  <span className="text-zinc-500">{m.account_label}</span>
                </div>
                <button onClick={() => remove(m)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Appris automatiquement */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-zinc-400" />
          <h3 className="font-display text-lg font-semibold">Appris des validations</h3>
        </div>
        {loading ? null : learned.length === 0 ? (
          <p className="text-sm text-zinc-500">Rien encore. Validez des écritures (saisie ou capture) pour enrichir la mémoire.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {learned.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="flex items-center gap-3">
                  <span className="rounded-md bg-white/5 px-2 py-1 text-zinc-300">{m.keyword}</span>
                  <span className="text-zinc-500">→</span>
                  <span className="font-mono text-zinc-200">{m.account_code}</span>
                  <span className="text-zinc-500">{m.account_label}</span>
                  <span className="text-xs text-zinc-600">×{m.hits}</span>
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={() => promote(m)} title="Promouvoir en règle" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-emerald-400">
                    <Pin className="h-3.5 w-3.5" /> règle
                  </button>
                  <button onClick={() => remove(m)} title="Oublier" className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
