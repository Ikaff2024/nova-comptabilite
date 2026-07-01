import React, { useEffect, useState } from 'react';
import { Loader2, Receipt, FileCheck2, Printer, CheckCircle2, FileText } from 'lucide-react';
import { api, fmtMoney, type VatDeclaration } from '../lib/api';
import { printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export default function Fiscalite({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<VatDeclaration | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { from, to } = monthRange(month);
  const load = async () => { setLoading(true); setMsg(null); try { setData(await api.vatDeclaration(dossierId, from, to)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId, month]);

  const liquidate = async () => {
    if (!confirm(`Générer l'écriture de liquidation de la TVA du mois ${month} ?`)) return;
    setBusy(true); setError(null); setMsg(null);
    try { const r = await api.liquidateVat(dossierId, { from, to, date: to }); setMsg(`Écriture de liquidation générée${r.netDue ? ` — TVA à payer : ${fmtMoney(r.netDue, currency)}` : ''}.`); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const exportPdf = () => {
    if (!data) return;
    const m = (n: number) => fmtMoney(n, currency);
    const rows = data.breakdown.map((b) => `<tr><td>${b.account_code}</td><td>${(b.label ?? '').replace(/[&<>]/g, '')}</td><td class="n">${m(b.debit)}</td><td class="n">${m(b.credit)}</td></tr>`).join('');
    const body = `
      <table style="margin-bottom:12px"><tbody>
        <tr class="tot"><td>TVA collectée (443)</td><td class="n">${m(data.collectee)}</td></tr>
        <tr class="tot"><td>TVA déductible (445)</td><td class="n">${m(data.deductible)}</td></tr>
        <tr class="tot"><td>${data.netDue >= data.creditReportable ? 'TVA à payer (4441)' : 'Crédit de TVA à reporter (4449)'}</td><td class="n">${m(data.netDue || data.creditReportable)}</td></tr>
      </tbody></table>
      <h2>Détail des comptes de TVA</h2>
      <table><thead><tr><th>Compte</th><th>Intitulé</th><th class="n">Débit</th><th class="n">Crédit</th></tr></thead><tbody>${rows}</tbody></table>`;
    printDocument(`Déclaration de TVA — ${dossierName}`, `période ${from} au ${to} · édité le ${nowStamp()}`, body);
  };

  return (
    <div className="space-y-6">
      {/* Déclaration TVA */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-zinc-300"><Receipt className="h-4 w-4 text-emerald-400" /> Déclaration de TVA
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="ml-2 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50" />
          </div>
          <div className="flex gap-2">
            <button onClick={exportPdf} disabled={!data} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><Printer className="h-4 w-4" /> PDF</button>
            <button onClick={liquidate} disabled={busy || !data || (data.collectee === 0 && data.deductible === 0)} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />} Générer la liquidation</button>
          </div>
        </div>

        {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div> : !data ? null : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Card label="TVA collectée (443)" value={fmtMoney(data.collectee, currency)} />
              <Card label="TVA déductible (445)" value={fmtMoney(data.deductible, currency)} />
              <div className={cn('rounded-2xl border p-4', data.netDue > 0 ? 'border-amber-500/30 bg-amber-500/10' : 'border-emerald-500/30 bg-emerald-500/10')}>
                <div className="text-sm text-zinc-400">{data.creditReportable > 0 ? 'Crédit de TVA à reporter' : 'TVA à payer (4441)'}</div>
                <div className={cn('mt-2 font-mono text-2xl font-bold', data.netDue > 0 ? 'text-amber-400' : 'text-emerald-400')}>{fmtMoney(data.netDue || data.creditReportable, currency)}</div>
              </div>
            </div>
            {msg && <p className="flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}
            {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

            {data.breakdown.length > 0 && (
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                    <th className="px-4 py-2.5 font-medium">Compte</th><th className="px-4 py-2.5 font-medium">Intitulé</th><th className="px-4 py-2.5 text-right font-medium">Débit</th><th className="px-4 py-2.5 text-right font-medium">Crédit</th>
                  </tr></thead>
                  <tbody className="divide-y divide-white/5 font-mono">
                    {data.breakdown.map((b) => (
                      <tr key={b.account_code} className="hover:bg-white/5">
                        <td className="px-4 py-2 text-zinc-300">{b.account_code}</td>
                        <td className="px-4 py-2 font-sans text-zinc-400">{b.label}</td>
                        <td className="px-4 py-2 text-right text-zinc-300">{b.debit ? fmtMoney(b.debit, currency) : '—'}</td>
                        <td className="px-4 py-2 text-right text-zinc-300">{b.credit ? fmtMoney(b.credit, currency) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {/* DSF — branchement externe à venir */}
      <section className="rounded-2xl border border-dashed border-white/15 bg-white/[0.03] p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-300"><FileText className="h-4 w-4 text-zinc-500" /> DSF / Liasse fiscale</div>
        <p className="mt-2 text-sm text-zinc-500">La production de la DSF sera assurée par branchement au logiciel dédié (intégration à venir). Les données comptables de Nova (balance, états) l'alimenteront.</p>
      </section>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="text-sm text-zinc-400">{label}</div>
      <div className="mt-2 font-mono text-2xl font-bold text-zinc-100">{value}</div>
    </div>
  );
}
