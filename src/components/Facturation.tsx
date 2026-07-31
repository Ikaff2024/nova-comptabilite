import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Plus, Trash2, FileCheck2, Send, Printer, ShieldCheck, ArrowRightLeft, Undo2, FileClock, ReceiptText } from 'lucide-react';
import { api, fmtMoney, type Invoice, type InvoiceLine, type InvoiceTemplate, type AnalyticSection, type CatalogItem, type ValidationReport, type PayrollEmployee } from '../lib/api';
import { printDocument, printHtml, nowStamp } from '../lib/export';
import { invoiceDocumentHtml } from '../lib/invoiceDoc';
import { cn } from '../lib/utils';
import AqmReportCard from './AqmReportCard';

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Brouillon', cls: 'bg-zinc-500/15 text-zinc-400' },
  issued: { label: 'Émis', cls: 'bg-sky-500/15 text-sky-400' },
  paid: { label: 'Payée', cls: 'bg-emerald-500/15 text-emerald-400' },
  converted: { label: 'Converti', cls: 'bg-violet-500/15 text-violet-400' },
  cancelled: { label: 'Annulée', cls: 'bg-rose-500/15 text-rose-400' },
};

type DocType = 'invoice' | 'quote' | 'credit_note';
const DOCS: { type: DocType; label: string; one: string; icon: any; defAccount: string }[] = [
  { type: 'invoice', label: 'Factures', one: 'facture', icon: ReceiptText, defAccount: '706' },
  { type: 'quote', label: 'Devis', one: 'devis', icon: FileClock, defAccount: '706' },
  { type: 'credit_note', label: 'Avoirs', one: 'avoir', icon: Undo2, defAccount: '706' },
];

let lk = 0;
type Line = InvoiceLine & { _k: number };
const blankLine = (acc = '706'): Line => ({ _k: ++lk, description: '', quantity: 1, unit_price: 0, vat_rate: 0.18, account_code: acc });

export default function Facturation({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [docType, setDocType] = useState<DocType>('invoice');
  const [rows, setRows] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doc = DOCS.find((d) => d.type === docType)!;

  const [sections, setSections] = useState<AnalyticSection[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  // Vendeurs : la liste des salariés. Le champ n'apparaît que s'il y en a — une
  // entreprise sans paie n'a pas à voir un sélecteur qui ne lui sert à rien.
  const [vendeurs, setVendeurs] = useState<PayrollEmployee[]>([]);
  const load = async () => { setLoading(true); try { setRows(await api.invoices(dossierId, docType)); } finally { setLoading(false); } };
  useEffect(() => { load(); setCreating(false); }, [dossierId, docType]);
  useEffect(() => { api.analyticSections(dossierId).then(setSections).catch(() => {}); }, [dossierId]);
  useEffect(() => { api.catalog(dossierId).then(setCatalog).catch(() => {}); }, [dossierId]);
  useEffect(() => { api.payrollEmployees(dossierId).then(setVendeurs).catch(() => {}); }, [dossierId]);

  // Choix d'un article du catalogue → pré-remplit la ligne (désignation, prix, TVA, compte).
  const pickCatalog = (k: number, itemId: string) => {
    const it = catalog.find((x) => x.id === itemId);
    if (!it) return;
    setLine(k, { description: it.label, unit_price: it.unit_price, vat_rate: it.vat_rate, account_code: it.account_code });
  };

  const [client, setClient] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [due, setDue] = useState('');
  const [template, setTemplate] = useState<InvoiceTemplate>('standard');
  const [vendeurId, setVendeurId] = useState('');
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [checking, setChecking] = useState(false);
  const setLine = (k: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l._k === k ? { ...l, ...p } : l)));
  const totalHt = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_price), 0);
  const totalTva = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_price) * Number(l.vat_rate), 0);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (!client.trim()) { setError('Client requis'); return; }
    setBusy('create');
    try {
      await api.createInvoice(dossierId, { clientName: client.trim(), invoiceDate: date, dueDate: due || undefined, docType, template, vendeurId: vendeurId || undefined, lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unit_price: Number(l.unit_price), vat_rate: Number(l.vat_rate), account_code: l.account_code, analytic_axis: l.analytic_axis || undefined })) });
      setCreating(false); setClient(''); setDue(''); setVendeurId(''); setLines([blankLine()]); setReport(null); await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const runCheck = async () => {
    setChecking(true); setError(null);
    try {
      setReport(await api.validateInvoice(dossierId, {
        type: 'vente', date, dueDate: due || undefined, tiers: client.trim() || undefined,
        lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), vatRate: Number(l.vat_rate), accountCode: l.account_code })),
      }));
    } catch (e: any) { setError(e.message); } finally { setChecking(false); }
  };

  const act = async (fn: () => Promise<any>, key: string, gotoType?: DocType) => {
    setBusy(key); setError(null);
    try { await fn(); if (gotoType && gotoType !== docType) setDocType(gotoType); else await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const printDoc = async (id: string) => {
    // Document soigné : on récupère l'identité de l'entreprise (fiche entreprise)
    // pour l'en-tête ; en cas d'échec, un profil minimal suffit au rendu.
    const [inv, co] = await Promise.all([
      api.invoice(dossierId, id),
      api.dossierProfile(dossierId).catch(() => ({ raisonSociale: dossierName } as any)),
    ]);
    printHtml(invoiceDocumentHtml(inv, co, currency));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-sm">
          {DOCS.map((d) => (
            <button key={d.type} onClick={() => setDocType(d.type)}
              className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors', docType === d.type ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
              <d.icon className="h-4 w-4" /> {d.label}
            </button>
          ))}
        </div>
        <button onClick={() => { setLines([blankLine(doc.defAccount)]); setCreating((v) => !v); }} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Nouveau {doc.one}</button>
      </div>

      {creating && (
        <motion.form initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} onSubmit={create} className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-1"><label className="mb-1 block text-xs text-zinc-500">Client</label><input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Raison sociale" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">{docType === 'quote' ? 'Valable jusqu\'au' : 'Échéance'}</label><input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
            {vendeurs.length > 0 && (
              <div className="sm:col-span-3">
                <label className="mb-1 block text-xs text-zinc-500">Vendeur <span className="text-zinc-600">— sert au calcul des commissions ; l'avoir en hérite</span></label>
                <select value={vendeurId} onChange={(e) => setVendeurId(e.target.value)} className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
                  <option value="">— aucun —</option>
                  {vendeurs.map((v) => <option key={v.id} value={v.id}>{v.matricule} — {v.nom} {v.prenoms}</option>)}
                </select>
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Modèle de document (mise en forme à l'impression)</label>
            <div className="inline-flex flex-wrap gap-1.5">
              {([
                { v: 'standard', l: 'Standard' },
                { v: 'goods', l: 'Vente de biens' },
                { v: 'services', l: 'Prestation de services' },
              ] as { v: InvoiceTemplate; l: string }[]).map((o) => (
                <button key={o.v} type="button" onClick={() => setTemplate(o.v)}
                  className={cn('rounded-lg border px-3 py-1.5 text-sm transition-colors', template === o.v ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300' : 'border-white/10 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200')}>
                  {o.l}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-zinc-600">
              {template === 'goods' ? 'Ajoute les modalités de livraison et les conditions de vente (réserve de propriété, garantie).'
                : template === 'services' ? 'Ajoute les modalités d\'exécution et les conditions de prestation (propriété des livrables, révisions).'
                : 'Gabarit générique sarcelle.'}
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500"><tr><th className="pb-1 pr-2">Désignation</th><th className="pb-1 px-2">Compte</th>{sections.length > 0 && <th className="pb-1 px-2">Analytique</th>}<th className="pb-1 px-2 text-right">Qté</th><th className="pb-1 px-2 text-right">P.U. HT</th><th className="pb-1 px-2 text-right">TVA</th><th className="pb-1 px-2 text-right">HT</th><th></th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l._k}>
                  <td className="py-1 pr-2">
                    <div className="flex items-center gap-1.5">
                      {catalog.length > 0 && (
                        <select value="" onChange={(e) => { pickCatalog(l._k, e.target.value); e.target.value = ''; }} title="Choisir un article du catalogue"
                          className="w-8 shrink-0 rounded-md border border-white/10 bg-zinc-900/60 px-1 py-1.5 text-sm text-emerald-300 outline-none focus:border-emerald-500/50">
                          <option value="">＋</option>
                          {catalog.map((it) => <option key={it.id} value={it.id}>{it.reference ? `[${it.reference}] ` : ''}{it.label} — {fmtMoney(it.unit_price, currency)}</option>)}
                        </select>
                      )}
                      <input value={l.description} onChange={(e) => setLine(l._k, { description: e.target.value })} placeholder="Prestation…" className="w-full min-w-[8rem] rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-sm outline-none focus:border-emerald-500/50" />
                    </div>
                  </td>
                  <td className="py-1 px-2"><input value={l.account_code} onChange={(e) => setLine(l._k, { account_code: e.target.value })} className="w-16 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 font-mono text-sm outline-none focus:border-emerald-500/50" /></td>
                  {sections.length > 0 && (
                    <td className="py-1 px-2"><select value={l.analytic_axis ?? ''} onChange={(e) => setLine(l._k, { analytic_axis: e.target.value || null })} className="rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-sm outline-none focus:border-emerald-500/50"><option value="">—</option>{sections.map((s) => <option key={s.code} value={s.code}>{s.code}</option>)}</select></td>
                  )}
                  <td className="py-1 px-2"><input type="number" value={l.quantity} onChange={(e) => setLine(l._k, { quantity: Number(e.target.value) })} className="w-16 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-right font-mono text-sm outline-none focus:border-emerald-500/50" /></td>
                  <td className="py-1 px-2"><input type="number" value={l.unit_price} onChange={(e) => setLine(l._k, { unit_price: Number(e.target.value) })} className="w-24 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-right font-mono text-sm outline-none focus:border-emerald-500/50" /></td>
                  <td className="py-1 px-2"><select value={l.vat_rate} onChange={(e) => setLine(l._k, { vat_rate: Number(e.target.value) })} className="rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-sm outline-none focus:border-emerald-500/50"><option value={0.18}>18%</option><option value={0.09}>9%</option><option value={0}>0%</option></select></td>
                  <td className="py-1 px-2 text-right font-mono text-zinc-300">{fmtMoney(Number(l.quantity) * Number(l.unit_price), currency)}</td>
                  <td className="py-1 pl-2">{lines.length > 1 && <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x._k !== l._k))} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setLines((ls) => [...ls, blankLine(doc.defAccount)])} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-emerald-400"><Plus className="h-4 w-4" /> Ligne</button>
            <div className="flex items-center gap-6 font-mono text-sm text-zinc-400">HT <b className="text-zinc-100">{fmtMoney(totalHt, currency)}</b> · TVA <b className="text-zinc-100">{fmtMoney(totalTva, currency)}</b> · TTC <b className="text-emerald-400">{fmtMoney(totalHt + totalTva, currency)}</b></div>
          </div>
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
          {report && <AqmReportCard report={report} />}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            <button type="button" onClick={runCheck} disabled={checking} className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">{checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Vérifier (AQM)</button>
            <button type="submit" disabled={busy === 'create'} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy === 'create' && <Loader2 className="h-4 w-4 animate-spin" />} Créer le {doc.one}</button>
          </div>
        </motion.form>
      )}

      {error && !creating && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : rows.length === 0 ? <p className="text-sm text-zinc-500">Aucun {doc.one}. Créez le premier.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-3 font-medium">N°</th><th className="px-4 py-3 font-medium">Client</th><th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 text-right font-medium">TTC</th><th className="px-4 py-3 font-medium">Statut</th><th className="px-4 py-3 font-medium">FNE</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 font-mono text-zinc-300">{inv.number ?? '—'}</td>
                  <td className="px-4 py-2.5 text-zinc-300">{inv.client_name}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{inv.invoice_date}</td>
                  <td className={cn('px-4 py-2.5 text-right font-mono', docType === 'credit_note' ? 'text-amber-400' : 'text-zinc-200')}>{docType === 'credit_note' ? '−' : ''}{fmtMoney(inv.total_ttc, currency)}</td>
                  <td className="px-4 py-2.5"><span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS[inv.status]?.cls)}>{STATUS[inv.status]?.label ?? inv.status}</span></td>
                  <td className="px-4 py-2.5">{inv.fne_status === 'certified' ? <span className="flex items-center gap-1 text-xs text-emerald-400"><ShieldCheck className="h-3.5 w-3.5" /> {inv.fne_reference}</span> : <span className="text-xs text-zinc-600">—</span>}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-3">
                      {/* Devis : convertir en facture */}
                      {docType === 'quote' && inv.status === 'draft' && <button onClick={() => act(() => api.convertQuote(dossierId, inv.id), 'q' + inv.id, 'invoice')} className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300">{busy === 'q' + inv.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />} Convertir en facture</button>}
                      {/* Facture / avoir brouillon : émettre */}
                      {docType !== 'quote' && inv.status === 'draft' && <button onClick={() => act(() => api.issueInvoice(dossierId, inv.id), 'i' + inv.id)} className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300">{busy === 'i' + inv.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Émettre</button>}
                      {/* Facture émise : créer un avoir */}
                      {docType === 'invoice' && inv.status !== 'draft' && <button onClick={() => act(() => api.creditNoteFromInvoice(dossierId, inv.id), 'a' + inv.id, 'credit_note')} className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300">{busy === 'a' + inv.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Avoir</button>}
                      {/* Émis, non certifié : FNE (facture & avoir) */}
                      {docType !== 'quote' && inv.status !== 'draft' && inv.fne_status !== 'certified' && <button onClick={() => act(() => api.certifyInvoice(dossierId, inv.id), 'c' + inv.id)} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">{busy === 'c' + inv.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileCheck2 className="h-3.5 w-3.5" />} Certifier FNE</button>}
                      <button onClick={() => printDoc(inv.id)} className="text-zinc-500 hover:text-zinc-300"><Printer className="h-4 w-4" /></button>
                      {inv.status === 'draft' && <button onClick={() => act(() => api.deleteInvoice(dossierId, inv.id), 'd' + inv.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>}
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
