import React, { useEffect, useState } from 'react';
import { Loader2, Wand2, CheckCircle2, Trash2, AlertTriangle, Info, FileClock } from 'lucide-react';
import { api, fmtMoney, type CandidatReclassement, type Brouillon } from '../lib/api';
import { cn } from '../lib/utils';

// Reclassements et brouillons. Deux principes tenus par l'écran :
//   • un reclassement ne corrige pas l'écriture d'origine — le grand livre est
//     immuable — il passe une écriture nouvelle qui déplace le montant ;
//   • rien n'est comptabilisé sans un geste humain. Ce que Lexa ou le bouton
//     « Préparer » produisent sont des BROUILLONS, hors balance et hors états.

const LIBELLE: Record<CandidatReclassement['nature'], string> = {
  fournisseur_debiteur: 'Fournisseur débiteur',
  client_crediteur: 'Client créditeur',
  exercice_errone: 'Mauvais exercice',
  attente_non_solde: "Compte d'attente",
};

export default function Reclassements({ dossierId, fiscalYearId, currency }: {
  dossierId: string; fiscalYearId?: string; currency: string;
}) {
  const [cands, setCands] = useState<CandidatReclassement[] | null>(null);
  const [drafts, setDrafts] = useState<Brouillon[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const m = (n: number) => fmtMoney(n, currency);

  const load = async () => {
    setError(null);
    const [c, b] = await Promise.all([
      api.reclassements(dossierId, fiscalYearId).catch(() => [] as CandidatReclassement[]),
      api.brouillons(dossierId).catch(() => [] as Brouillon[]),
    ]);
    setCands(c); setDrafts(b);
  };
  useEffect(() => { load(); }, [dossierId, fiscalYearId]);

  const preparer = async (x: CandidatReclassement) => {
    setBusy(x.libelle); setError(null); setMsg(null);
    try {
      if (x.nature === 'exercice_errone') {
        const r = await api.reaffecterExercice(dossierId, x.entryIds![0]);
        setMsg(`Écriture contre-passée dans son exercice d'origine et réécrite en brouillon dans « ${r.exercice} ». Les deux exercices bougeront à la validation.`);
      } else {
        const r = await api.preparerReclassement(dossierId, {
          compteSource: x.compteSource!, compteCible: x.compteCible!, montant: x.montant,
          date: new Date().toISOString().slice(0, 10),
          motif: x.libelle, counterpartyId: x.tiers?.id,
        });
        setMsg(`Brouillon préparé : ${m(r.montant)} du ${x.compteSource} vers le ${x.compteCible}, exercice « ${r.exercice} ». À valider ci-dessous.`);
      }
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const valider = async (b: Brouillon) => {
    if (!confirm(`Comptabiliser « ${b.description} » pour ${m(b.montant)} ? L'écriture deviendra immuable.`)) return;
    setBusy(b.id); setError(null); setMsg(null);
    try { await api.validerBrouillon(dossierId, b.id); setMsg('Écriture comptabilisée.'); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const supprimer = async (b: Brouillon) => {
    if (!confirm(`Supprimer le brouillon « ${b.description} » ?`)) return;
    setBusy(b.id); setError(null);
    try { await api.supprimerBrouillon(dossierId, b.id); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const auto = (cands ?? []).filter((x) => x.automatisable);
  const manuels = (cands ?? []).filter((x) => !x.automatisable);

  return (
    <div className="space-y-5">
      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {msg && <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}

      {drafts.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-amber-500/30 bg-amber-500/[0.07]">
          <div className="flex items-center gap-2 border-b border-amber-500/20 px-4 py-3 text-sm font-medium text-amber-200">
            <FileClock className="h-4 w-4" /> {drafts.length} brouillon(s) en attente de validation
            <span className="ml-2 text-xs font-normal text-amber-200/70">hors balance et hors états tant qu'ils ne sont pas validés</span>
          </div>
          <div className="divide-y divide-amber-500/10">
            {drafts.map((b) => (
              <div key={b.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm text-zinc-200">{b.description}</div>
                    <div className="font-mono text-xs text-zinc-500">{b.date} · {b.journal}{b.exercice && ` · ${b.exercice}`}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-zinc-200">{m(b.montant)}</span>
                    <button onClick={() => valider(b)} disabled={busy === b.id}
                      className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
                      {busy === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Valider
                    </button>
                    <button onClick={() => supprimer(b)} disabled={busy === b.id} title="Supprimer le brouillon"
                      className="rounded-lg border border-white/10 px-2 py-1.5 text-zinc-400 hover:bg-white/5 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                <div className="mt-2 space-y-0.5 font-mono text-xs text-zinc-500">
                  {b.lignes.map((l, i) => (
                    <div key={i} className="flex justify-between">
                      <span>{l.compte} {l.intitule}</span>
                      <span>{l.debit ? `D ${m(l.debit)}` : `C ${m(l.credit)}`}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {cands === null ? (
        <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Recherche des reclassements…</div>
      ) : cands.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Aucun reclassement à envisager.</p>
      ) : (
        <>
          {auto.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-zinc-300">Traitement déductible — {auto.length}</h3>
              <div className="divide-y divide-white/5 rounded-2xl border border-white/10 bg-white/5">
                {auto.map((x, i) => (
                  <div key={i} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm text-zinc-200">
                        <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">{LIBELLE[x.nature]}</span>
                        {x.libelle}
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">{x.explication}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm text-zinc-200">{m(x.montant)}</span>
                      <button onClick={() => preparer(x)} disabled={busy === x.libelle}
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
                        {busy === x.libelle ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />} Préparer
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {manuels.length > 0 && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                <AlertTriangle className="h-4 w-4 text-amber-400" /> Demandent un jugement — {manuels.length}
              </h3>
              <div className="divide-y divide-white/5 rounded-2xl border border-white/10 bg-white/5">
                {manuels.map((x, i) => (
                  <div key={i} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm text-zinc-200">
                        <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">{LIBELLE[x.nature]}</span>
                        {x.libelle}
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">{x.explication}</p>
                    </div>
                    <span className="font-mono text-sm text-zinc-400">{m(x.montant)}</span>
                  </div>
                ))}
              </div>
              <p className="flex items-start gap-1.5 text-xs text-zinc-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Aucun bouton ici, et c'est volontaire : le traitement dépend de la nature réelle de l'opération.
                Une proposition automatique serait plausible et pourrait être fausse.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
