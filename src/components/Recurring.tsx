import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Repeat, CheckCircle2, Play, Power, CalendarClock } from 'lucide-react';
import { api, fmtMoney, type Journal, type RecurringTemplate, type RecurringLine } from '../lib/api';
import { cn } from '../lib/utils';

const FREQS = [{ v: 'monthly', l: 'Mensuel' }, { v: 'quarterly', l: 'Trimestriel' }, { v: 'yearly', l: 'Annuel' }];
const inputCls = 'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';

export default function Recurring({ dossierId, currency, journals }: { dossierId: string; currency: string; journals: Journal[] }) {
  const [rows, setRows] = useState<RecurringTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => { setLoading(true); try { setRows(await api.recurringTemplates(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);
  const m = (n: number) => fmtMoney(n, currency);

  const totalDue = rows.reduce((s, t) => s + t.due, 0);

  const generateAll = async () => {
    if (!confirm(`Générer toutes les échéances dues (${totalDue}) jusqu'à aujourd'hui ?`)) return;
    setBusy(true); setError(null); setMsg(null);
    try { const r = await api.generateAllRecurring(dossierId); setMsg(`${r.count} écriture(s) générée(s) sur ${r.templates} modèle(s) pour ${m(r.total)}.`); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const generateOne = async (t: RecurringTemplate) => {
    setError(null); setMsg(null);
    try { const r = await api.generateRecurring(dossierId, t.id); setMsg(`${t.label} : ${r.count} échéance(s) générée(s)${r.skipped ? `, ${r.skipped} ignorée(s) (exercice manquant)` : ''}.`); await load(); }
    catch (e: any) { setError(e.message); }
  };
  const toggle = async (t: RecurringTemplate) => { try { await api.setRecurringActive(dossierId, t.id, !t.active); await load(); } catch (e: any) { setError(e.message); } };
  const remove = async (t: RecurringTemplate) => { if (!confirm(`Supprimer le modèle « ${t.label} » ? (les écritures déjà générées sont conservées)`)) return; try { await api.deleteRecurring(dossierId, t.id); await load(); } catch (e: any) { setError(e.message); } };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-300"><Repeat className="h-4 w-4 text-emerald-400" /> Écritures récurrentes & abonnements</div>
        <div className="flex items-center gap-2">
          <button onClick={generateAll} disabled={busy || totalDue === 0} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />} Générer les échéances dues{totalDue > 0 ? ` (${totalDue})` : ''}
          </button>
          <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Nouveau modèle</button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {msg && <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}

      {showForm && <TemplateForm dossierId={dossierId} currency={currency} journals={journals} onDone={() => { setShowForm(false); load(); }} onError={setError} />}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        : rows.length === 0 ? <p className="text-zinc-400">Aucun modèle. Créez un abonnement (loyer, salaires, SaaS…) pour automatiser sa comptabilisation.</p>
        : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
              <tr><th className="px-4 py-2.5 font-medium">Modèle</th><th className="px-4 py-2.5 font-medium">Fréquence</th><th className="px-4 py-2.5 font-medium">Journal</th><th className="px-4 py-2.5 text-right font-medium">Montant</th><th className="px-4 py-2.5 text-right font-medium">Générées</th><th className="px-4 py-2.5 text-center font-medium">Dues</th><th className="px-4 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((t) => (
                <tr key={t.id} className={cn('hover:bg-white/5', !t.active && 'opacity-50')}>
                  <td className="px-4 py-2 text-zinc-200">{t.label}{t.counterpartyName && <span className="ml-2 text-xs text-zinc-500">· {t.counterpartyName}</span>}</td>
                  <td className="px-4 py-2 text-zinc-400">{t.frequencyLabel} · le {t.dayOfMonth}</td>
                  <td className="px-4 py-2 font-mono text-zinc-400">{t.journalCode}</td>
                  <td className="px-4 py-2 text-right font-mono text-zinc-300">{m(t.amount)}</td>
                  <td className="px-4 py-2 text-right text-zinc-400">{t.generated}</td>
                  <td className="px-4 py-2 text-center">{t.due > 0 ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{t.due}</span> : <span className="text-xs text-zinc-600">—</span>}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => generateOne(t)} disabled={!t.active || t.due === 0} title="Générer" className="rounded-md p-1.5 text-emerald-400 hover:bg-white/10 disabled:opacity-30"><Play className="h-4 w-4" /></button>
                      <button onClick={() => toggle(t)} title={t.active ? 'Désactiver' : 'Activer'} className={cn('rounded-md p-1.5 hover:bg-white/10', t.active ? 'text-zinc-400' : 'text-zinc-600')}><Power className="h-4 w-4" /></button>
                      <button onClick={() => remove(t)} title="Supprimer" className="rounded-md p-1.5 text-zinc-500 hover:bg-white/10 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                    </div>
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

function TemplateForm({ dossierId, currency, journals, onDone, onError }: { dossierId: string; currency: string; journals: Journal[]; onDone: () => void; onError: (s: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [label, setLabel] = useState('');
  const [journalId, setJournalId] = useState(journals.find((j) => j.code === 'OD')?.id ?? journals[0]?.id ?? '');
  const [frequency, setFrequency] = useState('monthly');
  const [startDate, setStart] = useState(today);
  const [endDate, setEnd] = useState('');
  const [dayOfMonth, setDay] = useState(String(new Date().getUTCDate()));
  const [counterpartyName, setCp] = useState('');
  const [lines, setLines] = useState<RecurringLine[]>([{ accountCode: '', debit: undefined, credit: undefined, label: '' }, { accountCode: '', debit: undefined, credit: undefined, label: '' }]);
  const [saving, setSaving] = useState(false);

  const setLine = (i: number, patch: Partial<RecurringLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { accountCode: '', debit: undefined, credit: undefined, label: '' }]);
  const rmLine = (i: number) => setLines((ls) => ls.filter((_, j) => j !== i));

  const totD = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totC = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totD - totC) < 0.001 && totD > 0;

  const submit = async () => {
    setSaving(true); onError('');
    try {
      const clean = lines.filter((l) => l.accountCode.trim()).map((l) => ({ accountCode: l.accountCode.trim(), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, label: l.label || undefined }));
      await api.createRecurring(dossierId, { label, journalId, frequency, dayOfMonth: Number(dayOfMonth), startDate, endDate: endDate || null, counterpartyName: counterpartyName || undefined, lines: clean });
      onDone();
    } catch (e: any) { onError(e.message); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2"><label className="text-xs uppercase text-zinc-400">Libellé</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex. Loyer boutique Cocody" className={cn(inputCls, 'mt-1')} /></div>
        <div><label className="text-xs uppercase text-zinc-400">Journal</label><select value={journalId} onChange={(e) => setJournalId(e.target.value)} className={cn(inputCls, 'mt-1')}>{journals.map((j) => <option key={j.id} value={j.id}>{j.code} — {j.label}</option>)}</select></div>
        <div><label className="text-xs uppercase text-zinc-400">Tiers (optionnel)</label><input value={counterpartyName} onChange={(e) => setCp(e.target.value)} placeholder="Ex. Bailleur" className={cn(inputCls, 'mt-1')} /></div>
        <div><label className="text-xs uppercase text-zinc-400">Fréquence</label><select value={frequency} onChange={(e) => setFrequency(e.target.value)} className={cn(inputCls, 'mt-1')}>{FREQS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select></div>
        <div><label className="text-xs uppercase text-zinc-400">Jour du mois</label><input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDay(e.target.value)} className={cn(inputCls, 'mt-1 font-mono')} /></div>
        <div><label className="text-xs uppercase text-zinc-400">Début</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className={cn(inputCls, 'mt-1')} /></div>
        <div><label className="text-xs uppercase text-zinc-400">Fin (optionnel)</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className={cn(inputCls, 'mt-1')} /></div>
      </div>

      <div className="space-y-2">
        <div className="text-xs uppercase text-zinc-400">Lignes de l'écriture</div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <input value={l.accountCode} onChange={(e) => setLine(i, { accountCode: e.target.value })} placeholder="Compte" className={cn(inputCls, 'col-span-2 font-mono')} />
            <input value={l.label ?? ''} onChange={(e) => setLine(i, { label: e.target.value })} placeholder="Libellé ligne" className={cn(inputCls, 'col-span-5')} />
            <input type="number" value={l.debit ?? ''} onChange={(e) => setLine(i, { debit: e.target.value ? Number(e.target.value) : undefined, credit: undefined })} placeholder="Débit" className={cn(inputCls, 'col-span-2 font-mono')} />
            <input type="number" value={l.credit ?? ''} onChange={(e) => setLine(i, { credit: e.target.value ? Number(e.target.value) : undefined, debit: undefined })} placeholder="Crédit" className={cn(inputCls, 'col-span-2 font-mono')} />
            <button onClick={() => rmLine(i)} className="col-span-1 flex items-center justify-center rounded-lg text-zinc-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <button onClick={addLine} className="flex items-center gap-1 text-sm text-zinc-400 hover:text-emerald-400"><Plus className="h-4 w-4" /> Ajouter une ligne</button>
          <span className={cn('text-sm font-mono', balanced ? 'text-emerald-400' : 'text-amber-400')}>{balanced ? '✓ équilibré' : `D ${fmtMoney(totD, currency)} / C ${fmtMoney(totC, currency)}`}</span>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
        <button onClick={submit} disabled={saving || !label || !balanced} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer le modèle</button>
      </div>
    </div>
  );
}
