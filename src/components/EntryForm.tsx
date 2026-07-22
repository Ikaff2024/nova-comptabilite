import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, CheckCircle2, Save, ShieldCheck, Activity } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type Journal, type EntryLineInput, type ProposedLine, type AnalyticSection, type EntryTemplate, type ValidationReport, type Account, type SimulationResult, currentFiscalYear } from '../lib/api';
import AqmReportCard from './AqmReportCard';

const CHANNELS = [
  { v: 'none', l: '—' }, { v: 'cash', l: 'Espèces' }, { v: 'bank', l: 'Banque' },
  { v: 'wave', l: 'Wave' }, { v: 'om', l: 'Orange Money' }, { v: 'momo', l: 'MTN MoMo' },
  { v: 'moov', l: 'Moov Money' }, { v: 'cheque', l: 'Chèque' },
];

type Line = EntryLineInput & { _key: number };
let keySeq = 0;
const blank = (): Line => ({ _key: ++keySeq, accountCode: '', debit: undefined, credit: undefined, paymentChannel: 'none' });
const toLine = (p: ProposedLine): Line => ({ _key: ++keySeq, accountCode: p.accountCode ?? '', debit: p.debit, credit: p.credit, label: p.label, paymentChannel: 'none' });

export interface EntryFormInitial {
  description?: string; entryDate?: string; journalCode?: string; lines?: ProposedLine[]; counterpartyName?: string;
}

export default function EntryForm({
  dossierId, fiscalYears, journals, currency, onPosted, initial, banner, documentUrl,
}: {
  dossierId: string; fiscalYears: FiscalYear[]; journals: Journal[]; currency: string; onPosted: () => void;
  initial?: EntryFormInitial; banner?: React.ReactNode; documentUrl?: string;
}) {
  const [fy, setFy] = useState(currentFiscalYear(fiscalYears)?.id ?? '');
  const [journal, setJournal] = useState(
    (initial?.journalCode && journals.find((j) => j.code === initial.journalCode)?.id)
    || journals.find((j) => j.code === 'VE')?.id || journals[0]?.id || '',
  );
  const [date, setDate] = useState(initial?.entryDate || new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [lines, setLines] = useState<Line[]>(
    initial?.lines?.length ? initial.lines.map(toLine) : [blank(), blank()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [sections, setSections] = useState<AnalyticSection[]>([]);
  useEffect(() => { api.analyticSections(dossierId).then(setSections).catch(() => {}); }, [dossierId]);
  // Plan de comptes chargé une fois → suggestions par préfixe pendant la saisie.
  const [accts, setAccts] = useState<Account[]>([]);
  const [acOpen, setAcOpen] = useState<number | null>(null); // ligne dont le menu est ouvert
  useEffect(() => { api.accounts(dossierId).then(setAccts).catch(() => {}); }, [dossierId]);
  const suggest = (v: string): Account[] => {
    const q = (v ?? '').trim();
    if (!q) return [];
    return accts.filter((a) => a.account_code.startsWith(q)).slice(0, 8);
  };
  const [templates, setTemplates] = useState<EntryTemplate[]>([]);
  const loadTemplates = () => api.entryTemplates(dossierId).then(setTemplates).catch(() => {});
  useEffect(() => { loadTemplates(); }, [dossierId]);

  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id); if (!t) return;
    setLines(t.lines.map((l) => ({ _key: ++keySeq, accountCode: l.accountCode ?? '', debit: l.debit, credit: l.credit, label: l.label, paymentChannel: 'none' })));
    if (t.journalCode) { const j = journals.find((x) => x.code === t.journalCode); if (j) setJournal(j.id); }
  };
  const saveTemplate = async () => {
    const name = window.prompt('Nom du modèle ?'); if (!name?.trim()) return;
    const journalCode = journals.find((j) => j.id === journal)?.code ?? null;
    try {
      await api.createEntryTemplate(dossierId, { name: name.trim(), journalCode, lines: lines.filter((l) => l.accountCode.trim()).map((l) => ({ accountCode: l.accountCode.trim(), label: l.label, debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined })) });
      await loadTemplates();
    } catch (e: any) { setError(e.message); }
  };
  const removeTemplate = async (id: string) => { try { await api.deleteEntryTemplate(dossierId, id); await loadTemplates(); } catch { /* ignore */ } };

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = totalDebit === totalCredit && totalDebit > 0;

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l._key === key ? { ...l, ...patch } : l)));

  const draftLines = () => lines.filter((l) => l.accountCode.trim()).map((l) => ({
    accountCode: l.accountCode.trim(), debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined, label: l.label,
  }));

  // Simulation d'impact « avant validation » — mise à jour (débounce) à la saisie.
  useEffect(() => {
    const dl = lines.filter((l) => l.accountCode.trim()).map((l) => ({ accountCode: l.accountCode.trim(), debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined }));
    if (dl.length === 0 || (totalDebit === 0 && totalCredit === 0)) { setSim(null); return; }
    const t = setTimeout(() => { api.simulateEntry(dossierId, dl).then(setSim).catch(() => setSim(null)); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossierId, lines]);
  const runCheck = async () => {
    setChecking(true); setError(null);
    try {
      const journalCode = journals.find((j) => j.id === journal)?.code;
      setReport(await api.validateEntry(dossierId, { entryDate: date, fiscalYearId: fy, journalCode, lines: draftLines() }));
    } catch (e: any) { setError(e.message); } finally { setChecking(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!balanced) { setError('Écriture non équilibrée.'); return; }
    setBusy(true);
    try {
      await api.postEntry(dossierId, {
        fiscalYearId: fy, journalId: journal, entryDate: date, description, source: 'manual',
        counterpartyName: initial?.counterpartyName, documentUrl,
        lines: lines.filter((l) => l.accountCode.trim()).map((l) => ({
          accountCode: l.accountCode.trim(),
          debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined,
          paymentChannel: l.paymentChannel, label: l.label, analyticAxis: l.analyticAxis || undefined,
        })),
      });
      setOk(true);
      setLines([blank(), blank()]); setDescription(''); setReport(null);
      setTimeout(() => setOk(false), 2500);
      onPosted();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-5 rounded-2xl border border-white/10 bg-white/5 p-6">
      {banner}
      <div className="flex flex-wrap items-center gap-2">
        <select value="" onChange={(e) => { applyTemplate(e.target.value); e.target.value = ''; }} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-300 outline-none focus:border-emerald-500/50">
          <option value="">Charger un modèle…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="button" onClick={saveTemplate} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10"><Save className="h-4 w-4" /> Enregistrer comme modèle</button>
        {templates.map((t) => (
          <span key={t.id} className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-400">
            {t.name}<button type="button" onClick={() => removeTemplate(t.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-3 w-3" /></button>
          </span>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-zinc-400">Exercice</label>
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-zinc-400">Journal</label>
          <select value={journal} onChange={(e) => setJournal(e.target.value)} className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
            {journals.map((j) => <option key={j.id} value={j.id}>{j.code} · {j.label}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-zinc-400">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-400">Libellé de la pièce</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Vente comptant boutique" required
          className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" />
      </div>

      {/* Lignes */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="pb-2 pr-2 font-medium">Compte</th>
              <th className="pb-2 px-2 font-medium">Libellé</th>
              <th className="pb-2 px-2 font-medium">Canal</th>
              {sections.length > 0 && <th className="pb-2 px-2 font-medium">Analytique</th>}
              <th className="pb-2 px-2 text-right font-medium">Débit</th>
              <th className="pb-2 px-2 text-right font-medium">Crédit</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l._key}>
                <td className="relative py-1 pr-2">
                  <input value={l.accountCode}
                    onChange={(e) => { setLine(l._key, { accountCode: e.target.value }); setAcOpen(l._key); }}
                    onFocus={() => setAcOpen(l._key)}
                    onBlur={() => setTimeout(() => setAcOpen((k) => (k === l._key ? null : k)), 150)}
                    placeholder="521" autoComplete="off"
                    className="w-24 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 font-mono outline-none focus:border-emerald-500/50" />
                  {acOpen === l._key && suggest(l.accountCode).length > 0 && (
                    <ul className="absolute z-20 mt-1 max-h-64 w-72 overflow-auto rounded-lg border border-white/10 bg-zinc-900 py-1 shadow-xl">
                      {suggest(l.accountCode).map((a) => (
                        <li key={a.account_code}>
                          <button type="button"
                            onMouseDown={(e) => { e.preventDefault(); setLine(l._key, { accountCode: a.account_code, label: l.label?.trim() ? l.label : a.label }); setAcOpen(null); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-white/5">
                            <span className="font-mono text-emerald-400">{a.account_code}</span>
                            <span className="truncate text-zinc-300">{a.label}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-1 px-2">
                  <input value={l.label ?? ''} onChange={(e) => setLine(l._key, { label: e.target.value })} placeholder="(optionnel)"
                    className="w-full min-w-[8rem] rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 outline-none focus:border-emerald-500/50" />
                </td>
                <td className="py-1 px-2">
                  <select value={l.paymentChannel} onChange={(e) => setLine(l._key, { paymentChannel: e.target.value })}
                    className="rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 outline-none focus:border-emerald-500/50">
                    {CHANNELS.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
                  </select>
                </td>
                {sections.length > 0 && (
                  <td className="py-1 px-2">
                    <select value={l.analyticAxis ?? ''} onChange={(e) => setLine(l._key, { analyticAxis: e.target.value })}
                      className="rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 outline-none focus:border-emerald-500/50">
                      <option value="">—</option>
                      {sections.map((s) => <option key={s.id} value={s.code}>{s.code}</option>)}
                    </select>
                  </td>
                )}
                <td className="py-1 px-2">
                  <input type="number" min="0" step="any" value={l.debit ?? ''} onChange={(e) => setLine(l._key, { debit: e.target.value === '' ? undefined : Number(e.target.value), credit: undefined })}
                    className="w-28 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-right font-mono outline-none focus:border-emerald-500/50" />
                </td>
                <td className="py-1 px-2">
                  <input type="number" min="0" step="any" value={l.credit ?? ''} onChange={(e) => setLine(l._key, { credit: e.target.value === '' ? undefined : Number(e.target.value), debit: undefined })}
                    className="w-28 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-right font-mono outline-none focus:border-emerald-500/50" />
                </td>
                <td className="py-1 pl-2">
                  {lines.length > 2 && (
                    <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x._key !== l._key))} className="text-zinc-600 hover:text-rose-400">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <button type="button" onClick={() => setLines((ls) => [...ls, blank()])} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-emerald-400">
          <Plus className="h-4 w-4" /> Ajouter une ligne
        </button>
        <div className="flex items-center gap-6 font-mono text-sm">
          <span className="text-zinc-400">Débit <b className="text-zinc-100">{fmtMoney(totalDebit, currency)}</b></span>
          <span className="text-zinc-400">Crédit <b className="text-zinc-100">{fmtMoney(totalCredit, currency)}</b></span>
          <span className={balanced ? 'text-emerald-400' : 'text-amber-400'}>
            {balanced ? '✓ équilibrée' : `Δ ${fmtMoney(Math.abs(totalDebit - totalCredit), currency)}`}
          </span>
        </div>
      </div>

      {sim && (sim.deltaResultat !== 0 || sim.deltaTva !== 0 || sim.deltaTresorerie !== 0) && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300"><Activity className="h-3.5 w-3.5 text-sky-400" /> Impact si vous validez <span className="font-normal text-zinc-500">(simulation, rien n'est comptabilisé)</span></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ImpactTile label="Résultat" value={sim.deltaResultat} currency={currency} good="up" />
            <ImpactTile label="TVA à payer" value={sim.deltaTva} currency={currency} good="down" />
            <ImpactTile label="Trésorerie" value={sim.deltaTresorerie} currency={currency} good="up" />
            <ImpactTile label="IS estimé" value={sim.deltaIsEstime} currency={currency} good="down" hint="indicatif 25 %" />
          </div>
        </div>
      )}

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {report && <AqmReportCard report={report} />}

      <div className="flex items-center justify-end gap-3">
        {ok && <span className="flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Écriture enregistrée</span>}
        <button type="button" onClick={runCheck} disabled={checking || !lines.some((l) => l.accountCode.trim())}
          className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Vérifier (AQM)
        </button>
        <button type="submit" disabled={busy || !balanced}
          className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-40">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Valider l'écriture
        </button>
      </div>
    </form>
  );
}

// Tuile d'impact : couleur selon que la variation est favorable ou non.
// good='up' → une hausse est favorable (résultat, trésorerie) ; good='down' →
// une hausse est défavorable (TVA à payer, IS).
function ImpactTile({ label, value, currency, good, hint }: { label: string; value: number; currency: string; good: 'up' | 'down'; hint?: string }) {
  const favorable = value === 0 ? null : (good === 'up' ? value > 0 : value < 0);
  const color = favorable === null ? 'text-zinc-300' : favorable ? 'text-emerald-400' : 'text-amber-400';
  const sign = value > 0 ? '+' : '';
  return (
    <div className="rounded-lg border border-white/5 bg-zinc-900/40 px-3 py-2">
      <div className="text-[11px] text-zinc-500">{label}{hint ? ` · ${hint}` : ''}</div>
      <div className={`font-mono text-sm font-semibold ${color}`}>{sign}{fmtMoney(value, currency)}</div>
    </div>
  );
}

