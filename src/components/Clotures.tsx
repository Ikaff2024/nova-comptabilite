import React, { useEffect, useState } from 'react';
import { Loader2, Lock, LockOpen, ShieldCheck, AlertTriangle } from 'lucide-react';
import { api, type ClosuresData } from '../lib/api';
import { cn } from '../lib/utils';

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// Mois suivant la borne clôturée (ou le mois courant si rien n'est clôturé).
function nextToClose(data: ClosuresData | null): { year: number; month: number } {
  if (data?.closedThrough) {
    const { year, month } = data.closedThrough;
    return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  }
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

export default function Clotures({ dossierId }: { dossierId: string }) {
  const [data, setData] = useState<ClosuresData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<{ year: number; month: number }>({ year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1 });

  const load = async () => {
    setLoading(true);
    try { const d = await api.closures(dossierId); setData(d); setSel(nextToClose(d)); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [dossierId]);

  const close = async () => {
    if (!confirm(`Clôturer ${MOIS[sel.month - 1]} ${sel.year} ? Plus aucune écriture ne pourra y être ajoutée (ni dans les mois antérieurs).`)) return;
    setBusy(true); setError(null);
    try { await api.closePeriod(dossierId, sel.year, sel.month); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const reopen = async (year: number, month: number) => {
    if (!confirm(`Rouvrir ${MOIS[month - 1]} ${year} ? La saisie y redevient possible.`)) return;
    setBusy(true); setError(null);
    try { await api.reopenPeriod(dossierId, year, month); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>;

  const latest = data?.closures[0];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-zinc-300"><Lock className="h-5 w-5 text-emerald-400" /><h3 className="font-display text-lg font-semibold">Clôtures mensuelles</h3></div>
      <p className="max-w-3xl text-sm text-zinc-400">Clôturer un mois verrouille la période : plus aucune écriture ne peut y être saisie ou modifiée (ni dans les mois antérieurs). Utile pour figer une déclaration de TVA ou un arrêté mensuel. Seul le dernier mois clôturé peut être rouvert.</p>

      {error && <p className="flex items-center gap-1.5 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400"><AlertTriangle className="h-4 w-4" /> {error}</p>}

      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <div className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-emerald-400" />
          {data?.closedThrough
            ? <span className="text-zinc-300">Comptabilité clôturée jusqu'à <b className="text-emerald-300">{data.closedThrough.label}</b> inclus.</span>
            : <span className="text-zinc-400">Aucune période clôturée pour l'instant.</span>}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Mois à clôturer</label>
            <select value={sel.month} onChange={(e) => setSel((s) => ({ ...s, month: Number(e.target.value) }))}
              className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
              {MOIS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Année</label>
            <input type="number" value={sel.year} onChange={(e) => setSel((s) => ({ ...s, year: Number(e.target.value) }))}
              className="w-24 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" />
          </div>
          <button onClick={close} disabled={busy}
            className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Clôturer ce mois
          </button>
        </div>
      </div>

      {data && data.closures.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <div className="border-b border-white/10 px-4 py-2.5 text-xs uppercase text-zinc-400">Périodes clôturées</div>
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-white/5">
              {data.closures.map((cl) => (
                <tr key={`${cl.year}-${cl.month}`} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-200"><Lock className="mr-2 inline h-3.5 w-3.5 text-zinc-500" />{cl.label}</td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500">clôturé le {cl.closed_at}</td>
                  <td className="px-4 py-2.5 text-right">
                    {latest && cl.year === latest.year && cl.month === latest.month ? (
                      <button onClick={() => reopen(cl.year, cl.month)} disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-50">
                        <LockOpen className="h-3.5 w-3.5" /> Rouvrir
                      </button>
                    ) : <span className="text-xs text-zinc-600">verrouillé</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
