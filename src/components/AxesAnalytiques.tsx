import React, { useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, Layers3 } from 'lucide-react';
import { api, type AnalyticAxe } from '../lib/api';
import { cn } from '../lib/utils';

// Gestion des axes analytiques.
//
// Le panneau ne s'ouvre que si on le demande : une entreprise qui n'a qu'un axe
// — la majorité — ne doit pas être invitée à en créer d'autres pour rien. Mais
// celle qui suit ses agences ET ses activités trouve ici de quoi le dire, au
// lieu d'encoder la combinaison dans le code de section (ABIDJAN-NEGOCE), qui
// explose en nombre et interdit toute agrégation sur une seule dimension.

export default function AxesAnalytiques({ dossierId, axes, onChanged }: {
  dossierId: string; axes: AnalyticAxe[]; onChanged: () => void;
}) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setBusy(true);
    try { await api.createAnalyticAxe(dossierId, code.trim(), label.trim()); setCode(''); setLabel(''); onChanged(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const rename = async (a: AnalyticAxe) => {
    setError(null);
    try { await api.renameAnalyticAxe(dossierId, a.id, draft.trim()); setEditing(null); onChanged(); }
    catch (e: any) { setError(e.message); }
  };
  const remove = async (a: AnalyticAxe) => {
    if (!confirm(`Supprimer l'axe « ${a.label} » ?${a.sections ? ` Ses ${a.sections} section(s) seront supprimées avec lui.` : ''}`)) return;
    setError(null);
    try { await api.deleteAnalyticAxe(dossierId, a.id); onChanged(); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-zinc-900/40 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        <Layers3 className="h-4 w-4 text-sky-400" /> Axes analytiques
      </div>
      <p className="text-xs text-zinc-500">
        Un axe est une <strong>dimension d'analyse</strong> : agence, activité, chantier. Chacun a ses propres sections,
        et une écriture peut porter une valeur par axe — ce qui permet de lire « l'activité Négoce, mais sur l'agence de Cocody ».
      </p>

      <div className="space-y-1.5">
        {axes.map((a) => (
          <div key={a.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
            <span className="w-24 shrink-0 font-mono text-xs text-sky-300">{a.code}</span>
            {editing === a.id ? (
              <>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(a); if (e.key === 'Escape') setEditing(null); }}
                  className="flex-1 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1 text-sm outline-none focus:border-emerald-500/50" />
                <button onClick={() => rename(a)} title="Enregistrer" className="text-emerald-400 hover:text-emerald-300"><Check className="h-4 w-4" /></button>
                <button onClick={() => setEditing(null)} title="Annuler" className="text-zinc-500 hover:text-zinc-300"><X className="h-4 w-4" /></button>
              </>
            ) : (
              <>
                <span className="flex-1 text-zinc-200">{a.label}</span>
                {a.isPrimary && (
                  <span title="Porte la ventilation historique du grand livre — il ne se supprime pas"
                    className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">principal</span>
                )}
                <span className="text-xs text-zinc-600">{a.sections} section{a.sections > 1 ? 's' : ''}</span>
                <button onClick={() => { setEditing(a.id); setDraft(a.label); }} title="Renommer" className="text-zinc-500 hover:text-emerald-400"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => remove(a)} disabled={a.isPrimary} title={a.isPrimary ? "L'axe principal ne se supprime pas" : 'Supprimer'}
                  className={cn('text-zinc-600', a.isPrimary ? 'cursor-not-allowed opacity-30' : 'hover:text-rose-400')}><Trash2 className="h-3.5 w-3.5" /></button>
              </>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div><label className="mb-1 block text-xs text-zinc-500">Code</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CHANTIER"
            className="w-32 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
        <div className="min-w-[10rem] flex-1"><label className="mb-1 block text-xs text-zinc-500">Intitulé</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Chantier"
            className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50" /></div>
        <button type="submit" disabled={busy || !code.trim() || !label.trim()}
          className="flex h-[34px] items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 text-sm font-medium text-sky-300 hover:bg-sky-500/20 disabled:opacity-40">
          <Plus className="h-4 w-4" /> Ajouter un axe
        </button>
      </form>

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
    </div>
  );
}
