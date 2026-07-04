import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Landmark, CheckCircle2, AlertTriangle, Printer, Upload, Wand2, FileSpreadsheet, Plus } from 'lucide-react';
import { api, fmtMoney, type BankAccount, type ReconMove, type StatementMatch } from '../lib/api';
import { printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

const SAMPLE_STATEMENT = `Date;Libellé;Débit;Crédit
2026-07-02;Virement client SARL X;;450000
2026-07-05;Prélèvement CIE électricité;35000;
2026-07-08;Frais de tenue de compte;5000;`;

export default function BankReconciliation({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [account, setAccount] = useState('');
  const [moves, setMoves] = useState<ReconMove[]>([]);
  const [statement, setStatement] = useState<string>('');
  const [loading, setLoading] = useState(false);
  // import de relevé
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState('');
  const [match, setMatch] = useState<StatementMatch | null>(null);
  const [impBusy, setImpBusy] = useState(false);
  const [impMsg, setImpMsg] = useState<string | null>(null);
  const [counter, setCounter] = useState('627');
  const fileRef = useRef<HTMLInputElement>(null);

  const loadAccounts = async () => { const a = await api.bankAccounts(dossierId); setAccounts(a); if (!account && a[0]) setAccount(a[0].account_code); };
  useEffect(() => { loadAccounts(); }, [dossierId]);
  const loadMoves = async () => { if (!account) return; setLoading(true); try { const v = await api.reconciliation(dossierId, account); setMoves(v.moves); } finally { setLoading(false); } };
  useEffect(() => { loadMoves(); setMatch(null); }, [account]);

  const analyze = async () => {
    setImpBusy(true); setImpMsg(null);
    try { setMatch(await api.matchStatement(dossierId, account, csv)); }
    catch (e: any) { setImpMsg(e.message); } finally { setImpBusy(false); }
  };
  const applyMatches = async () => {
    if (!match) return;
    setImpBusy(true); setImpMsg(null);
    try {
      const r = await api.applyPointings(dossierId, match.matched.map((m) => m.entryLineId));
      setImpMsg(`${r.pointed} écriture(s) pointée(s) automatiquement.`);
      await loadMoves(); await loadAccounts();
      setMatch(await api.matchStatement(dossierId, account, csv));
    } catch (e: any) { setImpMsg(e.message); } finally { setImpBusy(false); }
  };
  const createRow = async (row: { date: string; label: string; amount: number }) => {
    if (!counter.trim()) { setImpMsg('Indiquez un compte de contrepartie.'); return; }
    setImpBusy(true); setImpMsg(null);
    try {
      await api.createFromStatement(dossierId, account, row, counter.trim());
      await loadMoves(); await loadAccounts();
      setMatch(await api.matchStatement(dossierId, account, csv));
    } catch (e: any) { setImpMsg(e.message); } finally { setImpBusy(false); }
  };
  const onFile = (f: File) => { const r = new FileReader(); r.onload = () => { setCsv(String(r.result ?? '')); setMatch(null); }; r.readAsText(f, 'utf-8'); };

  const toggle = async (id: string, next: boolean) => {
    setMoves((ms) => ms.map((m) => (m.entry_line_id === id ? { ...m, pointed: next } : m)));
    try { await api.point(dossierId, id, next); await loadAccounts(); }
    catch { setMoves((ms) => ms.map((m) => (m.entry_line_id === id ? { ...m, pointed: !next } : m))); }
  };

  const L = useMemo(() => moves.reduce((s, m) => s + m.debit - m.credit, 0), [moves]);
  const P = useMemo(() => moves.filter((m) => m.pointed).reduce((s, m) => s + m.debit - m.credit, 0), [moves]);
  const unpointed = moves.filter((m) => !m.pointed);
  const R = statement === '' ? null : Number(statement);
  const ecart = R === null ? null : R - P;
  const reconciled = ecart !== null && Math.abs(ecart) < 0.001;

  const exportPdf = () => {
    const rows = unpointed.map((m) => `<tr><td>${m.entry_date}</td><td>${(m.label ?? '').replace(/[&<>]/g, '')}</td><td class="n">${m.debit ? fmtMoney(m.debit, currency) : ''}</td><td class="n">${m.credit ? fmtMoney(m.credit, currency) : ''}</td></tr>`).join('');
    const body = `
      <table><tbody>
        <tr class="tot"><td>Solde comptable (${account})</td><td class="n">${fmtMoney(L, currency)}</td></tr>
        <tr><td>dont pointé (figurant au relevé)</td><td class="n">${fmtMoney(P, currency)}</td></tr>
        <tr><td>Solde du relevé bancaire</td><td class="n">${R === null ? '—' : fmtMoney(R, currency)}</td></tr>
        <tr class="tot"><td>Écart de rapprochement</td><td class="n">${ecart === null ? '—' : fmtMoney(ecart, currency)}</td></tr>
      </tbody></table>
      <h2 style="margin-top:16px">Écritures en rapprochement (non pointées)</h2>
      <table><thead><tr><th>Date</th><th>Libellé</th><th class="n">Débit</th><th class="n">Crédit</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Aucune</td></tr>'}</tbody></table>`;
    printDocument(`État de rapprochement bancaire — ${dossierName}`, `compte ${account} · au ${nowStamp()} · devise ${currency}`, body);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-400"><Landmark className="h-4 w-4" /> Compte</label>
        <select value={account} onChange={(e) => setAccount(e.target.value)}
          className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
          {accounts.map((a) => <option key={a.account_code} value={a.account_code}>{a.account_code} · {a.label} ({a.unpointed} à pointer)</option>)}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-sm text-zinc-400">Solde du relevé</label>
          <input value={statement} onChange={(e) => setStatement(e.target.value)} type="number" placeholder="ex. 650000"
            className="w-36 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-right font-mono text-sm outline-none focus:border-emerald-500/50" />
          <button onClick={() => setShowImport((v) => !v)} className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20"><Upload className="h-4 w-4" /> Importer un relevé</button>
          <button onClick={exportPdf} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> PDF</button>
        </div>
      </div>

      {showImport && (
        <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-zinc-300">Relevé bancaire (CSV : Date ; Libellé ; Débit ; Crédit) — rapprochement assisté sur <span className="font-mono text-zinc-400">{account}</span></div>
            <div className="flex gap-2">
              <button onClick={() => { setCsv(SAMPLE_STATEMENT); setMatch(null); }} className="text-xs text-zinc-400 hover:text-emerald-400">Exemple</button>
              <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-emerald-400"><FileSpreadsheet className="h-3.5 w-3.5" /> Fichier…</button>
              <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </div>
          </div>
          <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setMatch(null); }} rows={5} placeholder={SAMPLE_STATEMENT}
            className="w-full rounded-xl border border-white/10 bg-zinc-900/60 p-3 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={analyze} disabled={impBusy || !csv.trim()} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">{impBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Analyser le relevé</button>
            {match && match.matched.length > 0 && <button onClick={applyMatches} disabled={impBusy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"><CheckCircle2 className="h-4 w-4" /> Pointer les {match.matched.length} rapprochement(s)</button>}
          </div>
          {impMsg && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">{impMsg}</p>}

          {match && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-emerald-300">{match.counts.matched} à pointer</span>
                {match.counts.alreadyReconciled > 0 && <span className="rounded-full bg-white/10 px-2.5 py-1 text-zinc-300">{match.counts.alreadyReconciled} déjà rapprochés</span>}
                <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-300">{match.counts.unmatchedStatement} sur le relevé sans écriture</span>
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-zinc-300">{match.counts.unmatchedLedger} écritures non trouvées au relevé</span>
              </div>

              {match.unmatchedStatement.length > 0 && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
                  <div className="mb-2 flex items-center justify-between text-sm text-amber-300">
                    <span>Lignes du relevé sans écriture — à créer</span>
                    <span className="flex items-center gap-1.5 text-xs text-zinc-400">Contrepartie <input value={counter} onChange={(e) => setCounter(e.target.value)} className="w-20 rounded border border-white/10 bg-zinc-900/60 px-2 py-1 font-mono text-zinc-200 outline-none" /></span>
                  </div>
                  <table className="w-full text-left text-sm">
                    <tbody className="divide-y divide-white/5 font-mono">
                      {match.unmatchedStatement.map((r, i) => (
                        <tr key={i}>
                          <td className="py-1.5 pr-3 text-zinc-400">{r.date}</td>
                          <td className="py-1.5 pr-3 font-sans text-zinc-300">{r.label}</td>
                          <td className={cn('py-1.5 pr-3 text-right', r.amount >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtMoney(r.amount, currency)}</td>
                          <td className="py-1.5 text-right"><button onClick={() => createRow(r)} disabled={impBusy} className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 font-sans text-xs text-zinc-100 hover:bg-white/20 disabled:opacity-40"><Plus className="h-3.5 w-3.5" /> Créer</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-1.5 text-xs text-zinc-500">Crée l'écriture banque ↔ compte {counter} (encaissement : débit banque / crédit contrepartie ; décaissement : l'inverse), et la pointe.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* État de rapprochement */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Card label="Solde comptable" value={fmtMoney(L, currency)} />
        <Card label="Solde pointé" value={fmtMoney(P, currency)} />
        <Card label="Solde du relevé" value={R === null ? '—' : fmtMoney(R, currency)} />
        <div className={cn('rounded-2xl border p-4', reconciled ? 'border-emerald-500/30 bg-emerald-500/10' : ecart === null ? 'border-white/10 bg-white/5' : 'border-amber-500/30 bg-amber-500/10')}>
          <div className="text-sm text-zinc-400">Écart de rapprochement</div>
          <div className="mt-2 flex items-center gap-2 font-mono text-xl font-bold">
            {ecart === null ? <span className="text-zinc-500">—</span> : reconciled
              ? <span className="flex items-center gap-1.5 text-emerald-400"><CheckCircle2 className="h-5 w-5" /> rapproché</span>
              : <span className="flex items-center gap-1.5 text-amber-400"><AlertTriangle className="h-5 w-5" /> {fmtMoney(ecart, currency)}</span>}
          </div>
        </div>
      </div>
      {R !== null && !reconciled && <p className="text-xs text-zinc-500">Pointez les écritures figurant sur le relevé jusqu'à ce que le solde pointé égale le solde du relevé (écart = 0).</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-2.5 font-medium">Pointé</th><th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Pièce</th><th className="px-4 py-2.5 font-medium">Libellé</th>
              <th className="px-4 py-2.5 text-right font-medium">Débit</th><th className="px-4 py-2.5 text-right font-medium">Crédit</th>
            </tr></thead>
            <tbody className="divide-y divide-white/5 font-mono">
              {moves.map((m) => (
                <tr key={m.entry_line_id} className={cn('hover:bg-white/5', m.pointed && 'bg-emerald-500/[0.04]')}>
                  <td className="px-4 py-2"><input type="checkbox" checked={m.pointed} onChange={(e) => toggle(m.entry_line_id, e.target.checked)} className="accent-emerald-500" /></td>
                  <td className="px-4 py-2 text-zinc-400">{m.entry_date}</td>
                  <td className="px-4 py-2 text-zinc-500">{m.piece_ref ?? '—'}</td>
                  <td className="px-4 py-2 font-sans text-zinc-300">{m.label}</td>
                  <td className="px-4 py-2 text-right text-zinc-300">{m.debit ? fmtMoney(m.debit, currency) : ''}</td>
                  <td className="px-4 py-2 text-right text-zinc-300">{m.credit ? fmtMoney(m.credit, currency) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="text-sm text-zinc-400">{label}</div>
      <div className="mt-2 font-mono text-xl font-bold text-zinc-100">{value}</div>
    </div>
  );
}
