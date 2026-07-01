import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Building2, Plus, ChevronRight, Loader2, FolderOpen } from 'lucide-react';
import { api, OHADA_COUNTRIES, type Cabinet, type Dossier } from '../lib/api';

export default function Dossiers({ cabinet, onOpen }: { cabinet: Cabinet; onOpen: (d: Dossier) => void }) {
  const [dossiers, setDossiers] = useState<Dossier[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ raisonSociale: '', country: cabinet.country, accountingSystem: 'normal', taxId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setDossiers(await api.dossiers()); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.raisonSociale.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.createDossier({
        cabinetId: cabinet.id, raisonSociale: form.raisonSociale.trim(),
        country: form.country, accountingSystem: form.accountingSystem, taxId: form.taxId || undefined,
      });
      setForm({ raisonSociale: '', country: cabinet.country, accountingSystem: 'normal', taxId: '' });
      setCreating(false);
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const countryName = (code: string) => OHADA_COUNTRIES.find((c) => c.code === code)?.name ?? code;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Portefeuille de dossiers</h1>
          <p className="mt-1 text-zinc-400">{cabinet.name} · {countryName(cabinet.country)}</p>
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="flex h-10 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
        >
          <Plus className="h-4 w-4" /> Nouveau dossier
        </button>
      </div>

      {creating && (
        <motion.form
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          onSubmit={create}
          className="grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-6 sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Raison sociale</label>
            <input
              value={form.raisonSociale} onChange={(e) => setForm({ ...form, raisonSociale: e.target.value })} autoFocus
              placeholder="Boutique Wax SARL"
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Pays</label>
            <select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50">
              {OHADA_COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Système comptable</label>
            <select value={form.accountingSystem} onChange={(e) => setForm({ ...form, accountingSystem: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50">
              <option value="normal">Système normal</option>
              <option value="smt">Système Minimal de Trésorerie</option>
            </select>
          </div>
          {error && <p className="sm:col-span-2 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
          <div className="sm:col-span-2 flex justify-end gap-3">
            <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            <button type="submit" disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Créer (plan SYSCOHADA inclus)
            </button>
          </div>
        </motion.form>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : dossiers.length === 0 ? (
        <div className="flex h-[40vh] flex-col items-center justify-center text-center">
          <div className="rounded-full bg-white/5 p-4"><FolderOpen className="h-8 w-8 text-zinc-500" /></div>
          <h2 className="mt-4 font-display text-xl font-semibold">Aucun dossier</h2>
          <p className="mt-2 max-w-sm text-zinc-400">Créez votre premier dossier client — le plan comptable SYSCOHADA (1330 comptes) sera instancié automatiquement.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {dossiers.map((d, i) => (
            <motion.button
              key={d.id} onClick={() => onOpen(d)}
              initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
              className="group flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 p-5 text-left transition-colors hover:border-emerald-500/30 hover:bg-white/10"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
                  <Building2 className="h-5 w-5" />
                </div>
                <div>
                  <div className="font-medium text-zinc-100">{d.raison_sociale}</div>
                  <div className="text-xs text-zinc-500">
                    {countryName(d.country)} · {d.base_currency} · {d.accounting_system === 'smt' ? 'SMT' : 'Système normal'}
                  </div>
                </div>
              </div>
              <ChevronRight className="h-5 w-5 text-zinc-600 transition-colors group-hover:text-emerald-400" />
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}
