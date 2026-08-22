import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, ChevronRight, Info, Printer, FileSpreadsheet } from 'lucide-react';
import { api, fmtMoney, currentFiscalYear, type FiscalYear, type PnlMensuel as Pnl, type DetailPnl } from '../lib/api';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

// Compte de résultat mensualisé — l'écran de revue des arrêtés.
//
// Ce qu'un total annuel ne montre jamais et qu'une grille à douze colonnes
// révèle d'un coup d'œil : un loyer passé onze fois, une prime doublée, un
// chiffre d'affaires qui décroche sans raison. D'où le parti pris d'affichage :
// une case vide sur une ligne par ailleurs régulière doit sauter aux yeux, donc
// le zéro s'écrit « · » et non « 0 ».
//
// Et une anomalie repérée ne vaut que si on peut l'ouvrir : un clic descend au
// détail par compte, puis aux écritures elles-mêmes.

export default function PnlMensuel({ dossierId, dossierName, currency, fiscalYears }: {
  dossierId: string; dossierName: string; currency: string; fiscalYears: FiscalYear[];
}) {
  const [fy, setFy] = useState(currentFiscalYear(fiscalYears)?.id ?? '');
  const [data, setData] = useState<Pnl | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<{ ref: string; mois?: string } | null>(null);
  const [detail, setDetail] = useState<DetailPnl | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const m = (n: number) => fmtMoney(n, currency);

  useEffect(() => {
    setLoading(true); setError(null); setOuvert(null); setDetail(null);
    api.pnlMensuel(dossierId, fy || undefined)
      .then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [dossierId, fy]);

  const descendre = async (ref: string, mois?: string) => {
    if (ouvert && ouvert.ref === ref && ouvert.mois === mois) { setOuvert(null); setDetail(null); return; }
    setOuvert({ ref, mois }); setDetail(null); setDetailLoading(true); setError(null);
    try { setDetail(await api.pnlDetail(dossierId, ref, { mois, fiscalYearId: fy || undefined })); }
    catch (e: any) { setError(e.message); setOuvert(null); }
    finally { setDetailLoading(false); }
  };

  const cls = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-zinc-700');

  const exportCsv = () => {
    if (!data) return;
    const head = ['Réf', 'Poste', ...data.mois.map((x) => x.libelle), 'Total'];
    const rows = data.lignes.map((l) => [l.ref, l.libelle, ...l.mensuel.map((v) => v || ''), l.total]);
    downloadCsv(`resultat-mensuel-${dossierName}`.replace(/\s+/g, '-'), [head, ...rows] as (string | number)[][]);
  };
  const exportPdf = () => {
    if (!data) return;
    const head = `<tr><th>Réf</th><th>Poste</th>${data.mois.map((x) => `<th class="n">${x.libelle}</th>`).join('')}<th class="n">Total</th></tr>`;
    const body = data.lignes.map((l) => {
      const fort = l.nature !== 'poste' ? ' class="tot"' : '';
      return `<tr${fort}><td>${l.ref}</td><td>${l.libelle.replace(/[&<>]/g, '')}</td>`
        + l.mensuel.map((v) => `<td class="n">${v ? m(v) : ''}</td>`).join('')
        + `<td class="n">${m(l.total)}</td></tr>`;
    }).join('');
    printDocument(`Résultat mensualisé — ${dossierName}`,
      `${data.exercice?.label ?? ''} · édité le ${nowStamp()} · devise ${currency}`,
      `<table><thead>${head}</thead><tbody>${body}</tbody></table>`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-base font-semibold text-zinc-100">Résultat mensualisé</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Les mêmes postes que l'état officiel, mois par mois. Cliquez une case pour descendre jusqu'aux écritures.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} disabled={!data}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
            <FileSpreadsheet className="h-4 w-4" /> CSV
          </button>
          <button onClick={exportPdf} disabled={!data}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
            <Printer className="h-4 w-4" /> PDF
          </button>
          <select value={fy} onChange={(e) => setFy(e.target.value)}
            className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
      </div>

      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div>
        : !data ? null : (
        <>
          {/* Contrôle d'articulation : la grille et l'état officiel doivent
              dire la même chose, sinon c'est celle qu'on regarde le plus qui
              gagne — et elle peut avoir tort. */}
          <div className={cn('flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs',
            data.controle.ok ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-300')}>
            {data.controle.ok
              ? <><CheckCircle2 className="h-3.5 w-3.5" /> Le cumul des mois retombe sur le résultat de l'exercice ({m(data.controle.resultatAnnuel)}).</>
              : <><AlertTriangle className="h-3.5 w-3.5" /> Écart de {m(data.controle.ecart)} entre le cumul des mois ({m(data.controle.cumulMensuel)}) et le résultat annuel ({m(data.controle.resultatAnnuel)}).</>}
          </div>

          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full min-w-[64rem] text-right text-xs">
              <thead className="border-b border-white/10 bg-white/5 uppercase text-zinc-400"><tr>
                <th className="sticky left-0 z-10 bg-zinc-900 px-3 py-3 text-left font-medium">Poste</th>
                {data.mois.map((x) => <th key={x.cle} className="px-2 py-3 font-medium">{x.libelle}</th>)}
                <th className="px-3 py-3 font-medium">Total</th>
              </tr></thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {data.lignes.map((l) => {
                  const solde = l.nature !== 'poste';
                  const vide = l.total === 0 && l.mensuel.every((v) => v === 0);
                  if (vide && !solde) return null;
                  return (
                    <React.Fragment key={l.ref}>
                      <tr className={cn(solde ? 'bg-white/[0.04] font-semibold' : 'hover:bg-white/5')}>
                        <td className={cn('sticky left-0 z-10 px-3 py-1.5 text-left font-sans', solde ? 'bg-zinc-900 text-zinc-100' : 'bg-zinc-950 text-zinc-300')}>
                          <span className="mr-2 font-mono text-[10px] text-zinc-600">{l.ref}</span>{l.libelle}
                        </td>
                        {l.mensuel.map((v, i) => (
                          <td key={i}
                            onClick={() => l.detaillable && v !== 0 && descendre(l.ref, data.mois[i].cle)}
                            title={l.detaillable && v !== 0 ? 'Voir les écritures de ce mois' : undefined}
                            className={cn('px-2 py-1.5', cls(v),
                              l.detaillable && v !== 0 && 'cursor-pointer hover:bg-emerald-500/10',
                              ouvert?.ref === l.ref && ouvert?.mois === data.mois[i].cle && 'bg-emerald-500/15')}>
                            {v === 0 ? '·' : m(v)}
                          </td>
                        ))}
                        <td onClick={() => l.detaillable && l.total !== 0 && descendre(l.ref)}
                          title={l.detaillable && l.total !== 0 ? "Voir les écritures de l'exercice" : undefined}
                          className={cn('px-3 py-1.5 font-semibold', cls(l.total),
                            l.detaillable && l.total !== 0 && 'cursor-pointer hover:bg-emerald-500/10',
                            ouvert?.ref === l.ref && !ouvert?.mois && 'bg-emerald-500/15')}>
                          {l.total === 0 ? '·' : m(l.total)}
                          {l.detaillable && l.total !== 0 && <ChevronRight className="ml-1 inline h-3 w-3 text-zinc-600" />}
                        </td>
                      </tr>
                      {ouvert?.ref === l.ref && (
                        <tr className="bg-black/30">
                          <td colSpan={data.mois.length + 2} className="px-3 py-3 text-left">
                            {detailLoading ? <div className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Ouverture…</div>
                              : !detail ? null : <Detail d={detail} m={m} />}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="flex items-start gap-1.5 text-xs text-zinc-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Les charges sont en négatif : tout s'additionne, et un total positif est un bénéfice.
            Un « · » signale un mois sans mouvement — sur une ligne régulière, c'est souvent une écriture oubliée.
          </p>

          {data.comptesNonAffectes.length > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {data.comptesNonAffectes.length} compte(s) de gestion hors des postes du compte de résultat :{' '}
                <span className="font-mono">{data.comptesNonAffectes.map((x) => x.compte).join(', ')}</span>.
                Signalés plutôt que fondus dans un total.
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Detail({ d, m }: { d: DetailPnl; m: (n: number) => string }) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-zinc-200">
        {d.poste.ref} · {d.poste.libelle}
        <span className="ml-2 font-normal text-zinc-500">
          {d.mois ? `mois de ${d.mois}` : "exercice entier"} · {d.lignes.length} écriture(s) · total {m(d.total)}
        </span>
      </div>

      {d.parCompte.length > 1 && (
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase text-zinc-500">Par compte</div>
          {d.parCompte.map((x) => (
            <div key={x.compte} className="flex justify-between gap-3 font-mono text-xs">
              <span className="text-zinc-400"><span className="text-zinc-500">{x.compte}</span> <span className="font-sans">{x.intitule}</span> <span className="text-zinc-600">({x.nb})</span></span>
              <span className={x.montant >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}>{m(x.montant)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="max-h-72 overflow-y-auto rounded-lg border border-white/10">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 border-b border-white/10 bg-zinc-900 uppercase text-zinc-500"><tr>
            <th className="px-2 py-1.5 font-medium">Date</th>
            <th className="px-2 py-1.5 font-medium">Pièce</th>
            <th className="px-2 py-1.5 font-medium">Jrn</th>
            <th className="px-2 py-1.5 font-medium">Compte</th>
            <th className="px-2 py-1.5 font-medium">Libellé</th>
            <th className="px-2 py-1.5 text-right font-medium">Montant</th>
          </tr></thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {d.lignes.map((l, i) => (
              <tr key={`${l.entryId}-${i}`} className="hover:bg-white/5">
                <td className="px-2 py-1 text-zinc-400">{l.date}</td>
                <td className="px-2 py-1 text-zinc-500">{l.pieceRef ?? '—'}</td>
                <td className="px-2 py-1 text-zinc-500">{l.journal}</td>
                <td className="px-2 py-1 text-zinc-400">{l.compte}</td>
                <td className="max-w-[22rem] truncate px-2 py-1 font-sans text-zinc-300" title={l.libelle}>{l.libelle}</td>
                <td className={cn('px-2 py-1 text-right', l.montant >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80')}>{m(l.montant)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
