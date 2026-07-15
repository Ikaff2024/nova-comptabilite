import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Plus, Trash2, Package, Wrench, PencilLine, X, Check } from 'lucide-react';
import { api, fmtMoney, type CatalogItem, type CatalogItemInput } from '../lib/api';
import { cn } from '../lib/utils';

const inputCls = 'w-full rounded-md border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500/50';
const blank = (): CatalogItemInput => ({ kind: 'bien', reference: '', label: '', unit: '', unitPrice: 0, vatRate: 0.18, accountCode: '' });

export default function Catalogue({ dossierId, currency }: { dossierId: string; currency: string }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<CatalogItemInput | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setItems(await api.catalog(dossierId, true)); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [dossierId]);

  const startCreate = () => { setEditId(null); setForm(blank()); };
  const startEdit = (it: CatalogItem) => {
    setEditId(it.id);
    setForm({ kind: it.kind, reference: it.reference ?? '', label: it.label, unit: it.unit ?? '', unitPrice: it.unit_price, vatRate: it.vat_rate, accountCode: it.account_code, active: it.active });
  };

  const save = async () => {
    if (!form?.label?.trim()) { setError('Désignation requise'); return; }
    setBusy(true); setError(null);
    try {
      if (editId) await api.updateCatalogItem(dossierId, editId, form);
      else await api.createCatalogItem(dossierId, form);
      setForm(null); setEditId(null); await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setError(null);
    try { await api.deleteCatalogItem(dossierId, id); await load(); } catch (e: any) { setError(e.message); }
  };
  const toggleActive = async (it: CatalogItem) => {
    try { await api.updateCatalogItem(dossierId, it.id, { label: it.label, active: !it.active }); await load(); } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-zinc-300"><Package className="h-5 w-5 text-emerald-400" /><h3 className="font-display text-lg font-semibold">Catalogue articles & services</h3></div>
        <button onClick={startCreate} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Nouvel article</button>
      </div>
      <p className="max-w-3xl text-sm text-zinc-400">Enregistrez vos biens et services vendus avec leur prix, leur TVA et leur compte de produit. À la facturation, un article choisi ici pré-remplit la ligne (désignation, prix, TVA, imputation).</p>

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {form && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="grid gap-3 sm:grid-cols-6">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Nature</label>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'bien' | 'service', accountCode: form.accountCode || (e.target.value === 'service' ? '706' : '701') })} className={inputCls}>
                <option value="bien">Bien</option>
                <option value="service">Service</option>
              </select>
            </div>
            <div><label className="mb-1 block text-xs text-zinc-500">Référence</label><input value={form.reference ?? ''} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="WAX-6Y" className={inputCls} /></div>
            <div className="sm:col-span-2"><label className="mb-1 block text-xs text-zinc-500">Désignation</label><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Pagne wax (6 yards)" className={inputCls} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Unité</label><input value={form.unit ?? ''} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="pièce, jour…" className={inputCls} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Prix HT</label><input type="number" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: Number(e.target.value) })} className={cn(inputCls, 'text-right font-mono')} /></div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">TVA</label>
              <select value={form.vatRate} onChange={(e) => setForm({ ...form, vatRate: Number(e.target.value) })} className={inputCls}>
                <option value={0.18}>18%</option><option value={0.09}>9%</option><option value={0}>0%</option>
              </select>
            </div>
            <div><label className="mb-1 block text-xs text-zinc-500">Compte produit</label><input value={form.accountCode ?? ''} onChange={(e) => setForm({ ...form, accountCode: e.target.value })} placeholder="701" className={cn(inputCls, 'font-mono')} /></div>
          </div>
          <div className="mt-4 flex justify-end gap-3">
            <button onClick={() => { setForm(null); setEditId(null); }} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            <button onClick={save} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} {editId ? 'Enregistrer' : 'Ajouter'}</button>
          </div>
        </motion.div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-zinc-500">Aucun article. Ajoutez vos biens et services pour accélérer la facturation.</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr className="border-b border-white/10">
                <th className="px-4 py-2.5">Nature</th><th className="px-4 py-2.5">Réf.</th><th className="px-4 py-2.5">Désignation</th>
                <th className="px-4 py-2.5">Unité</th><th className="px-4 py-2.5 text-right">Prix HT</th><th className="px-4 py-2.5 text-right">TVA</th>
                <th className="px-4 py-2.5">Compte</th><th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className={cn('border-b border-white/5', !it.active && 'opacity-45')}>
                  <td className="px-4 py-2.5">
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]', it.kind === 'service' ? 'bg-sky-500/15 text-sky-300' : 'bg-emerald-500/15 text-emerald-300')}>
                      {it.kind === 'service' ? <Wrench className="h-3 w-3" /> : <Package className="h-3 w-3" />} {it.kind === 'service' ? 'Service' : 'Bien'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{it.reference || '—'}</td>
                  <td className="px-4 py-2.5 text-zinc-100">{it.label}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{it.unit || '—'}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-100">{fmtMoney(it.unit_price, currency)}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">{Math.round(it.vat_rate * 100)}%</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{it.account_code}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => toggleActive(it)} title={it.active ? 'Désactiver' : 'Réactiver'} className="text-zinc-500 hover:text-zinc-200">{it.active ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}</button>
                      <button onClick={() => startEdit(it)} title="Modifier" className="text-zinc-500 hover:text-emerald-400"><PencilLine className="h-4 w-4" /></button>
                      <button onClick={() => remove(it.id)} title="Supprimer" className="text-zinc-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
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
