import React, { useEffect, useState } from 'react';
import { Loader2, Users, ShieldCheck, ShieldOff, Plus, Trash2, KeyRound, CheckCircle2 } from 'lucide-react';
import { api, type Cabinet, type AuthUser, type CabinetMember } from '../lib/api';
import { cn } from '../lib/utils';

const ROLES = [
  { v: 'owner', l: 'Propriétaire' },
  { v: 'associe', l: 'Associé (admin)' },
  { v: 'collaborateur', l: 'Collaborateur' },
];
const roleLabel = (r: string) => ROLES.find((x) => x.v === r)?.l ?? r;

export default function CabinetSettings({ cabinet, user, onUserRefresh }: { cabinet: Cabinet; user: AuthUser; onUserRefresh: () => void }) {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Cabinet & sécurité</h1>
        <p className="mt-1 text-zinc-400">{cabinet.name} — gérez les collaborateurs et votre double authentification.</p>
      </div>
      <Members cabinet={cabinet} user={user} />
      <TwoFactor user={user} onUserRefresh={onUserRefresh} />
    </div>
  );
}

function Members({ cabinet, user }: { cabinet: Cabinet; user: AuthUser }) {
  const [rows, setRows] = useState<CabinetMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('collaborateur');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => { setLoading(true); try { setRows(await api.members(cabinet.id)); } catch (e: any) { setError(e.message); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [cabinet.id]);

  const myRole = rows.find((r) => r.userId === user.id)?.role;
  const canManage = myRole === 'owner' || myRole === 'associe';

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!email.trim()) return;
    setBusy(true); setError(null);
    try { await api.addMember(cabinet.id, email.trim(), role); setEmail(''); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const changeRole = async (uid: string, r: string) => { setError(null); try { await api.setMemberRole(cabinet.id, uid, r); await load(); } catch (e: any) { setError(e.message); } };
  const remove = async (m: CabinetMember) => { if (!confirm(`Retirer ${m.name || m.email} du cabinet ?`)) return; setError(null); try { await api.removeMember(cabinet.id, m.userId); await load(); } catch (e: any) { setError(e.message); } };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Users className="h-4 w-4 text-emerald-400" /> Collaborateurs du cabinet</div>

      {canManage && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex-1 min-w-[12rem]"><label className="mb-1 block text-xs text-zinc-500">Email du collaborateur (compte Nova existant)</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="collaborateur@cabinet.ci" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Rôle</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">{ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select></div>
          <button type="submit" disabled={busy} className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter</button>
        </form>
      )}
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-3 font-medium">Nom</th><th className="px-4 py-3 font-medium">Email</th><th className="px-4 py-3 font-medium">Rôle</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((m) => (
                <tr key={m.userId} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-200">{m.name || '—'}{m.userId === user.id && <span className="ml-2 text-xs text-emerald-400">(vous)</span>}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{m.email}</td>
                  <td className="px-4 py-2.5">
                    {canManage && m.userId !== user.id
                      ? <select value={m.role} onChange={(e) => changeRole(m.userId, e.target.value)} className="rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1 text-xs outline-none">{ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select>
                      : <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-zinc-300">{roleLabel(m.role)}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">{canManage && m.userId !== user.id && <button onClick={() => remove(m)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!canManage && <p className="text-xs text-zinc-500">Seuls les propriétaires et associés peuvent gérer les collaborateurs.</p>}
    </section>
  );
}

function TwoFactor({ user, onUserRefresh }: { user: AuthUser; onUserRefresh: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const begin = async () => { setBusy(true); setError(null); try { setSetup(await api.setup2fa()); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const enable = async () => { setBusy(true); setError(null); try { await api.enable2fa(code.trim()); setSetup(null); setCode(''); setMsg('Double authentification activée.'); onUserRefresh(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const disable = async () => { if (!confirm('Désactiver la double authentification ?')) return; setBusy(true); setError(null); try { await api.disable2fa(); setMsg('Double authentification désactivée.'); onUserRefresh(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><KeyRound className="h-4 w-4 text-emerald-400" /> Double authentification (2FA)</div>
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        {user.twoFactorEnabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-emerald-400"><ShieldCheck className="h-5 w-5" /> Activée — un code à 6 chiffres est demandé à chaque connexion.</div>
            <button onClick={disable} disabled={busy} className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />} Désactiver</button>
          </div>
        ) : setup ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-300">1. Dans votre application d'authentification (Google Authenticator, Authy…), ajoutez un compte par <b>saisie manuelle</b> avec cette clé :</p>
            <div className="rounded-lg border border-white/10 bg-zinc-900/60 p-3 text-center font-mono text-lg tracking-widest text-emerald-300 break-all">{setup.secret}</div>
            <p className="text-xs text-zinc-500 break-all">URI : {setup.otpauth}</p>
            <p className="text-sm text-zinc-300">2. Saisissez le code à 6 chiffres généré pour confirmer :</p>
            <div className="flex gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" className="w-40 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono tracking-widest outline-none focus:border-emerald-500/50" />
              <button onClick={enable} disabled={busy || code.trim().length < 6} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Activer</button>
              <button onClick={() => setSetup(null)} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-zinc-400"><ShieldOff className="h-5 w-5" /> Désactivée. Ajoutez une couche de sécurité à votre connexion.</div>
            <button onClick={begin} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Activer la 2FA</button>
          </div>
        )}
        {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
        {msg && <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}
      </div>
    </section>
  );
}
