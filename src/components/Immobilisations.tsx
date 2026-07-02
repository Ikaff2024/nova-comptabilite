import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Landmark, CheckCircle2, CalendarClock, ChevronDown, ChevronRight, FileSpreadsheet, Printer } from 'lucide-react';
import { api, fmtMoney, type FixedAsset, type FixedAssetDetail } from '../lib/api';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

export default function Immobilisations({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState(false);

  const load = async () => { setLoading(true); try { setAssets(await api.assets(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const m = (n: number) => fmtMoney(n, currency);
  const totals = assets.reduce((a, x) => ({ amount: a.amount + x.amount, cumul: a.cumul + x.cumulPosted, vnc: a.vnc + x.vnc }), { amount: 0, cumul: 0, vnc: 0 });

  const depreciateYear = async () => {
    if (!confirm(`Comptabiliser les dotations ${year} pour toutes les immobilisations éligibles ?`)) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.depreciateYear(dossierId, year);
      setMsg(`${r.count} dotation(s) comptabilisée(s) pour ${m(r.total)}${r.skipped ? ` — ${r.skipped} ignorée(s) (déjà passées ou non éligibles)` : ''}.`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const remove = async (a: FixedAsset) => {
    if (!confirm(`Supprimer l'immobilisation « ${a.label} » ?`)) return;
    setError(null);
    try { await api.deleteAsset(dossierId, a.id); await load(); } catch (e: any) { setError(e.message); }
  };

  const exportCsv = () => {
    const out: (string | number)[][] = [['Libellé', 'Compte', 'Acquisition', 'Mise en service', "Valeur d'origine", 'Durée', 'Amort. cumulé', 'VNC']];
    for (const a of assets) out.push([a.label, a.assetAccountCode, a.acquisitionDate, a.commissioningDate, a.amount, a.durationYears, a.cumulPosted, a.vnc]);
    out.push(['', '', '', 'TOTAUX', totals.amount, '', totals.cumul, totals.vnc]);
    downloadCsv(`immobilisations_${dossierName}`.replace(/\s+/g, '-'), out);
  };
  const exportPdf = () => {
    const body = `<table><thead><tr><th>Libellé</th><th>Compte</th><th>Mise en service</th><th class="n">Valeur d'origine</th><th class="n">Durée</th><th class="n">Amort. cumulé</th><th class="n">VNC</th></tr></thead><tbody>
      ${assets.map((a) => `<tr><td>${a.label.replace(/[&<>]/g, '')}</td><td>${a.assetAccountCode}</td><td>${a.commissioningDate}</td><td class="n">${m(a.amount)}</td><td class="n">${a.durationYears} ans</td><td class="n">${m(a.cumulPosted)}</td><td class="n">${m(a.vnc)}</td></tr>`).join('')}
      <tr class="tot"><td colspan="3">Totaux</td><td class="n">${m(totals.amount)}</td><td></td><td class="n">${m(totals.cumul)}</td><td class="n">${m(totals.vnc)}</td></tr>
      </tbody></table>`;
    printDocument(`Registre des immobilisations — ${dossierName}`, `devise ${currency} · édité le ${nowStamp()}`, body);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-300"><Landmark className="h-4 w-4 text-emerald-400" /> Registre des immobilisations & amortissements</div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={exportCsv} disabled={!assets.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><FileSpreadsheet className="h-4 w-4" /> Excel/CSV</button>
          <button onClick={exportPdf} disabled={!assets.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><Printer className="h-4 w-4" /> PDF</button>
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1">
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-20 bg-transparent px-1 text-sm outline-none" />
            <button onClick={depreciateYear} disabled={busy} className="flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-sm font-medium text-zinc-100 hover:bg-white/20 disabled:opacity-40">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" />} Dotations {year}</button>
          </div>
          <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Nouvelle immo</button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {msg && <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}

      {showForm && <AssetForm dossierId={dossierId} currency={currency} onDone={() => { setShowForm(false); load(); }} onError={setError} />}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        : assets.length === 0 ? <p className="text-zinc-400">Aucune immobilisation. Créez-en une pour générer son plan d'amortissement.</p>
        : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
              <tr><th className="w-8 px-2 py-2.5"></th><th className="px-4 py-2.5 font-medium">Immobilisation</th><th className="px-4 py-2.5 font-medium">Compte</th><th className="px-4 py-2.5 text-right font-medium">Valeur d'origine</th><th className="px-4 py-2.5 text-right font-medium">Durée</th><th className="px-4 py-2.5 text-right font-medium">Amort. cumulé</th><th className="px-4 py-2.5 text-right font-medium">VNC</th><th className="px-4 py-2.5"></th></tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {assets.map((a) => (
                <React.Fragment key={a.id}>
                  <tr className="hover:bg-white/5">
                    <td className="px-2 py-2 text-center">
                      <button onClick={() => setOpen(open === a.id ? null : a.id)} className="text-zinc-400 hover:text-zinc-200">{open === a.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>
                    </td>
                    <td className="px-4 py-2 text-zinc-200">
                      {a.label}
                      {a.pendingYears.length > 0 && <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{a.pendingYears.length} dotation(s) en attente</span>}
                      {a.fullyAmortized && <span className="ml-2 rounded-full bg-zinc-500/15 px-2 py-0.5 text-xs text-zinc-400">amorti</span>}
                    </td>
                    <td className="px-4 py-2 font-mono text-zinc-400">{a.assetAccountCode}</td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-300">{m(a.amount)}</td>
                    <td className="px-4 py-2 text-right text-zinc-400">{a.durationYears} ans</td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-300">{m(a.cumulPosted)}</td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-100">{m(a.vnc)}</td>
                    <td className="px-4 py-2 text-right"><button onClick={() => remove(a)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                  {open === a.id && <tr><td colSpan={8} className="bg-black/20 px-4 py-3"><AssetSchedule dossierId={dossierId} assetId={a.id} currency={currency} onPosted={load} onError={setError} /></td></tr>}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot className="border-t border-white/10 bg-white/5 font-mono">
              <tr>
                <td></td><td className="px-4 py-3 font-sans font-semibold text-zinc-200" colSpan={2}>Totaux</td>
                <td className="px-4 py-3 text-right font-semibold text-zinc-100">{m(totals.amount)}</td><td></td>
                <td className="px-4 py-3 text-right font-semibold text-zinc-100">{m(totals.cumul)}</td>
                <td className="px-4 py-3 text-right font-semibold text-zinc-100">{m(totals.vnc)}</td><td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function AssetSchedule({ dossierId, assetId, currency, onPosted, onError }: { dossierId: string; assetId: string; currency: string; onPosted: () => void; onError: (s: string) => void }) {
  const [detail, setDetail] = useState<FixedAssetDetail | null>(null);
  const [posting, setPosting] = useState<number | null>(null);
  const m = (n: number) => fmtMoney(n, currency);
  const load = async () => setDetail(await api.assetDetail(dossierId, assetId));
  useEffect(() => { load(); }, [dossierId, assetId]);

  const post = async (year: number) => {
    setPosting(year); onError('');
    try { await api.depreciateAsset(dossierId, assetId, year); await load(); onPosted(); }
    catch (e: any) { onError(e.message); } finally { setPosting(null); }
  };

  if (!detail) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Plan d'amortissement…</div>;
  const currentYear = new Date().getFullYear();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-400">
        <span>Débit dotation : <span className="font-mono text-zinc-300">{detail.expenseAccountCode}</span></span>
        <span>Crédit amortissement : <span className="font-mono text-zinc-300">{detail.amortAccountCode}</span></span>
        <span>Base amortissable : <span className="font-mono text-zinc-300">{m(detail.amount - detail.residualValue)}</span></span>
        <span>Méthode : linéaire {detail.durationYears} ans</span>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-zinc-500"><tr><th className="py-1.5 pr-4 font-medium">Exercice</th><th className="py-1.5 pr-4 text-right font-medium">Dotation</th><th className="py-1.5 pr-4 text-right font-medium">Cumul</th><th className="py-1.5 pr-4 text-right font-medium">VNC</th><th className="py-1.5 font-medium">État</th></tr></thead>
        <tbody className="font-mono">
          {detail.schedule.map((r) => (
            <tr key={r.year} className="border-t border-white/5">
              <td className="py-1.5 pr-4 text-zinc-300">{r.year}</td>
              <td className="py-1.5 pr-4 text-right text-zinc-300">{m(r.dotation)}</td>
              <td className="py-1.5 pr-4 text-right text-zinc-400">{m(r.cumul)}</td>
              <td className="py-1.5 pr-4 text-right text-zinc-400">{m(r.vnc)}</td>
              <td className="py-1.5">
                {r.posted ? <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> comptabilisée</span>
                  : r.year <= currentYear
                    ? <button onClick={() => post(r.year)} disabled={posting === r.year} className="flex items-center gap-1 rounded-md bg-emerald-500/90 px-2.5 py-1 font-sans text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{posting === r.year ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Comptabiliser</button>
                    : <span className="font-sans text-xs text-zinc-500">à venir</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs uppercase text-zinc-400">{label}</label><div className="mt-1">{children}</div></div>;
}

function AssetForm({ dossierId, currency, onDone, onError }: { dossierId: string; currency: string; onDone: () => void; onError: (s: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [label, setLabel] = useState('');
  const [assetAccountCode, setAsset] = useState('2441');
  const [amount, setAmount] = useState('');
  const [residualValue, setResidual] = useState('0');
  const [durationYears, setDuration] = useState('5');
  const [acquisitionDate, setAcq] = useState(today);
  const [commissioningDate, setComm] = useState(today);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true); onError('');
    try {
      await api.createAsset(dossierId, {
        label, assetAccountCode, amount: Number(amount), residualValue: Number(residualValue) || 0,
        durationYears: Number(durationYears), acquisitionDate, commissioningDate,
      });
      onDone();
    } catch (e: any) { onError(e.message); } finally { setSaving(false); }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Libellé"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex. Camion de livraison" className={inputCls} /></Field>
        <Field label="Compte immobilisation (classe 2)"><input value={assetAccountCode} onChange={(e) => setAsset(e.target.value)} className={cn(inputCls, 'font-mono')} /></Field>
        <Field label={`Valeur d'origine (${currency})`}><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className={cn(inputCls, 'font-mono')} /></Field>
        <Field label="Valeur résiduelle"><input type="number" value={residualValue} onChange={(e) => setResidual(e.target.value)} className={cn(inputCls, 'font-mono')} /></Field>
        <Field label="Durée d'utilité (ans)"><input type="number" value={durationYears} onChange={(e) => setDuration(e.target.value)} className={cn(inputCls, 'font-mono')} /></Field>
        <Field label="Date d'acquisition"><input type="date" value={acquisitionDate} onChange={(e) => { setAcq(e.target.value); setComm(e.target.value); }} className={inputCls} /></Field>
        <Field label="Mise en service (début amortissement)"><input type="date" value={commissioningDate} onChange={(e) => setComm(e.target.value)} className={inputCls} /></Field>
      </div>
      <p className="mt-2 text-xs text-zinc-500">Les comptes d'amortissement (28x) et de dotation (68x) sont déduits automatiquement du compte d'immobilisation.</p>
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onDone} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
        <button onClick={submit} disabled={saving || !label || !amount} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</button>
      </div>
    </div>
  );
}
