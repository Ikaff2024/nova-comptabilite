import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Plus, Trash2, ShoppingCart, BookCheck, Wallet, Printer, AlertTriangle, ClipboardList } from 'lucide-react';
import { api, fmtMoney, type Purchase, type PurchaseLine, type SupplierAging, type AnalyticSection } from '../lib/api';
import { printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Brouillon', cls: 'bg-zinc-500/15 text-zinc-400' },
  recorded: { label: 'Comptabilisée', cls: 'bg-sky-500/15 text-sky-400' },
  paid: { label: 'Réglée', cls: 'bg-emerald-500/15 text-emerald-400' },
  cancelled: { label: 'Annulée', cls: 'bg-rose-500/15 text-rose-400' },
};

const inputCls = 'w-full rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-sm outline-none focus:border-emerald-500/50';

let lk = 0;
type Line = PurchaseLine & { _k: number };
const blankLine = (): Line => ({ _k: ++lk, description: '', account_code: '601', amount_ht: 0, vat_rate: 0.18 });

export default function Achats({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [rows, setRows] = useState<Purchase[]>([]);
  const [aging, setAging] = useState<SupplierAging[]>([]);
  const [sections, setSections] = useState<AnalyticSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showAging, setShowAging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<{ id: string; treasury: string; date: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try { const [p, a] = await Promise.all([api.purchases(dossierId), api.supplierAging(dossierId)]); setRows(p); setAging(a); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); setCreating(false); }, [dossierId]);
  useEffect(() => { api.analyticSections(dossierId).then(setSections).catch(() => {}); }, [dossierId]);

  const [supplier, setSupplier] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [due, setDue] = useState('');
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const setLine = (k: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l._k === k ? { ...l, ...p } : l)));
  const totalHt = lines.reduce((s, l) => s + Number(l.amount_ht), 0);
  const totalTva = lines.reduce((s, l) => s + Number(l.amount_ht) * Number(l.vat_rate), 0);

  const resetForm = () => { setSupplier(''); setSupplierRef(''); setDue(''); setLines([blankLine()]); };

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (!supplier.trim()) { setError('Fournisseur requis'); return; }
    setBusy('create');
    try {
      await api.createPurchase(dossierId, {
        supplierName: supplier.trim(), supplierRef: supplierRef.trim() || undefined, invoiceDate: date, dueDate: due || undefined,
        lines: lines.map((l) => ({ description: l.description, account_code: l.account_code, analytic_axis: l.analytic_axis || undefined, amount_ht: Number(l.amount_ht), vat_rate: Number(l.vat_rate) })),
      });
      setCreating(false); resetForm(); await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const act = async (fn: () => Promise<any>, key: string) => {
    setBusy(key); setError(null);
    try { await fn(); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const confirmPay = async () => {
    if (!paying) return;
    setBusy('pay' + paying.id); setError(null);
    try {
      const chan = paying.treasury.startsWith('57') ? undefined : 'bank';
      await api.payPurchase(dossierId, paying.id, { paymentDate: paying.date, treasuryCode: paying.treasury, channel: chan });
      setPaying(null); await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const printDoc = async (id: string) => {
    const p = await api.purchase(dossierId, id);
    const m = (n: number) => fmtMoney(n, currency);
    const body = `
      <table style="margin-bottom:12px"><tbody>
        <tr><td><b>FACTURE FOURNISSEUR ${p.supplier_ref ? '· ' + p.supplier_ref : ''}</b></td><td class="n">Date : ${p.invoice_date}</td></tr>
        <tr><td>Destinataire : ${dossierName}</td><td class="n">${p.due_date ? 'Échéance : ' + p.due_date : ''}</td></tr>
        <tr><td>Fournisseur : ${(p.supplier_name ?? '').replace(/[&<>]/g, '')}</td><td class="n">${STATUS[p.status]?.label ?? p.status}</td></tr>
      </tbody></table>
      <table><thead><tr><th>Désignation</th><th class="n">Compte</th><th class="n">HT</th><th class="n">TVA</th></tr></thead><tbody>
      ${p.lines.map((l) => `<tr><td>${(l.description ?? '').replace(/[&<>]/g, '')}</td><td class="n">${l.account_code}</td><td class="n">${m(l.amount_ht)}</td><td class="n">${Math.round(Number(l.vat_rate) * 100)}%</td></tr>`).join('')}
      <tr class="tot"><td colspan="3">Total HT</td><td class="n">${m(p.total_ht)}</td></tr>
      <tr class="tot"><td colspan="3">TVA déductible</td><td class="n">${m(p.total_tva)}</td></tr>
      <tr class="tot"><td colspan="3">Total TTC</td><td class="n">${m(p.total_ttc)}</td></tr>
      </tbody></table>`;
    printDocument(`Facture fournisseur ${p.supplier_ref ?? ''} — ${p.supplier_name}`, `édité le ${nowStamp()}`, body);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-zinc-300"><ShoppingCart className="h-5 w-5 text-emerald-400" /><h3 className="font-display text-lg font-semibold">Achats fournisseurs</h3></div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAging((v) => !v)} className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium', showAging ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10')}><ClipboardList className="h-4 w-4" /> Balance âgée</button>
          <button onClick={() => { resetForm(); setCreating((v) => !v); }} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Nouvelle facture</button>
        </div>
      </div>

      {showAging && (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <div className="border-b border-white/10 px-4 py-2.5 text-xs uppercase text-zinc-400">Balance âgée fournisseurs — encours non réglé par ancienneté</div>
          {aging.length === 0 ? <p className="px-4 py-3 text-sm text-zinc-500">Aucun encours fournisseur. Tout est réglé 👍</p> : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 text-xs uppercase text-zinc-400"><tr>
                <th className="px-4 py-2.5 font-medium">Fournisseur</th>
                <th className="px-4 py-2.5 text-right font-medium">0-30 j</th><th className="px-4 py-2.5 text-right font-medium">31-60 j</th>
                <th className="px-4 py-2.5 text-right font-medium">61-90 j</th><th className="px-4 py-2.5 text-right font-medium">+90 j</th>
                <th className="px-4 py-2.5 text-right font-medium">Solde dû</th>
              </tr></thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {aging.map((a) => (
                  <tr key={a.counterpartyId} className="hover:bg-white/5">
                    <td className="px-4 py-2 font-sans text-zinc-300">{a.name} <span className="text-xs text-zinc-500">{a.auxCode}</span></td>
                    <td className="px-4 py-2 text-right text-zinc-400">{a.b0_30 ? fmtMoney(a.b0_30, currency) : '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-400">{a.b31_60 ? fmtMoney(a.b31_60, currency) : '—'}</td>
                    <td className="px-4 py-2 text-right text-amber-400/80">{a.b61_90 ? fmtMoney(a.b61_90, currency) : '—'}</td>
                    <td className={cn('px-4 py-2 text-right', a.b90_plus ? 'text-rose-400' : 'text-zinc-600')}>{a.b90_plus ? fmtMoney(a.b90_plus, currency) : '—'}</td>
                    <td className="px-4 py-2 text-right font-semibold text-zinc-100">{fmtMoney(a.balance, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {creating && (
        <motion.form initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} onSubmit={create} className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2"><label className="mb-1 block text-xs text-zinc-500">Fournisseur</label><input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Raison sociale" className={inputCls} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">N° facture fournisseur</label><input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} placeholder="ex. FA-2026-014" className={inputCls} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="mb-1 block text-xs text-zinc-500">Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></div>
              <div><label className="mb-1 block text-xs text-zinc-500">Échéance</label><input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} /></div>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500"><tr><th className="pb-1 pr-2">Désignation</th><th className="pb-1 px-2">Compte</th>{sections.length > 0 && <th className="pb-1 px-2">Analytique</th>}<th className="pb-1 px-2 text-right">Montant HT</th><th className="pb-1 px-2 text-right">TVA</th><th></th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l._k}>
                  <td className="py-1 pr-2"><input value={l.description} onChange={(e) => setLine(l._k, { description: e.target.value })} placeholder="Achat marchandises, loyer…" className={cn(inputCls, 'min-w-[9rem]')} /></td>
                  <td className="py-1 px-2"><input value={l.account_code} onChange={(e) => setLine(l._k, { account_code: e.target.value })} className={cn(inputCls, 'w-16 font-mono')} /></td>
                  {sections.length > 0 && (
                    <td className="py-1 px-2"><select value={l.analytic_axis ?? ''} onChange={(e) => setLine(l._k, { analytic_axis: e.target.value || null })} className={inputCls}><option value="">—</option>{sections.map((s) => <option key={s.code} value={s.code}>{s.code}</option>)}</select></td>
                  )}
                  <td className="py-1 px-2"><input type="number" value={l.amount_ht} onChange={(e) => setLine(l._k, { amount_ht: Number(e.target.value) })} className={cn(inputCls, 'w-28 text-right font-mono')} /></td>
                  <td className="py-1 px-2"><select value={l.vat_rate} onChange={(e) => setLine(l._k, { vat_rate: Number(e.target.value) })} className={inputCls}><option value={0.18}>18%</option><option value={0.09}>9%</option><option value={0}>0%</option></select></td>
                  <td className="py-1 pl-2">{lines.length > 1 && <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x._k !== l._k))} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setLines((ls) => [...ls, blankLine()])} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-emerald-400"><Plus className="h-4 w-4" /> Ligne</button>
            <div className="flex items-center gap-6 font-mono text-sm text-zinc-400">HT <b className="text-zinc-100">{fmtMoney(totalHt, currency)}</b> · TVA <b className="text-zinc-100">{fmtMoney(totalTva, currency)}</b> · TTC <b className="text-emerald-400">{fmtMoney(totalHt + totalTva, currency)}</b></div>
          </div>
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            <button type="submit" disabled={busy === 'create'} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy === 'create' && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer la facture</button>
          </div>
        </motion.form>
      )}

      {error && !creating && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : rows.length === 0 ? <p className="text-sm text-zinc-500">Aucune facture fournisseur. Créez la première.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-3 font-medium">Fournisseur</th><th className="px-4 py-3 font-medium">Réf.</th><th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 font-medium">Échéance</th>
              <th className="px-4 py-3 text-right font-medium">TTC</th><th className="px-4 py-3 font-medium">Statut</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((p) => {
                const overdue = p.status === 'recorded' && p.due_date && p.due_date < new Date().toISOString().slice(0, 10);
                return (
                <React.Fragment key={p.id}>
                <tr className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-300">{p.supplier_name}</td>
                  <td className="px-4 py-2.5 font-mono text-zinc-500">{p.supplier_ref ?? '—'}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{p.invoice_date}</td>
                  <td className={cn('px-4 py-2.5', overdue ? 'text-rose-400' : 'text-zinc-500')}>{p.due_date ?? '—'}{overdue && <AlertTriangle className="ml-1 inline h-3.5 w-3.5" />}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-200">{fmtMoney(p.total_ttc, currency)}</td>
                  <td className="px-4 py-2.5"><span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS[p.status]?.cls)}>{STATUS[p.status]?.label ?? p.status}</span></td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-3">
                      {p.status === 'draft' && <button onClick={() => act(() => api.recordPurchase(dossierId, p.id), 'r' + p.id)} className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300">{busy === 'r' + p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookCheck className="h-3.5 w-3.5" />} Comptabiliser</button>}
                      {p.status === 'recorded' && <button onClick={() => setPaying({ id: p.id, treasury: '521', date: new Date().toISOString().slice(0, 10) })} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"><Wallet className="h-3.5 w-3.5" /> Régler</button>}
                      <button onClick={() => printDoc(p.id)} className="text-zinc-500 hover:text-zinc-300"><Printer className="h-4 w-4" /></button>
                      {p.status === 'draft' && <button onClick={() => act(() => api.deletePurchase(dossierId, p.id), 'd' + p.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  </td>
                </tr>
                {paying?.id === p.id && (
                  <tr className="bg-emerald-500/[0.04]">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <div><label className="mb-1 block text-xs text-zinc-500">Compte de trésorerie</label><input value={paying.treasury} onChange={(e) => setPaying({ ...paying, treasury: e.target.value })} className={cn(inputCls, 'w-24 font-mono')} /></div>
                        <div><label className="mb-1 block text-xs text-zinc-500">Date de règlement</label><input type="date" value={paying.date} onChange={(e) => setPaying({ ...paying, date: e.target.value })} className={cn(inputCls, 'w-40')} /></div>
                        <span className="pb-1.5 text-xs text-zinc-500">521 banque · 571 caisse · 531/prov. Mobile Money</span>
                        <div className="ml-auto flex gap-2">
                          <button onClick={() => setPaying(null)} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
                          <button onClick={confirmPay} disabled={busy === 'pay' + p.id} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy === 'pay' + p.id && <Loader2 className="h-4 w-4 animate-spin" />} Valider le règlement de {fmtMoney(p.total_ttc, currency)}</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ); })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
