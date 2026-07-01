import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Hexagon, Loader2 } from 'lucide-react';
import { api, OHADA_COUNTRIES } from '../lib/api';

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [country, setCountry] = useState('CI');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true); setError(null);
    try {
      await api.onboard(name.trim(), country);
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-50">
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20">
            <Hexagon className="h-6 w-6 text-zinc-950" fill="currentColor" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight">Bienvenue sur Nova</h1>
            <p className="text-sm text-zinc-400">Créez votre cabinet pour démarrer.</p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-8 space-y-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Nom du cabinet</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)} autoFocus
              placeholder="Cabinet Comptable Abidjan"
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Pays</label>
            <select
              value={country} onChange={(e) => setCountry(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50"
            >
              {OHADA_COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </div>
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
          <button
            type="submit" disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Créer mon cabinet
          </button>
        </form>
      </motion.div>
    </div>
  );
}
