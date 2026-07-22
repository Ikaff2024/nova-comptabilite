import React, { useEffect, useState } from 'react';
import { Loader2, Search, FileSpreadsheet, Printer } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type LedgerRow, currentFiscalYear } from '../lib/api';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

interface Group { code: string; label: string; lines: (LedgerRow & { solde: number })[]; totDebit: number; totCredit: number; }

function groupRows(rows: LedgerRow[]): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let solde = 0;
  for (const r of rows) {
    if (!cur || cur.code !== r.account_code) {
      cur = { code: r.account_code, label: r.account_label, lines: [], totDebit: 0, totCredit: 0 };
      groups.push(cur); solde = 0;
    }
    solde += r.debit - r.credit;
    cur.lines.push({ ...r, solde });
    cur.totDebit += r.debit; cur.totCredit += r.credit;
  }
  return groups;
}

export default function GeneralLedger({
  dossierId, dossierName, fiscalYears, currency,
}: { dossierId: string; dossierName: string; fiscalYears: FiscalYear[]; currency: string }) {
  const [fy, setFy] = useState(currentFiscalYear(fiscalYears)?.id ?? '');
  const [account, setAccount] = useState('');
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try { setRows(await api.generalLedger(dossierId, { fiscalYearId: fy || undefined, account: account.trim() || undefined })); }
      finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [dossierId, fy, account]);

  const groups = groupRows(rows);
  const fyLabel = fiscalYears.find((f) => f.id === fy)?.label ?? '';
  const m = (n: number) => (n ? fmtMoney(n, currency) : '');

  const exportCsv = () => {
    const out: (string | number)[][] = [['Compte', 'Intitulé', 'Date', 'Journal', 'Pièce', 'Libellé', 'Débit', 'Crédit', 'Solde']];
    for (const g of groups) for (const l of g.lines)
      out.push([g.code, g.label, l.entry_date, l.journal_code, l.piece_ref ?? '', l.line_label ?? l.description, l.debit || '', l.credit || '', l.solde]);
    downloadCsv(`grand-livre_${dossierName}_${fyLabel}`.replace(/\s+/g, '-'), out);
  };

  const exportPdf = () => {
    const body = groups.map((g) => `
      <table><thead>
        <tr class="grp"><td colspan="6">${g.code} — ${g.label}</td></tr>
        <tr><th>Date</th><th>Jrnl</th><th>Pièce</th><th>Libellé</th><th class="n">Débit</th><th class="n">Crédit</th></tr>
      </thead><tbody>
        ${g.lines.map((l) => `<tr><td>${l.entry_date}</td><td>${l.journal_code}</td><td>${l.piece_ref ?? ''}</td><td>${(l.line_label ?? l.description ?? '').replace(/[&<>]/g, '')}</td><td class="n">${m(l.debit)}</td><td class="n">${m(l.credit)}</td></tr>`).join('')}
        <tr class="tot"><td colspan="4">Total ${g.code}</td><td class="n">${fmtMoney(g.totDebit, currency)}</td><td class="n">${fmtMoney(g.totCredit, currency)}</td></tr>
      </tbody></table><br/>`).join('');
    printDocument(`Grand livre — ${dossierName}`, `${fyLabel} · devise ${currency} · édité le ${nowStamp()}`, body);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Filtrer par compte (ex. 401)"
              className="w-56 rounded-lg border border-white/10 bg-zinc-900/50 py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-500/50" />
          </div>
          <select value={fy} onChange={(e) => setFy(e.target.value)}
            className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} disabled={!groups.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><FileSpreadsheet className="h-4 w-4" /> Excel/CSV</button>
          <button onClick={exportPdf} disabled={!groups.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><Printer className="h-4 w-4" /> PDF</button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : groups.length === 0 ? (
        <p className="text-zinc-400">Aucun mouvement pour ce filtre.</p>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.code} className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2.5">
                <span className="font-mono text-sm text-zinc-200">{g.code}<span className="ml-3 font-sans text-zinc-400">{g.label}</span></span>
                <span className="font-mono text-xs text-zinc-500">solde {fmtMoney(g.totDebit - g.totCredit, currency)}</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Jrnl</th>
                    <th className="px-4 py-2 font-medium">Pièce</th>
                    <th className="px-4 py-2 font-medium">Libellé</th>
                    <th className="px-4 py-2 text-right font-medium">Débit</th>
                    <th className="px-4 py-2 text-right font-medium">Crédit</th>
                    <th className="px-4 py-2 text-right font-medium">Solde</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono">
                  {g.lines.map((l, i) => (
                    <tr key={i} className="hover:bg-white/5">
                      <td className="px-4 py-1.5 text-zinc-400">{l.entry_date}</td>
                      <td className="px-4 py-1.5 text-zinc-500">{l.journal_code}</td>
                      <td className="px-4 py-1.5 text-zinc-500">{l.piece_ref ?? '—'}</td>
                      <td className="px-4 py-1.5 font-sans text-zinc-300">{l.line_label ?? l.description}</td>
                      <td className="px-4 py-1.5 text-right text-zinc-300">{m(l.debit)}</td>
                      <td className="px-4 py-1.5 text-right text-zinc-300">{m(l.credit)}</td>
                      <td className={cn('px-4 py-1.5 text-right', l.solde >= 0 ? 'text-zinc-200' : 'text-rose-400')}>{fmtMoney(l.solde, currency)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-white/10 bg-white/5 font-mono">
                    <td className="px-4 py-2 font-sans font-medium text-zinc-300" colSpan={4}>Total {g.code}</td>
                    <td className="px-4 py-2 text-right font-semibold text-zinc-100">{fmtMoney(g.totDebit, currency)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-zinc-100">{fmtMoney(g.totCredit, currency)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-zinc-100">{fmtMoney(g.totDebit - g.totCredit, currency)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
