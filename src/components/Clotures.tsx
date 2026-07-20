import React, { useEffect, useState } from 'react';
import { Loader2, Lock, LockOpen, ShieldCheck, AlertTriangle, Calendar } from 'lucide-react';
import { api, type ClosuresData, type FiscalYear } from '../lib/api';
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
  // Double validation de la clôture (action lourde) : étape de confirmation + case à cocher.
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);

  const load = async () => {
    setLoading(true);
    try { const d = await api.closures(dossierId); setData(d); setSel(nextToClose(d)); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [dossierId]);

  const startClose = () => { setError(null); setAck(false); setConfirming(true); };
  const cancelClose = () => { setConfirming(false); setAck(false); };
  const confirmClose = async () => {
    if (!ack) return;
    setBusy(true); setError(null);
    try { await api.closePeriod(dossierId, sel.year, sel.month); setConfirming(false); setAck(false); await load(); }
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
      <ExercicesPanel dossierId={dossierId} />
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
          <button onClick={startClose} disabled={busy || confirming}
            className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            <Lock className="h-4 w-4" /> Clôturer ce mois
          </button>
        </div>

        {/* Double validation : confirmation explicite (case à cocher + bouton). */}
        {confirming && (
          <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/[0.07] p-4">
            <div className="flex items-center gap-2 font-semibold text-amber-300"><AlertTriangle className="h-4 w-4" /> Confirmer la clôture de {MOIS[sel.month - 1]} {sel.year}</div>
            <p className="mt-1.5 text-sm text-amber-200/90">
              Cette opération verrouille {MOIS[sel.month - 1]} {sel.year} et tous les mois antérieurs : plus aucune écriture ne pourra y être saisie ni modifiée.
              Seul le dernier mois clôturé pourra être rouvert.
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm text-amber-100">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="accent-amber-500" />
              Je comprends et je confirme vouloir clôturer cette période.
            </label>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={confirmClose} disabled={!ack || busy}
                className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-40">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Confirmer la clôture
              </button>
              <button onClick={cancelClose} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            </div>
          </div>
        )}
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

// Gestion des exercices : créer un exercice (dont un N-1 pour une reprise) et
// clôturer un exercice — la clôture génère le REPORT À NOUVEAU (soldes de bilan
// + résultat en 12x) dans l'exercice suivant.
function ExercicesPanel({ dossierId }: { dossierId: string }) {
  const [fys, setFys] = useState<FiscalYear[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ label: '', startDate: '', endDate: '' });

  const load = async () => { try { setFys(await api.fiscalYears(dossierId)); } catch (e: any) { setError(e.message); } };
  useEffect(() => { load(); }, [dossierId]);

  // Propose l'année précédant le plus ancien exercice existant.
  const suggestPrev = () => {
    const years = fys.map((f) => new Date(f.start_date).getFullYear());
    const y = (years.length ? Math.min(...years) : new Date().getFullYear()) - 1;
    setForm({ label: `Exercice ${y}`, startDate: `${y}-01-01`, endDate: `${y}-12-31` });
    setCreating(true);
  };

  const create = async () => {
    setBusy('new'); setError(null); setMsg(null);
    try {
      await api.createFiscalYear(dossierId, form.label.trim(), form.startDate, form.endDate);
      setCreating(false); setForm({ label: '', startDate: '', endDate: '' }); await load();
      setMsg('Exercice créé.');
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const close = async (fy: FiscalYear) => {
    if (!confirm(`Clôturer « ${fy.label} » ? Nova transfère le résultat en report à nouveau (12x) et génère les à-nouveaux dans l'exercice suivant. L'exercice devient non modifiable.`)) return;
    setBusy(fy.id); setError(null); setMsg(null);
    try {
      const r = await api.closeExercise(dossierId, fy.id);
      setMsg(`Exercice clôturé. Report à nouveau généré (résultat ${Math.round(r.resultat).toLocaleString('fr-FR')}).`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-zinc-300"><Calendar className="h-5 w-5 text-emerald-400" /><h3 className="font-display text-lg font-semibold">Exercices comptables</h3></div>
        <div className="flex gap-2">
          <button onClick={suggestPrev} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/10">+ Exercice antérieur (N-1)</button>
          <button onClick={() => { setForm({ label: '', startDate: '', endDate: '' }); setCreating((v) => !v); }} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/10">+ Nouvel exercice</button>
        </div>
      </div>

      {creating && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-white/10 bg-zinc-900/40 p-3">
          <div><label className="mb-1 block text-xs text-zinc-500">Libellé</label>
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Exercice 2025" className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Début</label>
            <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Fin</label>
            <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
          <button onClick={create} disabled={busy === 'new' || !form.label.trim() || !form.startDate || !form.endDate} className="flex h-[38px] items-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy === 'new' && <Loader2 className="h-4 w-4 animate-spin" />} Créer</button>
        </div>
      )}

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {msg && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{msg}</p>}

      <div className="overflow-hidden rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
            <th className="px-4 py-2 font-medium">Exercice</th><th className="px-4 py-2 font-medium">Période</th><th className="px-4 py-2 font-medium">Statut</th><th className="px-4 py-2"></th>
          </tr></thead>
          <tbody className="divide-y divide-white/5">
            {fys.map((f) => (
              <tr key={f.id} className="hover:bg-white/5">
                <td className="px-4 py-2.5 text-zinc-200">{f.label}</td>
                <td className="px-4 py-2.5 text-zinc-400">{String(f.start_date).slice(0, 10)} → {String(f.end_date).slice(0, 10)}</td>
                <td className="px-4 py-2.5">{f.status === 'closed'
                  ? <span className="rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 text-xs text-zinc-400">Clôturé</span>
                  : <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">Ouvert</span>}</td>
                <td className="px-4 py-2.5 text-right">
                  {f.status !== 'closed' && <button onClick={() => close(f)} disabled={busy === f.id} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/20 disabled:opacity-50">{busy === f.id ? '…' : 'Clôturer → report à nouveau'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">Pour une reprise : créez l'exercice antérieur (N-1), saisissez-y (ou importez) sa balance/grand livre, puis clôturez-le — le report à nouveau alimente automatiquement l'exercice courant.</p>
    </section>
  );
}
