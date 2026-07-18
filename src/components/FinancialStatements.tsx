import React, { useEffect, useState } from 'react';
import { Loader2, FileText, CheckCircle2, AlertTriangle, Printer } from 'lucide-react';
import { api, downloadAuthed, fmtMoney, type FiscalYear, type FinancialStatements as FS, type ComparativeFS } from '../lib/api';
import { cn } from '../lib/utils';

export default function FinancialStatements({
  dossierId, dossierName, fiscalYears, currency,
}: { dossierId: string; dossierName: string; fiscalYears: FiscalYear[]; currency: string }) {
  const [fy, setFy] = useState(fiscalYears[0]?.id ?? '');
  const [cmp, setCmp] = useState<ComparativeFS | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let on = true; setLoading(true);
    api.financialStatementsComparative(dossierId, fy || undefined).then((d) => { if (on) { setCmp(d); setLoading(false); } });
    return () => { on = false; };
  }, [dossierId, fy]);

  const m = (n: number) => fmtMoney(n, currency);
  const fyLabel = fiscalYears.find((f) => f.id === fy)?.label ?? '';
  const data = cmp?.current ?? null;
  const prev = cmp?.previous ?? null;
  const nLabel = cmp?.currentLabel ?? 'N';
  const n1Label = cmp?.previousLabel ?? null;

  const exportPdf = () => { if (data) printStatements(data, dossierName, fyLabel, currency); };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <FileText className="h-4 w-4" /> États financiers SYSCOHADA
        </div>
        <div className="flex items-center gap-3">
          <select value={fy} onChange={(e) => setFy(e.target.value)}
            className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <button onClick={exportPdf} disabled={!data}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
            <Printer className="h-4 w-4" /> Export PDF
          </button>
          <button onClick={() => downloadAuthed(`/api/dossiers/${dossierId}/etats-comparatifs${fy ? `?fiscalYearId=${fy}` : ''}`, 'etats-comparatifs.pdf')} disabled={!prev}
            title={prev ? 'États comparatifs N vs N-1 (variation)' : 'Aucun exercice précédent à comparer'}
            className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">
            <FileText className="h-4 w-4" /> Comparatif N/N-1
          </button>
          <button onClick={() => downloadAuthed(`/api/dossiers/${dossierId}/tft${fy ? `?fiscalYearId=${fy}` : ''}`, 'tft.pdf')} disabled={!prev}
            title={prev ? 'Tableau de flux de trésorerie (méthode indirecte, simplifié)' : 'Le TFT nécessite un exercice précédent'}
            className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">
            <FileText className="h-4 w-4" /> Flux de trésorerie
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul des états…</div>
      ) : !data ? null : (
        <div className="space-y-6">
          {/* SIG cascade — avec comparatif N‑1 */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-semibold">Soldes intermédiaires de gestion</h3>
              {!n1Label && <span className="text-xs text-zinc-500">Pas d'exercice précédent pour comparer</span>}
            </div>
            <table className="w-full text-sm">
              {n1Label && (
                <thead className="text-xs uppercase text-zinc-500"><tr>
                  <th className="pb-2 text-left font-medium"></th>
                  <th className="pb-2 text-right font-medium">{nLabel}</th>
                  <th className="pb-2 text-right font-medium">{n1Label}</th>
                  <th className="pb-2 text-right font-medium">Var.</th>
                </tr></thead>
              )}
              <tbody className="divide-y divide-white/5">
                {data.incomeStatement.sig.map((s, i) => {
                  const p = prev?.incomeStatement.sig[i]?.amount;
                  const delta = p != null ? s.amount - p : null;
                  return (
                    <tr key={i} className={cn(s.strong && 'bg-white/[0.03]')}>
                      <td className={cn('py-2 pr-2', s.strong ? 'font-semibold text-zinc-100' : 'text-zinc-400')}>{s.label}</td>
                      <td className={cn('py-2 text-right font-mono', s.strong ? 'font-semibold text-emerald-400' : 'text-zinc-300')}>{m(s.amount)}</td>
                      {n1Label && <td className="py-2 text-right font-mono text-zinc-500">{p != null ? m(p) : '—'}</td>}
                      {n1Label && <td className={cn('py-2 text-right font-mono text-xs', delta == null ? 'text-zinc-600' : delta >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80')}>{delta == null ? '—' : `${delta >= 0 ? '+' : ''}${m(delta)}`}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Compte de résultat */}
            <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <h3 className="mb-4 font-display text-lg font-semibold">Compte de résultat (par nature)</h3>
              <Block title="Produits" rows={data.incomeStatement.produits.map((p) => ({ label: `${p.group} · ${p.label}`, amount: p.amount }))} total={data.incomeStatement.totalProduits} m={m} accent="emerald" />
              <Block title="Charges" rows={data.incomeStatement.charges.map((p) => ({ label: `${p.group} · ${p.label}`, amount: p.amount }))} total={data.incomeStatement.totalCharges} m={m} accent="rose" />
              <div className={cn('mt-4 flex items-center justify-between rounded-xl border px-4 py-3',
                data.incomeStatement.resultatNet >= 0 ? 'border-emerald-500/20 bg-emerald-500/10' : 'border-rose-500/20 bg-rose-500/10')}>
                <span className="font-semibold">Résultat net {data.incomeStatement.resultatNet >= 0 ? '(bénéfice)' : '(perte)'}</span>
                <span className="flex items-baseline gap-3">
                  {n1Label && prev && <span className="font-mono text-xs text-zinc-500">{n1Label} : {m(prev.incomeStatement.resultatNet)}</span>}
                  <span className={cn('font-mono font-semibold', data.incomeStatement.resultatNet >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{m(data.incomeStatement.resultatNet)}</span>
                </span>
              </div>
            </section>

            {/* Bilan */}
            <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-display text-lg font-semibold">Bilan</h3>
                {data.balanceSheet.equilibre
                  ? <span className="flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Actif = Passif</span>
                  : <span className="flex items-center gap-1.5 text-xs text-rose-400"><AlertTriangle className="h-3.5 w-3.5" /> déséquilibre</span>}
              </div>
              <Block title="Actif" rows={data.balanceSheet.actif} total={data.balanceSheet.totalActif} m={m} accent="zinc" />
              <Block title="Passif" rows={data.balanceSheet.passif} total={data.balanceSheet.totalPassif} m={m} accent="zinc" />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function Block({ title, rows, total, m, accent }: {
  title: string; rows: { label: string; amount: number }[]; total: number;
  m: (n: number) => string; accent: 'emerald' | 'rose' | 'zinc';
}) {
  const totalColor = accent === 'emerald' ? 'text-emerald-400' : accent === 'rose' ? 'text-rose-400' : 'text-zinc-100';
  return (
    <div className="mb-5">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</div>
      <div className="divide-y divide-white/5">
        {rows.length === 0 ? <div className="py-2 text-sm text-zinc-600">—</div> : rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 text-sm">
            <span className="text-zinc-400">{r.label}</span>
            <span className="font-mono text-zinc-200">{m(r.amount)}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 text-sm">
        <span className="font-medium text-zinc-300">Total {title.toLowerCase()}</span>
        <span className={cn('font-mono font-semibold', totalColor)}>{m(total)}</span>
      </div>
    </div>
  );
}

// --- Export PDF : ouvre une fenêtre imprimable (document clair, sans dépendance) ---
function printStatements(data: FS, dossierName: string, fyLabel: string, currency: string) {
  const m = (n: number) => fmtMoney(n, currency);
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const rows = (arr: { label: string; amount: number }[]) =>
    arr.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${m(r.amount)}</td></tr>`).join('');
  const sigRows = data.incomeStatement.sig.map((s) =>
    `<tr class="${s.strong ? 'strong' : ''}"><td>${esc(s.label)}</td><td class="n">${m(s.amount)}</td></tr>`).join('');
  const is = data.incomeStatement, bs = data.balanceSheet;
  const today = new Date().toLocaleDateString('fr-FR');

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>États financiers — ${esc(dossierName)}</title>
  <style>
    *{font-family:Arial,Helvetica,sans-serif;color:#111}
    body{margin:32px;font-size:12px}
    h1{font-size:18px;margin:0 0 2px} h2{font-size:13px;margin:24px 0 6px;border-bottom:2px solid #111;padding-bottom:3px}
    .sub{color:#555;margin-bottom:4px}
    table{width:100%;border-collapse:collapse;margin-bottom:8px}
    td{padding:4px 6px;border-bottom:1px solid #ddd}
    td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    tr.strong td{font-weight:bold;background:#f3f3f3}
    .tot td{font-weight:bold;border-top:2px solid #111;border-bottom:none}
    .cols{display:flex;gap:32px} .col{flex:1}
    @media print{body{margin:12mm}}
  </style></head><body>
    <h1>${esc(dossierName)}</h1>
    <div class="sub">États financiers SYSCOHADA — ${esc(fyLabel)} · devise ${currency} · édité le ${today}</div>

    <h2>Soldes intermédiaires de gestion</h2>
    <table>${sigRows}</table>

    <div class="cols">
      <div class="col">
        <h2>Compte de résultat — Produits</h2>
        <table>${rows(is.produits.map((p) => ({ label: `${p.group} · ${p.label}`, amount: p.amount })))}
          <tr class="tot"><td>Total produits</td><td class="n">${m(is.totalProduits)}</td></tr></table>
        <h2>Compte de résultat — Charges</h2>
        <table>${rows(is.charges.map((p) => ({ label: `${p.group} · ${p.label}`, amount: p.amount })))}
          <tr class="tot"><td>Total charges</td><td class="n">${m(is.totalCharges)}</td></tr>
          <tr class="tot"><td>Résultat net</td><td class="n">${m(is.resultatNet)}</td></tr></table>
      </div>
      <div class="col">
        <h2>Bilan — Actif</h2>
        <table>${rows(bs.actif)}<tr class="tot"><td>Total actif</td><td class="n">${m(bs.totalActif)}</td></tr></table>
        <h2>Bilan — Passif</h2>
        <table>${rows(bs.passif)}<tr class="tot"><td>Total passif</td><td class="n">${m(bs.totalPassif)}</td></tr></table>
      </div>
    </div>
    <p style="color:#888;margin-top:24px;font-size:10px">Généré par Nova Comptabilité — états SYSCOHADA (présentation simplifiée).</p>
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
