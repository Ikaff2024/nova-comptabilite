import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Hexagon, Loader2, Building2, Briefcase, ArrowLeft } from 'lucide-react';
import { api, OHADA_COUNTRIES } from '../lib/api';

type Kind = 'cabinet' | 'entreprise';

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('CI');
  const [taxId, setTaxId] = useState('');
  const [rccm, setRccm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !kind) return;
    setLoading(true); setError(null);
    try {
      const { cabinetId } = await api.onboard(name.trim(), country, kind);
      // En mode entreprise, on crée directement le dossier de l'entreprise :
      // pas de « portefeuille », l'utilisateur atterrit dans sa comptabilité.
      if (kind === 'entreprise') {
        await api.createDossier({ cabinetId, raisonSociale: name.trim(), country, taxId: taxId.trim() || undefined, rccm: rccm.trim() || undefined });
      }
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Étape 1 — choix du type de compte.
  if (!kind) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-50">
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20">
              <Hexagon className="h-6 w-6 text-zinc-950" fill="currentColor" />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight">Bienvenue sur Nova</h1>
              <p className="text-sm text-zinc-400">Comment allez-vous utiliser Nova ?</p>
            </div>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <button onClick={() => setKind('entreprise')}
              className="group rounded-2xl border border-white/10 bg-zinc-900/40 p-6 text-left transition-all hover:border-emerald-500/50 hover:bg-white/5">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20">
                <Building2 className="h-6 w-6" />
              </div>
              <div className="mt-4 font-display text-lg font-semibold text-zinc-100">Mon entreprise</div>
              <p className="mt-1 text-sm text-zinc-400">Je gère la comptabilité et la paie de ma propre société. Lexa devient mon comptable.</p>
            </button>

            <button onClick={() => setKind('cabinet')}
              className="group rounded-2xl border border-white/10 bg-zinc-900/40 p-6 text-left transition-all hover:border-emerald-500/50 hover:bg-white/5">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/10 text-sky-400 group-hover:bg-sky-500/20">
                <Briefcase className="h-6 w-6" />
              </div>
              <div className="mt-4 font-display text-lg font-semibold text-zinc-100">Cabinet comptable</div>
              <p className="mt-1 text-sm text-zinc-400">Je tiens la comptabilité de plusieurs clients. Je pilote un portefeuille de dossiers.</p>
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // Étape 2 — nom + pays (+ identifiants pour l'entreprise).
  const isCompany = kind === 'entreprise';
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-50">
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl"
      >
        <button onClick={() => { setKind(null); setError(null); }} className="mb-4 flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200">
          <ArrowLeft className="h-4 w-4" /> Retour
        </button>
        <div className="flex items-center gap-3">
          <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${isCompany ? 'bg-emerald-500/10 text-emerald-400' : 'bg-sky-500/10 text-sky-400'}`}>
            {isCompany ? <Building2 className="h-6 w-6" /> : <Briefcase className="h-6 w-6" />}
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight">{isCompany ? 'Votre entreprise' : 'Votre cabinet'}</h1>
            <p className="text-sm text-zinc-400">{isCompany ? 'Créez votre espace pour démarrer.' : 'Créez votre cabinet pour démarrer.'}</p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-8 space-y-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">{isCompany ? "Nom de l'entreprise" : 'Nom du cabinet'}</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)} autoFocus
              placeholder={isCompany ? 'Ex : Sahel Distribution SARL' : 'Cabinet Comptable Abidjan'}
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
          {isCompany && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">NCC / IFU <span className="text-zinc-500">(optionnel)</span></label>
                <input value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="N° contribuable"
                  className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">RCCM <span className="text-zinc-500">(optionnel)</span></label>
                <input value={rccm} onChange={(e) => setRccm(e.target.value)} placeholder="Registre du commerce"
                  className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50" />
              </div>
            </div>
          )}
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
          <button
            type="submit" disabled={loading || !name.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {isCompany ? 'Créer mon espace' : 'Créer mon cabinet'}
          </button>
        </form>
      </motion.div>
    </div>
  );
}
