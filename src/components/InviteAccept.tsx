import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Hexagon, Loader2, Users, AlertTriangle } from 'lucide-react';
import { api, type AuthUser, type InvitationInfo } from '../lib/api';
import { setToken } from '../lib/session';

// Écran d'acceptation d'une invitation (lien reçu par email : /?invite=<token>).
// Le destinataire n'est pas encore authentifié : il crée son compte avec
// l'adresse invitée (non modifiable) et se retrouve rattaché automatiquement.
// S'il est déjà connecté, on rattache simplement son compte courant.

const ROLE_LABEL: Record<string, string> = { owner: 'Propriétaire', associe: 'Associé (admin)', collaborateur: 'Collaborateur' };

export default function InviteAccept({ token, loggedIn, onDone, onCancel }: {
  token: string; loggedIn: boolean; onDone: (u?: AuthUser) => void; onCancel: () => void;
}) {
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    api.invitationInfo(token)
      .then((i) => { if (on) setInfo(i); })
      .catch((e) => { if (on) setError(e.message); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [token]);

  const accept = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.acceptInvitation(token, loggedIn ? {} : { password, name: name.trim() || undefined });
      if (r.status === 'created' && r.token) { setToken(r.token); onDone(r.user); }
      else onDone();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-50">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20">
            <Hexagon className="h-6 w-6 text-zinc-950" fill="currentColor" />
          </div>
          <div><h1 className="font-display text-xl font-bold tracking-tight">Nova Comptabilité</h1></div>
        </div>
        {children}
      </motion.div>
    </div>
  );

  if (loading) return shell(<div className="mt-8 flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Vérification de l'invitation…</div>);

  if (!info || error && !info) return shell(
    <div className="mt-6">
      <div className="flex items-center gap-2 text-amber-300"><AlertTriangle className="h-5 w-5" /> Invitation introuvable</div>
      <p className="mt-2 text-sm text-zinc-400">{error ?? "Ce lien d'invitation n'est pas valide."}</p>
      <button onClick={onCancel} className="mt-5 w-full rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20">Aller à la connexion</button>
    </div>
  );

  if (info.accepted || info.expired) return shell(
    <div className="mt-6">
      <div className="flex items-center gap-2 text-amber-300"><AlertTriangle className="h-5 w-5" /> {info.accepted ? 'Invitation déjà utilisée' : 'Invitation expirée'}</div>
      <p className="mt-2 text-sm text-zinc-400">
        {info.accepted
          ? 'Cette invitation a déjà servi. Connectez-vous avec votre compte.'
          : `Ce lien a expiré. Demandez une nouvelle invitation à ${info.cabinetName}.`}
      </p>
      <button onClick={onCancel} className="mt-5 w-full rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20">Aller à la connexion</button>
    </div>
  );

  return shell(
    <div className="mt-6">
      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-200">
        <Users className="h-4 w-4 shrink-0" />
        <span>Vous êtes invité(e) à rejoindre <strong>{info.cabinetName}</strong> en tant que <strong>{ROLE_LABEL[info.role] ?? info.role}</strong>.</span>
      </div>

      {loggedIn ? (
        <>
          <p className="mt-4 text-sm text-zinc-400">Vous êtes déjà connecté(e). Confirmez pour rattacher votre compte.</p>
          {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
          <button onClick={() => accept()} disabled={busy}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Rejoindre {info.cabinetName}
          </button>
        </>
      ) : (
        <form onSubmit={accept} className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Votre email</label>
            <input value={info.email} disabled
              className="w-full cursor-not-allowed rounded-lg border border-white/10 bg-zinc-900/40 px-3 py-2.5 text-sm text-zinc-400" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Votre nom</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Prénom Nom"
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Choisissez un mot de passe</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8 caractères minimum"
              className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50" />
          </div>
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
          <button type="submit" disabled={busy || password.length < 8}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Créer mon compte et rejoindre
          </button>
          <button type="button" onClick={onCancel} className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300">
            J'ai déjà un compte Nova — me connecter d'abord
          </button>
        </form>
      )}
    </div>
  );
}
