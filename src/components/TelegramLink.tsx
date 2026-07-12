import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Send } from 'lucide-react';
import { api } from '../lib/api';

type Data = { enabled: boolean; links: { id: string; code: string; label: string | null; linked: boolean; created_at: string }[] };

export default function TelegramLink({ dossierId }: { dossierId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.telegramLinks(dossierId).then(setData).catch(() => {});
  useEffect(() => { load(); }, [dossierId]);

  const add = async () => {
    setBusy(true); setErr(null);
    try { await api.telegramLink(dossierId, label || undefined); setLabel(''); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (id: string) => { setErr(null); try { await api.telegramUnlink(dossierId, id); await load(); } catch (e: any) { setErr(e.message); } };

  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Send className="h-4 w-4 text-sky-400" /> Canal Telegram</div>
      {data && !data.enabled && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Le canal Telegram n'est pas encore configuré côté serveur (bot @BotFather + <span className="font-mono">TELEGRAM_BOT_TOKEN</span>). Une fois configuré, générez ici un code de liaison.</p>
      )}
      <p className="text-xs text-zinc-500">Générez un code, puis envoyez-le au bot Nova sur Telegram depuis le compte à relier. Ce chat sera alors traité par Lexa, dans votre périmètre.</p>
      <div className="flex flex-wrap items-end gap-2">
        <div><label className="mb-1 block text-xs text-zinc-500">Libellé (optionnel)</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Gérant" className="w-40 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-sky-500/50" /></div>
        <button onClick={add} disabled={busy} className="flex h-[38px] items-center gap-1.5 rounded-lg bg-sky-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-sky-400 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Générer un code</button>
      </div>
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400">{err}</p>}
      {data && data.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.links.map((l) => (
            <span key={l.id} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-zinc-300">
              {l.linked
                ? <span className="text-emerald-400">✅ relié{l.label ? ` · ${l.label}` : ''}</span>
                : <><span className="font-mono text-sky-400">{l.code}</span>{l.label ? ` · ${l.label}` : ''} <span className="text-zinc-500">(en attente)</span></>}
              <button onClick={() => del(l.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
