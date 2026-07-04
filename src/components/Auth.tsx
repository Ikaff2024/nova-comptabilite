import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Hexagon, Loader2, Mail, Lock, User, ShieldCheck } from 'lucide-react';
import { api, type AuthUser } from '../lib/api';
import { setToken } from '../lib/session';

export default function Auth({ onAuth }: { onAuth: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const res = mode === 'login'
        ? await api.login(email.trim(), password, needCode ? code.trim() : undefined)
        : await api.register(email.trim(), password, name.trim());
      setToken(res.token);
      onAuth(res.user);
    } catch (err: any) {
      if (err.code === '2FA_REQUIRED') { setNeedCode(true); setError(null); }
      else { setError(err.message); }
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
            <h1 className="font-display text-xl font-bold tracking-tight">Nova Comptabilité</h1>
            <p className="text-sm text-zinc-400">{mode === 'login' ? 'Connexion à votre espace' : 'Créer un compte'}</p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-8 space-y-4">
          {mode === 'register' && (
            <Field icon={User} label="Nom complet">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Aya Koné"
                className="w-full bg-transparent text-sm outline-none placeholder-zinc-500" />
            </Field>
          )}
          <Field icon={Mail} label="Email">
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@cabinet.ci" autoComplete="email"
              className="w-full bg-transparent text-sm outline-none placeholder-zinc-500" />
          </Field>
          <Field icon={Lock} label="Mot de passe">
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              className="w-full bg-transparent text-sm outline-none placeholder-zinc-500" />
          </Field>

          {needCode && mode === 'login' && (
            <Field icon={ShieldCheck} label="Code de vérification (2FA)">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" autoFocus
                className="w-full bg-transparent font-mono text-sm tracking-widest outline-none placeholder-zinc-500" />
            </Field>
          )}

          {needCode && <p className="text-xs text-zinc-500">Saisissez le code à 6 chiffres de votre application d'authentification.</p>}
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

          <button type="submit" disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50">
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === 'login' ? (needCode ? 'Vérifier & se connecter' : 'Se connecter') : 'Créer mon compte'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-400">
          {mode === 'login' ? "Pas encore de compte ?" : 'Déjà inscrit ?'}{' '}
          <button onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
            className="font-medium text-emerald-400 hover:text-emerald-300">
            {mode === 'login' ? "S'inscrire" : 'Se connecter'}
          </button>
        </p>
      </motion.div>
    </div>
  );
}

function Field({ icon: Icon, label, children }: { icon: any; label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-zinc-300">{label}</span>
      <div className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 focus-within:border-emerald-500/50">
        <Icon className="h-4 w-4 shrink-0 text-zinc-500" />
        {children}
      </div>
    </label>
  );
}
