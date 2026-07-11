import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, MessageCircle } from 'lucide-react';
import { api } from '../lib/api';

type Data = { enabled: boolean; links: { id: string; phone: string; label: string | null; created_at: string }[] };

export default function WhatsAppLink({ dossierId }: { dossierId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.whatsappLinks(dossierId).then(setData).catch(() => {});
  useEffect(() => { load(); }, [dossierId]);

  const add = async () => {
    setBusy(true); setErr(null);
    try { await api.whatsappLink(dossierId, phone, label || undefined); setPhone(''); setLabel(''); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (id: string) => { setErr(null); try { await api.whatsappUnlink(dossierId, id); await load(); } catch (e: any) { setErr(e.message); } };

  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><MessageCircle className="h-4 w-4 text-emerald-400" /> Canal WhatsApp</div>
      {data && !data.enabled && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Le canal WhatsApp n'est pas encore configuré côté serveur (compte Meta + <span className="font-mono">WHATSAPP_TOKEN</span>). Une fois configuré, reliez ici les numéros autorisés.</p>
      )}
      <p className="text-xs text-zinc-500">Reliez un numéro WhatsApp à ce dossier : les messages de ce numéro seront traités par l'assistant, dans votre périmètre. Format international sans « + » (ex. <span className="font-mono">2250700000000</span>).</p>
      <div className="flex flex-wrap items-end gap-2">
        <div><label className="mb-1 block text-xs text-zinc-500">Numéro</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="2250700000000" className="w-44 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
        <div><label className="mb-1 block text-xs text-zinc-500">Libellé (optionnel)</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Gérant" className="w-36 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
        <button onClick={add} disabled={busy || !phone.trim()} className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Relier</button>
      </div>
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400">{err}</p>}
      {data && data.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.links.map((l) => (
            <span key={l.id} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-zinc-300">
              <span className="font-mono text-emerald-400">+{l.phone}</span>{l.label ? ` · ${l.label}` : ''}
              <button onClick={() => del(l.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
