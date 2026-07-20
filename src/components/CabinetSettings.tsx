import React, { useEffect, useState } from 'react';
import { Loader2, Users, ShieldCheck, ShieldOff, Plus, Trash2, KeyRound, CheckCircle2, Building2, Pencil, UserRound, Send } from 'lucide-react';
import { api, type Cabinet, type AuthUser, type CabinetMember, type PendingInvitation, type MemberAccess } from '../lib/api';
import { cn } from '../lib/utils';
import ApiCosts from './ApiCosts';
import EmailChannel from './EmailChannel';

const ROLES = [
  { v: 'owner', l: 'Propriétaire' },
  { v: 'associe', l: 'Associé (admin)' },
  { v: 'collaborateur', l: 'Collaborateur' },
];
const roleLabel = (r: string) => ROLES.find((x) => x.v === r)?.l ?? r;

export default function CabinetSettings({ cabinet, user, onUserRefresh, onRenamed, isCompany }: { cabinet: Cabinet; user: AuthUser; onUserRefresh: () => void; onRenamed: () => void; isCompany?: boolean }) {
  const [myRole, setMyRole] = useState<string | null>(null);
  useEffect(() => { let on = true; api.members(cabinet.id).then((ms) => { if (on) setMyRole(ms.find((m) => m.userId === user.id)?.role ?? null); }).catch(() => {}); return () => { on = false; }; }, [cabinet.id, user.id]);
  const isOwner = myRole === 'owner' || myRole === 'associe';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">{isCompany ? 'Entreprise & sécurité' : 'Cabinet & sécurité'}</h1>
        <p className="mt-1 text-zinc-400">{isCompany ? 'Gérez votre entreprise, les utilisateurs et votre double authentification.' : 'Gérez le cabinet, les collaborateurs et votre double authentification.'}</p>
      </div>
      <CabinetName cabinet={cabinet} onRenamed={onRenamed} isCompany={isCompany} />
      <ProfileName user={user} onUserRefresh={onUserRefresh} />
      <Members cabinet={cabinet} user={user} isCompany={isCompany} />
      {isOwner && <EmailChannel />}
      {isOwner && <ApiCosts isCompany={isCompany} />}
      {isOwner && <AccountTypeSwitch cabinet={cabinet} isCompany={!!isCompany} onChanged={onRenamed} />}
      <TwoFactor user={user} onUserRefresh={onUserRefresh} />
    </div>
  );
}

// Périmètre d'un collaborateur : tous les dossiers du cabinet (défaut) ou une
// sélection. Un propriétaire conserve toujours l'accès complet.
function MemberScope({ cabinetId, userId, onClose }: { cabinetId: string; userId: string; onClose: () => void }) {
  const [data, setData] = useState<MemberAccess | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let on = true;
    api.memberAccess(cabinetId, userId).then((d) => {
      if (!on) return;
      setData(d); setRestricted(d.restricted);
      setGranted(new Set(d.dossiers.filter((x) => x.granted).map((x) => x.id)));
    }).catch((e) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [cabinetId, userId]);

  const toggle = (id: string) => { setGranted((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); setSaved(false); };

  const save = async () => {
    setBusy(true); setError(null);
    try { await api.setMemberAccess(cabinetId, userId, restricted, [...granted]); setSaved(true); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (!data) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement du périmètre…</div>;

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-200">
        <input type="checkbox" checked={restricted} onChange={(e) => { setRestricted(e.target.checked); setSaved(false); }} className="h-4 w-4 accent-emerald-500" />
        Limiter l'accès à une sélection de dossiers
      </label>
      <p className="text-xs text-zinc-500">{restricted ? 'Cette personne ne verra que les dossiers cochés ci-dessous.' : 'Cette personne accède à tous les dossiers du cabinet (présents et à venir).'}</p>

      {restricted && (
        <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-white/10 bg-zinc-900/40 p-2">
          {data.dossiers.length === 0 ? <p className="p-2 text-xs text-zinc-500">Aucun dossier dans ce cabinet.</p> : data.dossiers.map((d) => (
            <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-zinc-300 hover:bg-white/5">
              <input type="checkbox" checked={granted.has(d.id)} onChange={() => toggle(d.id)} className="h-4 w-4 accent-emerald-500" />
              {d.raisonSociale}
            </label>
          ))}
        </div>
      )}

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer le périmètre
        </button>
        <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200">Fermer</button>
        {saved && <span className="flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Périmètre enregistré</span>}
      </div>
    </div>
  );
}

// Bascule cabinet ↔ entreprise. « Entreprise » simplifie l'interface (pas de
// portefeuille, atterrissage direct dans la comptabilité de la société).
function AccountTypeSwitch({ cabinet, isCompany, onChanged }: { cabinet: Cabinet; isCompany: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const convert = async (to: 'cabinet' | 'entreprise') => {
    const msg = to === 'entreprise'
      ? "Passer en compte « entreprise » ? L'interface est simplifiée pour piloter une seule société (pas de portefeuille de clients)."
      : 'Repasser en compte « cabinet » (portefeuille de plusieurs clients) ?';
    if (!confirm(msg)) return;
    setBusy(true); setError(null);
    try { await api.setCabinetType(cabinet.id, to); onChanged(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><UserRound className="h-4 w-4 text-emerald-400" /> Type de compte</div>
      <div className="rounded-xl border border-white/10 bg-white/5 p-4">
        <p className="text-sm text-zinc-300">
          Ce compte est configuré comme <span className="font-semibold text-zinc-100">{isCompany ? 'entreprise' : 'cabinet comptable'}</span>.
          {isCompany
            ? ' L\'interface est centrée sur votre société : pas de portefeuille, accès direct à la comptabilité.'
            : ' Vous pilotez un portefeuille de plusieurs dossiers clients.'}
        </p>
        <button onClick={() => convert(isCompany ? 'cabinet' : 'entreprise')} disabled={busy}
          className="mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {isCompany ? 'Passer en compte cabinet' : 'Passer en compte entreprise'}
        </button>
        {error && <p className="mt-2 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      </div>
    </section>
  );
}

function CabinetName({ cabinet, onRenamed, isCompany }: { cabinet: Cabinet; onRenamed: () => void; isCompany?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cabinet.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setName(cabinet.name); }, [cabinet.name]);

  const save = async () => {
    if (!name.trim() || name.trim() === cabinet.name) { setEditing(false); return; }
    setBusy(true); setError(null);
    try { await api.renameCabinet(cabinet.id, name.trim()); setEditing(false); onRenamed(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Building2 className="h-4 w-4 text-emerald-400" /> {isCompany ? "Nom de l'entreprise" : 'Nom du cabinet'}</div>
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setName(cabinet.name); } }}
            className="w-72 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</button>
          <button onClick={() => { setEditing(false); setName(cabinet.name); }} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold text-zinc-100">{cabinet.name}</span>
          <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 text-sm text-emerald-400 hover:text-emerald-300"><Pencil className="h-3.5 w-3.5" /> Modifier</button>
        </div>
      )}
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
    </section>
  );
}

function ProfileName({ user, onUserRefresh }: { user: AuthUser; onUserRefresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setName(user.name ?? ''); }, [user.name]);

  const save = async () => {
    if (!name.trim() || name.trim() === (user.name ?? '')) { setEditing(false); return; }
    setBusy(true); setError(null);
    try { await api.updateMyName(name.trim()); setEditing(false); onUserRefresh(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><UserRound className="h-4 w-4 text-emerald-400" /> Votre nom</div>
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setName(user.name ?? ''); } }}
            className="w-72 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</button>
          <button onClick={() => { setEditing(false); setName(user.name ?? ''); }} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold text-zinc-100">{user.name || '—'}</span>
          <span className="text-sm text-zinc-500">{user.email}</span>
          <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 text-sm text-emerald-400 hover:text-emerald-300"><Pencil className="h-3.5 w-3.5" /> Modifier</button>
        </div>
      )}
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
    </section>
  );
}

function Members({ cabinet, user, isCompany }: { cabinet: Cabinet; user: AuthUser; isCompany?: boolean }) {
  const [rows, setRows] = useState<CabinetMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('collaborateur');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingInvitation[]>([]);
  const [scopeFor, setScopeFor] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setRows(await api.members(cabinet.id));
      try { setPending(await api.invitations(cabinet.id)); } catch { setPending([]); }
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [cabinet.id]);

  const myRole = rows.find((r) => r.userId === user.id)?.role;
  const canManage = myRole === 'owner' || myRole === 'associe';

  // Format d'adresse vérifié avant l'appel : sinon l'API répondrait « aucun
  // compte Nova », message trompeur quand c'est en fait une faute de frappe.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    if (!EMAIL_RE.test(value)) { setError(`Adresse email invalide : « ${value} ». Vérifiez le format (ex. prenom.nom@domaine.ci) — une seule « @ » et un point avant l'extension.`); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.inviteMember(cabinet.id, value, role);
      setNotice(r.status === 'added'
        ? `${r.email} a été rattaché(e) immédiatement (compte Nova existant).`
        : `Invitation envoyée à ${r.email}. La personne rejoindra ${cabinet.name} en créant son compte via le lien reçu.`);
      setEmail('');
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const revoke = async (inv: PendingInvitation) => {
    if (!confirm(`Annuler l'invitation de ${inv.email} ?`)) return;
    setError(null);
    try { await api.revokeInvitation(cabinet.id, inv.id); await load(); } catch (e: any) { setError(e.message); }
  };
  const changeRole = async (uid: string, r: string) => { setError(null); try { await api.setMemberRole(cabinet.id, uid, r); await load(); } catch (e: any) { setError(e.message); } };
  const remove = async (m: CabinetMember) => { if (!confirm(`Retirer ${m.name || m.email} du cabinet ?`)) return; setError(null); try { await api.removeMember(cabinet.id, m.userId); await load(); } catch (e: any) { setError(e.message); } };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Users className="h-4 w-4 text-emerald-400" /> {isCompany ? 'Utilisateurs' : 'Collaborateurs du cabinet'}</div>

      {canManage && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex-1 min-w-[12rem]"><label className="mb-1 block text-xs text-zinc-500">Email de la personne à inviter</label>
            <input type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="collaborateur@cabinet.ci" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
            <p className="mt-1 text-xs text-zinc-500">Si elle a déjà un compte Nova, elle est rattachée aussitôt. Sinon, elle reçoit un lien d'invitation par email.</p></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Rôle</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">{ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select></div>
          <button type="submit" disabled={busy} className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Inviter</button>
        </form>
      )}
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}

      {pending.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-amber-500/25 bg-amber-500/5">
          <div className="border-b border-amber-500/20 px-4 py-2.5 text-sm font-medium text-amber-300">Invitations en attente ({pending.length})</div>
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-amber-500/10">
              {pending.map((inv) => (
                <tr key={inv.id}>
                  <td className="px-4 py-2.5 text-zinc-200">{inv.email}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{roleLabel(inv.role)}</td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">{inv.expired ? 'expirée' : `expire le ${inv.expires_at}`}</td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && <button onClick={() => revoke(inv)} className="text-xs text-zinc-500 hover:text-rose-400">Annuler</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-3">
                      {canManage && m.userId !== user.id && m.role !== 'owner' && !isCompany && (
                        <button onClick={() => setScopeFor(scopeFor === m.userId ? null : m.userId)} className="text-xs text-zinc-400 hover:text-emerald-400">Périmètre</button>
                      )}
                      {canManage && m.userId !== user.id && <button onClick={() => remove(m)} title="Retirer" className="text-zinc-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
              {scopeFor && (
                <tr><td colSpan={4} className="bg-zinc-900/40 px-4 py-3">
                  <MemberScope cabinetId={cabinet.id} userId={scopeFor} onClose={() => setScopeFor(null)} />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!canManage && <p className="text-xs text-zinc-500">Seuls les propriétaires et associés peuvent gérer les collaborateurs.</p>}
      {!isCompany && <p className="text-xs text-zinc-500">Par défaut, un collaborateur accède à <strong>tous les dossiers</strong> du cabinet. Utilisez « Périmètre » pour le limiter à une sélection.</p>}
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
