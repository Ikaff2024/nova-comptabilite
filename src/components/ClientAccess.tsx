import React, { useEffect, useState } from 'react';
import { Loader2, UserPlus, Trash2, UserRound, ShieldCheck } from 'lucide-react';
import { api, type DossierClient } from '../lib/api';

// Gestion, côté cabinet, des accès « portail client » d'un dossier :
// inviter un client (par email), lister, révoquer. Réservé aux administrateurs
// (le back applique le contrôle owner/associe).
export default function ClientAccess({ dossierId }: { dossierId: string }) {
  const [clients, setClients] = useState<DossierClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = async () => { setLoading(true); try { setClients(await api.dossierClients(dossierId)); } catch (e: any) { setError(e.message); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setOk(null);
    if (!email.trim()) return;
    setBusy(true);
    try { await api.grantClient(dossierId, email.trim()); setOk(`Accès accordé à ${email.trim()}.`); setEmail(''); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const revoke = async (u: DossierClient) => {
    if (!confirm(`Retirer l'accès de ${u.email} ?`)) return;
    setError(null); setOk(null);
    try { await api.revokeClient(dossierId, u.userId); await load(); } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-zinc-300">
        <ShieldCheck className="h-5 w-5 text-emerald-400" />
        <h3 className="font-display text-lg font-semibold">Portail client — accès</h3>
      </div>
      <p className="max-w-2xl text-sm text-zinc-400">
        Donnez à votre client un accès à <span className="text-zinc-200">son dossier uniquement</span>, en
        <span className="text-zinc-200"> consultation</span> (synthèse, états financiers) et
        <span className="text-zinc-200"> dépôt de pièces</span>. Il ne peut ni saisir d'écritures, ni voir les autres dossiers.
        La personne doit d'abord <span className="text-zinc-200">créer son compte Nova</span> avec cet email.
      </p>

      <form onSubmit={invite} className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="flex-1 min-w-[16rem]">
          <label className="mb-1 block text-xs text-zinc-500">Email du client</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="client@entreprise.ci" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
        </div>
        <button type="submit" disabled={busy} className="flex h-[38px] items-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Inviter</button>
      </form>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {ok && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">{ok}</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        : clients.length === 0 ? <p className="text-sm text-zinc-500">Aucun accès client pour ce dossier.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-3 font-medium">Client</th><th className="px-4 py-3 font-medium">Email</th><th className="px-4 py-3 font-medium">Accès</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {clients.map((u) => (
                <tr key={u.userId} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-300"><span className="inline-flex items-center gap-2"><UserRound className="h-4 w-4 text-zinc-500" /> {u.name ?? '—'}</span></td>
                  <td className="px-4 py-2.5 font-mono text-zinc-400">{u.email}</td>
                  <td className="px-4 py-2.5"><span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-400">{u.role === 'lecture' ? 'Lecture' : 'Client'}</span></td>
                  <td className="px-4 py-2.5 text-right"><button onClick={() => revoke(u)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
