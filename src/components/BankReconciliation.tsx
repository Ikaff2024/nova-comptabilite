import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Landmark, CheckCircle2, AlertTriangle, Printer } from 'lucide-react';
import { api, fmtMoney, type BankAccount, type ReconMove } from '../lib/api';
import { printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

export default function BankReconciliation({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [account, setAccount] = useState('');
  const [moves, setMoves] = useState<ReconMove[]>([]);
  const [statement, setStatement] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const loadAccounts = async () => { const a = await api.bankAccounts(dossierId); setAccounts(a); if (!account && a[0]) setAccount(a[0].account_code); };
  useEffect(() => { loadAccounts(); }, [dossierId]);
  useEffect(() => {
    if (!account) return;
    (async () => { setLoading(true); try { const v = await api.reconciliation(dossierId, account); setMoves(v.moves); } finally { setLoading(false); } })();
  }, [account]);

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
          <button onClick={exportPdf} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> PDF</button>
        </div>
      </div>

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
