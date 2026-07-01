import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Link2, Unlink, CalendarClock, FileSpreadsheet, Printer, CheckCircle2 } from 'lucide-react';
import { api, fmtMoney, type FiscalYear, type TiersAccount, type OpenItem, type LetteredItem, type AgedRow } from '../lib/api';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

export default function Tiers({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [view, setView] = useState<'lettrage' | 'aged'>('lettrage');
  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-sm">
        {([['lettrage', 'Lettrage', Link2], ['aged', 'Balance âgée', CalendarClock]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setView(id)}
            className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors', view === id ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
      {view === 'lettrage' ? <Lettrage dossierId={dossierId} currency={currency} /> : <Aged dossierId={dossierId} dossierName={dossierName} currency={currency} />}
    </div>
  );
}

function Lettrage({ dossierId, currency }: { dossierId: string; currency: string }) {
  const [accounts, setAccounts] = useState<TiersAccount[]>([]);
  const [account, setAccount] = useState('');
  const [data, setData] = useState<{ open: OpenItem[]; lettered: LetteredItem[] } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const loadAccounts = async () => {
    const a = await api.tiersAccounts(dossierId); setAccounts(a);
    if (!account && a[0]) setAccount(a[0].account_code);
  };
  useEffect(() => { loadAccounts(); }, [dossierId]);

  const loadView = async () => {
    if (!account) return;
    setLoading(true); setSel(new Set());
    try { setData(await api.lettrageView(dossierId, account)); } finally { setLoading(false); }
  };
  useEffect(() => { loadView(); }, [account]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const selDebit = useMemo(() => (data?.open ?? []).filter((o) => sel.has(o.entry_line_id)).reduce((s, o) => s + o.debit, 0), [sel, data]);
  const selCredit = useMemo(() => (data?.open ?? []).filter((o) => sel.has(o.entry_line_id)).reduce((s, o) => s + o.credit, 0), [sel, data]);
  const balanced = sel.size >= 2 && Math.abs(selDebit - selCredit) < 0.001;

  const letter = async () => {
    setError(null); setOk(null);
    try {
      const r = await api.createLettrage(dossierId, account, [...sel]);
      setOk(`Lettrage ${r.code} créé`); setTimeout(() => setOk(null), 2500);
      await loadView(); await loadAccounts();
    } catch (e: any) { setError(e.message); }
  };
  const unletter = async (id: string) => { await api.deleteLettrage(dossierId, id); await loadView(); await loadAccounts(); };

  const groups = useMemo(() => {
    const m = new Map<string, { code: string; items: LetteredItem[] }>();
    for (const l of data?.lettered ?? []) { if (!m.has(l.id)) m.set(l.id, { code: l.code, items: [] }); m.get(l.id)!.items.push(l); }
    return [...m.entries()].map(([id, v]) => ({ id, ...v }));
  }, [data]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-zinc-400">Compte de tiers</label>
        <select value={account} onChange={(e) => setAccount(e.target.value)}
          className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
          {accounts.map((a) => <option key={a.account_code} value={a.account_code}>{a.account_code} · {a.label} ({a.open_count})</option>)}
        </select>
        {ok && <span className="flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {ok}</span>}
      </div>

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : !data ? null : (
        <>
          {/* Pièces non lettrées */}
          <div className="rounded-2xl border border-white/10 bg-white/5">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
              <span className="text-sm font-medium text-zinc-200">Pièces non lettrées</span>
              <div className="flex items-center gap-4 text-sm">
                <span className="font-mono text-zinc-400">Sél. D {fmtMoney(selDebit, currency)} · C {fmtMoney(selCredit, currency)} {sel.size >= 1 && (balanced ? <span className="text-emerald-400">✓</span> : <span className="text-amber-400">Δ {fmtMoney(Math.abs(selDebit - selCredit), currency)}</span>)}</span>
                <button onClick={letter} disabled={!balanced}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"><Link2 className="h-4 w-4" /> Lettrer</button>
              </div>
            </div>
            {data.open.length === 0 ? <p className="px-4 py-4 text-sm text-zinc-500">Tout est lettré ✅</p> : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-zinc-500"><tr>
                  <th className="px-4 py-2"></th><th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Pièce</th>
                  <th className="px-4 py-2 font-medium">Libellé</th><th className="px-4 py-2 text-right font-medium">Débit</th><th className="px-4 py-2 text-right font-medium">Crédit</th>
                </tr></thead>
                <tbody className="divide-y divide-white/5 font-mono">
                  {data.open.map((o) => (
                    <tr key={o.entry_line_id} className={cn('hover:bg-white/5', sel.has(o.entry_line_id) && 'bg-emerald-500/5')}>
                      <td className="px-4 py-2"><input type="checkbox" checked={sel.has(o.entry_line_id)} onChange={() => toggle(o.entry_line_id)} className="accent-emerald-500" /></td>
                      <td className="px-4 py-2 text-zinc-400">{o.entry_date}</td>
                      <td className="px-4 py-2 text-zinc-500">{o.piece_ref ?? '—'}</td>
                      <td className="px-4 py-2 font-sans text-zinc-300">{o.label}</td>
                      <td className="px-4 py-2 text-right text-zinc-300">{o.debit ? fmtMoney(o.debit, currency) : ''}</td>
                      <td className="px-4 py-2 text-right text-zinc-300">{o.credit ? fmtMoney(o.credit, currency) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

          {/* Lettrages existants */}
          {groups.length > 0 && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="mb-2 text-sm font-medium text-zinc-200">Lettrages</div>
              <div className="space-y-2">
                {groups.map((g) => (
                  <div key={g.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-sm">
                    <div className="flex items-center gap-3">
                      <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-emerald-400">{g.code}</span>
                      <span className="text-zinc-400">{g.items.length} pièce(s) · {g.items.map((i) => i.entry_date).join(', ')}</span>
                    </div>
                    <button onClick={() => unletter(g.id)} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-rose-400"><Unlink className="h-3.5 w-3.5" /> délettrer</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Aged({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [rows, setRows] = useState<AgedRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { (async () => { setLoading(true); try { setRows(await api.agedBalance(dossierId)); } finally { setLoading(false); } })(); }, [dossierId]);

  const cols = ['b0_30', 'b31_60', 'b61_90', 'b90_plus'] as const;
  const heads = ['0-30 j', '31-60 j', '61-90 j', '+90 j'];
  const tot = (k: keyof AgedRow) => rows.reduce((s, r) => s + (r[k] as number), 0);

  const exportCsv = () => {
    const out: (string | number)[][] = [['Compte', 'Intitulé', ...heads, 'Solde']];
    for (const r of rows) out.push([r.account_code, r.label, r.b0_30, r.b31_60, r.b61_90, r.b90_plus, r.balance]);
    out.push(['', 'TOTAUX', tot('b0_30'), tot('b31_60'), tot('b61_90'), tot('b90_plus'), tot('balance')]);
    downloadCsv(`balance-agee_${dossierName}`.replace(/\s+/g, '-'), out);
  };
  const exportPdf = () => {
    const head = `<tr><th>Compte</th><th>Intitulé</th>${heads.map((h) => `<th class="n">${h}</th>`).join('')}<th class="n">Solde</th></tr>`;
    const body = rows.map((r) => `<tr><td>${r.account_code}</td><td>${(r.label ?? '').replace(/[&<>]/g, '')}</td>${cols.map((k) => `<td class="n">${r[k] ? fmtMoney(r[k], currency) : ''}</td>`).join('')}<td class="n">${fmtMoney(r.balance, currency)}</td></tr>`).join('');
    const t = `<tr class="tot"><td colspan="2">Totaux</td>${cols.map((k) => `<td class="n">${fmtMoney(tot(k), currency)}</td>`).join('')}<td class="n">${fmtMoney(tot('balance'), currency)}</td></tr>`;
    printDocument(`Balance âgée — ${dossierName}`, `au ${nowStamp()} · devise ${currency}`, `<table><thead>${head}</thead><tbody>${body}${t}</tbody></table>`);
  };

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div>;
  if (rows.length === 0) return <p className="text-zinc-400">Aucun encours de tiers (tout est lettré ou soldé).</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-400">Encours des tiers par ancienneté (non lettrés)</p>
        <div className="flex gap-2">
          <button onClick={exportCsv} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><FileSpreadsheet className="h-4 w-4" /> Excel/CSV</button>
          <button onClick={exportPdf} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> PDF</button>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
            <th className="px-4 py-3 font-medium">Compte</th><th className="px-4 py-3 font-medium">Intitulé</th>
            {heads.map((h) => <th key={h} className="px-4 py-3 text-right font-medium">{h}</th>)}
            <th className="px-4 py-3 text-right font-medium">Solde</th>
          </tr></thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {rows.map((r) => (
              <tr key={r.account_code} className="hover:bg-white/5">
                <td className="px-4 py-2 text-zinc-300">{r.account_code}</td>
                <td className="px-4 py-2 font-sans text-zinc-400">{r.label}</td>
                {cols.map((k) => <td key={k} className={cn('px-4 py-2 text-right', k === 'b90_plus' && r[k] ? 'text-rose-400' : 'text-zinc-300')}>{r[k] ? fmtMoney(r[k], currency) : '—'}</td>)}
                <td className="px-4 py-2 text-right font-medium text-zinc-100">{fmtMoney(r.balance, currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
            <td className="px-4 py-3 font-sans font-semibold text-zinc-200" colSpan={2}>Totaux</td>
            {cols.map((k) => <td key={k} className="px-4 py-3 text-right font-semibold text-zinc-100">{fmtMoney(tot(k), currency)}</td>)}
            <td className="px-4 py-3 text-right font-semibold text-zinc-100">{fmtMoney(tot('balance'), currency)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>
  );
}
