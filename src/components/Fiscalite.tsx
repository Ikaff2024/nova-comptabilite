import React, { useEffect, useState } from 'react';
import { Loader2, Receipt, FileCheck2, Printer, CheckCircle2, FileText, CalendarClock, Plus, Trash2, Sparkles, Calculator } from 'lucide-react';
import { api, downloadAuthed, fmtMoney, type VatDeclaration, type Obligation, type IsEstimate } from '../lib/api';
import { printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

const PERIOD_LABEL: Record<string, string> = { monthly: 'Mensuel', quarterly: 'Trimestriel', annual: 'Annuel' };

function ObligationsPanel({ dossierId }: { dossierId: string }) {
  const [rows, setRows] = useState<Obligation[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ label: '', periodicity: 'monthly', dueDay: '15', dueMonth: '1' });
  const [error, setError] = useState<string | null>(null);
  const load = async () => { setLoading(true); try { setRows(await api.obligations(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.createObligation(dossierId, { label: form.label.trim(), periodicity: form.periodicity, dueDay: Number(form.dueDay) || 15, dueMonth: form.periodicity === 'annual' ? Number(form.dueMonth) || 1 : null }); setForm({ ...form, label: '' }); await load(); }
    catch (e: any) { setError(e.message); }
  };
  const seed = async () => { setError(null); try { const r = await api.seedObligations(dossierId); if (!r.added) setError('Des obligations existent déjà.'); await load(); } catch (e: any) { setError(e.message); } };
  const remove = async (o: Obligation) => { setError(null); try { await api.deleteObligation(dossierId, o.id); await load(); } catch (e: any) { setError(e.message); } };

  const dueColor = (d: number | null) => d == null ? 'text-zinc-500' : d < 0 ? 'text-rose-400' : d <= 7 ? 'text-amber-400' : 'text-zinc-300';

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-zinc-300"><CalendarClock className="h-4 w-4 text-emerald-400" /> Échéancier des obligations</div>
        {rows.length === 0 && !loading && <button onClick={seed} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Sparkles className="h-4 w-4" /> Charger le modèle Côte d'Ivoire</button>}
      </div>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2 rounded-2xl border border-white/10 bg-white/5 p-3">
        <div className="flex-1 min-w-[10rem]"><label className="mb-1 block text-xs text-zinc-500">Obligation</label><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Déclaration TVA" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-sm outline-none" /></div>
        <div><label className="mb-1 block text-xs text-zinc-500">Périodicité</label><select value={form.periodicity} onChange={(e) => setForm({ ...form, periodicity: e.target.value })} className="rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-sm outline-none"><option value="monthly">Mensuel</option><option value="quarterly">Trimestriel</option><option value="annual">Annuel</option></select></div>
        {form.periodicity === 'annual' && <div><label className="mb-1 block text-xs text-zinc-500">Mois</label><input type="number" min={1} max={12} value={form.dueMonth} onChange={(e) => setForm({ ...form, dueMonth: e.target.value })} className="w-16 rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 font-mono text-sm outline-none" /></div>}
        <div><label className="mb-1 block text-xs text-zinc-500">Jour</label><input type="number" min={1} max={31} value={form.dueDay} onChange={(e) => setForm({ ...form, dueDay: e.target.value })} className="w-16 rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 font-mono text-sm outline-none" /></div>
        <button type="submit" disabled={!form.label.trim()} className="flex h-[34px] items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"><Plus className="h-4 w-4" /> Ajouter</button>
      </form>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        : rows.length === 0 ? <p className="text-sm text-zinc-500">Aucune obligation. Ajoutez-en ou chargez le modèle CI.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-2.5 font-medium">Obligation</th><th className="px-4 py-2.5 font-medium">Périodicité</th>
              <th className="px-4 py-2.5 font-medium">Prochaine échéance</th><th className="px-4 py-2.5 text-right font-medium">Dans</th><th className="px-4 py-2.5"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((o) => (
                <tr key={o.id} className="hover:bg-white/5">
                  <td className="px-4 py-2 text-zinc-200">{o.label}</td>
                  <td className="px-4 py-2 text-zinc-400">{PERIOD_LABEL[o.periodicity] ?? o.periodicity}</td>
                  <td className="px-4 py-2 font-mono text-zinc-300">{o.nextDue ?? '—'}</td>
                  <td className={cn('px-4 py-2 text-right font-mono', dueColor(o.daysLeft))}>{o.daysLeft != null ? `${o.daysLeft} j` : '—'}</td>
                  <td className="px-4 py-2 text-right"><button onClick={() => remove(o)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function IsEstimatePanel({ dossierId, currency }: { dossierId: string; currency: string }) {
  const [est, setEst] = useState<IsEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.isEstimate(dossierId).then((r) => { if (alive) setEst(r); }).catch((e) => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dossierId]);
  const m = (n: number) => fmtMoney(n, currency);
  const pct = (n: number) => `${(n * 100).toFixed(1).replace('.0', '')} %`;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-zinc-300"><Calculator className="h-4 w-4 text-emerald-400" /> Provision fiscale — impôt sur les bénéfices (IS / IMF)</div>
      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Estimation…</div>
        : error ? <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>
        : !est ? null : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card label="Chiffre d'affaires" value={m(est.chiffreAffaires)} />
            <Card label={est.beneficiaire ? 'Résultat (bénéfice)' : 'Résultat (déficit)'} value={m(est.resultatComptable)} />
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-sm text-zinc-400">IS théorique ({pct(est.tauxIS)})</div>
              <div className="mt-2 font-mono text-2xl font-bold text-zinc-100">{m(est.isTheorique)}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-sm text-zinc-400">IMF ({pct(est.tauxIMF)} du CA)</div>
              <div className="mt-2 font-mono text-2xl font-bold text-zinc-100">{m(est.imf)}</div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="flex items-center justify-between text-sm text-zinc-400"><span>Impôt dû (provision)</span><span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">{est.baseRetenue}</span></div>
              <div className="mt-2 font-mono text-2xl font-bold text-amber-400">{m(est.impotDu)}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-sm text-zinc-400">Acompte provisionnel (1/3)</div>
              <div className="mt-2 font-mono text-2xl font-bold text-zinc-100">{m(est.acompteProvisionnel)}</div>
              <div className="mt-1 text-xs text-zinc-500">× 3 (avril · juin · septembre)</div>
            </div>
          </div>
          <p className="text-xs text-zinc-500">{est.note}</p>
        </>
      )}
    </section>
  );
}

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
            <button onClick={() => downloadAuthed(`/api/dossiers/${dossierId}/vat/recap?year=${month.slice(0, 4)}`, `recap-tva-${month.slice(0, 4)}.pdf`)} title="Récapitulatif annuel de TVA (12 mois)" className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20"><Printer className="h-4 w-4" /> Récap annuel</button>
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

      <IsEstimatePanel dossierId={dossierId} currency={currency} />

      <ObligationsPanel dossierId={dossierId} />

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
