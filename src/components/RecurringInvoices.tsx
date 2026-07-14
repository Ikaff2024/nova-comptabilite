import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Power, Play, Repeat } from 'lucide-react';
import { api, fmtMoney, type RecurringInvoice } from '../lib/api';
import { cn } from '../lib/utils';

const FREQ = [['monthly', 'Mensuel'], ['quarterly', 'Trimestriel'], ['yearly', 'Annuel']] as const;
const inputCls = 'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';

export default function RecurringInvoices({ dossierId, currency }: { dossierId: string; currency: string }) {
  const m = (n: number) => fmtMoney(n, currency);
  const [rows, setRows] = useState<RecurringInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const empty = { label: 'Abonnement', clientName: '', description: '', quantity: 1, unitPrice: 0, vatPct: 18, accountCode: '706', frequency: 'monthly', dayOfMonth: 1, startDate: today, endDate: '' };
  const [f, setForm] = useState<any>(empty);
  const setF = (p: any) => setForm((x: any) => ({ ...x, ...p }));

  const load = async () => { setLoading(true); try { setRows(await api.recurringInvoices(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const add = async () => {
    if (!f.clientName.trim()) { setErr('Client requis.'); return; }
    setBusy('add'); setErr(null);
    try {
      await api.createRecurringInvoice(dossierId, {
        label: f.label, clientName: f.clientName.trim(), frequency: f.frequency, dayOfMonth: Number(f.dayOfMonth) || 1, startDate: f.startDate, endDate: f.endDate || null,
        lines: [{ description: f.description || f.label, quantity: Number(f.quantity) || 1, unit_price: Number(f.unitPrice) || 0, vat_rate: (Number(f.vatPct) || 0) / 100, account_code: f.accountCode || '706' }],
      });
      setForm(empty); setShowForm(false); await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const toggle = async (t: RecurringInvoice) => { try { await api.setRecurringInvoiceActive(dossierId, t.id, !t.active); await load(); } catch (e: any) { setErr(e.message); } };
  const del = async (id: string) => { if (!confirm('Supprimer ce modèle d\'abonnement ?')) return; try { await api.deleteRecurringInvoice(dossierId, id); await load(); } catch (e: any) { setErr(e.message); } };
  const generate = async () => { setBusy('gen'); setErr(null); setMsg(null); try { const r = await api.generateRecurringInvoices(dossierId); setMsg(`${r.count} facture(s) brouillon générée(s) sur ${r.templates} abonnement(s). À émettre dans Facturation.`); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };

  const totalDue = rows.reduce((s, r) => s + (r.active ? r.due : 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-display text-lg font-semibold text-zinc-100"><Repeat className="h-5 w-5 text-emerald-400" /> Factures récurrentes (abonnements)</div>
        <div className="flex items-center gap-2">
          <button onClick={generate} disabled={busy === 'gen' || totalDue === 0} className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">{busy === 'gen' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Générer les factures dues{totalDue > 0 ? ` (${totalDue})` : ''}</button>
          <button onClick={() => { setForm(empty); setShowForm((v) => !v); }} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Abonnement</button>
        </div>
      </div>
      <p className="text-xs text-zinc-500">Chaque échéance génère une <strong>facture brouillon</strong> (à émettre dans l'onglet Facturation). N'a aucun effet comptable tant qu'elle n'est pas émise.</p>
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{err}</p>}
      {msg && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{msg}</p>}

      {showForm && (
        <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div><label className="mb-1 block text-xs text-zinc-500">Libellé</label><input value={f.label} onChange={(e) => setF({ label: e.target.value })} className={inputCls} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Client</label><input value={f.clientName} onChange={(e) => setF({ clientName: e.target.value })} placeholder="Nom du client" className={inputCls} /></div>
          <div className="lg:col-span-2"><label className="mb-1 block text-xs text-zinc-500">Prestation</label><input value={f.description} onChange={(e) => setF({ description: e.target.value })} placeholder="Abonnement mensuel…" className={inputCls} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Quantité</label><input type="number" value={f.quantity} onChange={(e) => setF({ quantity: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Prix unitaire HT</label><input type="number" value={f.unitPrice} onChange={(e) => setF({ unitPrice: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">TVA %</label><input type="number" value={f.vatPct} onChange={(e) => setF({ vatPct: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Compte produit</label><input value={f.accountCode} onChange={(e) => setF({ accountCode: e.target.value })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Fréquence</label><select value={f.frequency} onChange={(e) => setF({ frequency: e.target.value })} className={inputCls}>{FREQ.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Jour du mois</label><input type="number" value={f.dayOfMonth} onChange={(e) => setF({ dayOfMonth: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Début</label><input type="date" value={f.startDate} onChange={(e) => setF({ startDate: e.target.value })} className={inputCls} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Fin (optionnel)</label><input type="date" value={f.endDate} onChange={(e) => setF({ endDate: e.target.value })} className={inputCls} /></div>
          <div className="sm:col-span-2 lg:col-span-4 flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            <button onClick={add} disabled={busy === 'add'} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy === 'add' && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</button>
          </div>
        </div>
      )}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : rows.length === 0 ? <p className="text-sm text-zinc-500">Aucun abonnement. Créez-en un pour facturer automatiquement chaque période.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-2.5 font-medium">Libellé</th><th className="px-4 py-2.5 font-medium">Client</th><th className="px-4 py-2.5 font-medium">Fréquence</th><th className="px-4 py-2.5 text-right font-medium">Montant TTC</th><th className="px-4 py-2.5 text-right font-medium">Dues</th><th className="px-4 py-2.5"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.id} className={cn('hover:bg-white/5', !r.active && 'opacity-50')}>
                  <td className="px-4 py-2.5 text-zinc-200">{r.label}</td>
                  <td className="px-4 py-2.5 text-zinc-300">{r.clientName}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{r.frequencyLabel}{!r.active && ' · inactif'}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(r.montantTtc)}</td>
                  <td className="px-4 py-2.5 text-right">{r.due > 0 ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{r.due}</span> : <span className="text-zinc-600">—</span>}</td>
                  <td className="px-4 py-2.5 text-right"><div className="flex items-center justify-end gap-2">
                    <button onClick={() => toggle(r)} title={r.active ? 'Désactiver' : 'Réactiver'} className="text-zinc-500 hover:text-amber-400"><Power className="h-4 w-4" /></button>
                    <button onClick={() => del(r.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
