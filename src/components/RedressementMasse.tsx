import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, CalendarClock, ArrowRightLeft, Info, Wand2, CheckCircle2 } from 'lucide-react';
import { api, fmtMoney, type EcritureMalRattachee, type ChoixRedressement, type ModeRedressement, type ImpactRedressement } from '../lib/api';
import { cn } from '../lib/utils';

// Redressement en masse des écritures mal rattachées.
//
// Le piège que cet écran doit désamorcer : « mal rattachée » ne dit pas
// LAQUELLE des deux données est fausse. Traiter quinze écritures d'un coup en
// supposant que c'est toujours l'exercice, c'est déplacer en bloc des écritures
// correctement rattachées — et changer le résultat de deux exercices sans
// raison. D'où deux traitements distincts, un indice pour orienter, et un
// aperçu chiffré avant de s'engager.

export default function RedressementMasse({ dossierId, currency, onDone }: {
  dossierId: string; currency: string; onDone: () => void;
}) {
  const [rows, setRows] = useState<EcritureMalRattachee[] | null>(null);
  const [choix, setChoix] = useState<Record<string, { mode: ModeRedressement; date: string }>>({});
  const [impact, setImpact] = useState<ImpactRedressement | null>(null);
  const [busy, setBusy] = useState<'impact' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const m = (n: number) => fmtMoney(n, currency);

  const load = async () => {
    setError(null); setImpact(null);
    try {
      const r = await api.malRattachees(dossierId);
      setRows(r);
      // Pré-sélection par l'indice : le défaut proposé est celui que Nova sait
      // défendre. Rien n'est coché — c'est au comptable de choisir.
      //
      // La date pré-remplie vient du LIBELLÉ, pas de la base : celle de la base
      // est justement celle qu'on soupçonne d'être fausse. À défaut de lecture,
      // le champ reste vide plutôt que de proposer l'erreur.
      setChoix(Object.fromEntries(r.map((e) => [e.id, {
        mode: (e.indice === 'date_suspecte' ? 'date' : 'exercice') as ModeRedressement,
        date: e.indice === 'date_suspecte' ? (e.dateProposee ?? '') : e.date,
      }])));
    } catch (e: any) { setError(e.message); setRows([]); }
  };
  useEffect(() => { load(); }, [dossierId]);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const basculer = (id: string) => {
    setImpact(null);
    setSelection((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toutCocher = () => {
    setImpact(null);
    setSelection((s) => (s.size === (rows ?? []).length ? new Set() : new Set((rows ?? []).map((r) => r.id))));
  };

  const construire = (): ChoixRedressement[] => [...selection].map((id) => {
    const c = choix[id];
    return c.mode === 'date'
      ? { entryId: id, mode: 'date' as const, nouvelleDate: c.date }
      : { entryId: id, mode: 'exercice' as const };
  });

  const chiffrer = async () => {
    setBusy('impact'); setError(null); setMsg(null);
    try { setImpact(await api.impactRedressement(dossierId, construire())); }
    catch (e: any) { setError(e.message); setImpact(null); } finally { setBusy(null); }
  };

  const executer = async () => {
    if (!confirm(
      `Redresser ${selection.size} écriture(s) ?\n\n`
      + `Les contre-passations seront COMPTABILISÉES immédiatement dans leur exercice d'origine. `
      + `Les réécritures resteront en brouillon, à valider une par une.`)) return;
    setBusy('run'); setError(null); setMsg(null);
    try {
      const r = await api.redresserEnMasse(dossierId, construire());
      setMsg(`${r.traitees} écriture(s) redressée(s) : ${r.extournes.length} contre-passation(s) comptabilisée(s), ${r.brouillons.length} réécriture(s) en brouillon à valider ci-dessous.`);
      setSelection(new Set()); setImpact(null);
      await load(); onDone();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  if (rows === null) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Recherche des écritures mal rattachées…</div>;
  if (rows.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">
        <CheckCircle2 className="h-4 w-4" /> Aucune écriture mal rattachée : chaque écriture est datée dans les bornes de son exercice.
      </p>
    );
  }

  const pret = selection.size > 0;
  const dates = [...selection].filter((id) => choix[id]?.mode === 'date' && !choix[id]?.date);

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <AlertTriangle className="h-4 w-4 text-amber-400" /> {rows.length} écriture(s) mal rattachée(s)
        </div>
        <button onClick={toutCocher} className="text-xs text-zinc-400 hover:text-emerald-400">
          {selection.size === rows.length ? 'Tout décocher' : 'Tout cocher'}
        </button>
      </div>

      <p className="flex items-start gap-1.5 text-xs text-zinc-500">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Une écriture hors des bornes de son exercice a <strong>deux</strong> explications possibles, et Nova ne peut pas
        trancher à votre place : ou la date est bonne et l'exercice est faux, ou l'exercice est bon et c'est la date
        qui est fausse — le cas des pièces importées, datées du jour de l'import.
        Quand le libellé porte une date exploitable, elle est proposée : <strong>vérifiez-la sur la pièce</strong>,
        elle n'est lue que dans le texte.
      </p>

      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {msg && <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}

      <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10">
        {rows.map((e) => {
          const c = choix[e.id] ?? { mode: 'exercice' as ModeRedressement, date: e.date };
          const coche = selection.has(e.id);
          return (
            <div key={e.id} className={cn('px-3 py-2.5 transition-colors', coche ? 'bg-emerald-500/[0.06]' : 'hover:bg-white/[0.02]')}>
              <div className="flex items-start gap-3">
                <input type="checkbox" checked={coche} onChange={() => basculer(e.id)} className="mt-1 accent-emerald-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-zinc-200">{e.description}</span>
                    <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                      e.indice === 'date_suspecte' ? 'bg-sky-500/15 text-sky-300' : 'bg-amber-500/15 text-amber-300')}>
                      {e.indice === 'date_suspecte' ? 'date suspecte' : 'exercice suspect'}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-zinc-500">
                    {e.date} · {e.journal} · {e.exercice.label} ({e.exercice.debut} → {e.exercice.fin}) · {m(e.montant)}
                    {e.resultat !== 0 && <span className={cn('ml-2', e.resultat > 0 ? 'text-emerald-400/70' : 'text-rose-400/70')}>résultat {m(e.resultat)}</span>}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{e.raison}</p>

                  {coche && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <div className="inline-flex rounded-lg border border-white/10 bg-zinc-900/60 p-0.5 text-xs">
                        <button onClick={() => { setImpact(null); setChoix((p) => ({ ...p, [e.id]: { ...c, mode: 'exercice' } })); }}
                          disabled={!e.exerciceDeLaDate}
                          title={e.exerciceDeLaDate ? `Déplacer vers « ${e.exerciceDeLaDate.label} »` : 'Aucun exercice ne couvre cette date'}
                          className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors',
                            c.mode === 'exercice' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200',
                            !e.exerciceDeLaDate && 'cursor-not-allowed opacity-40')}>
                          <ArrowRightLeft className="h-3 w-3" /> Changer d'exercice
                        </button>
                        <button onClick={() => { setImpact(null); setChoix((p) => ({ ...p, [e.id]: { ...c, mode: 'date' } })); }}
                          className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors',
                            c.mode === 'date' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
                          <CalendarClock className="h-3 w-3" /> Corriger la date
                        </button>
                      </div>

                      {c.mode === 'exercice' ? (
                        <span className="text-xs text-zinc-400">
                          → {e.exerciceDeLaDate ? <span className="text-emerald-400">{e.exerciceDeLaDate.label}</span> : <span className="text-rose-400">aucun exercice ne couvre le {e.date}</span>}
                          <span className="ml-1 text-zinc-600">à date inchangée</span>
                        </span>
                      ) : (
                        <>
                          <input type="date" value={c.date} min={e.exercice.debut} max={e.exercice.fin}
                            onChange={(ev) => { setImpact(null); setChoix((p) => ({ ...p, [e.id]: { ...c, date: ev.target.value } })); }}
                            className="rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />
                          {e.dateProposee && c.date === e.dateProposee && (
                            <span title={`Proposition déterministe : ${e.motifDateProposee}. Vérifiez-la sur la pièce.`}
                              className="rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">{e.motifDateProposee}</span>
                          )}
                          <span className="text-xs text-zinc-600">dans « {e.exercice.label} », qui ne change pas</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {impact && (
        <div className="space-y-2 rounded-xl border border-sky-500/25 bg-sky-500/5 p-3 text-sm">
          <div className="font-medium text-sky-200">Ce que le redressement change</div>
          {impact.parExercice.length === 0
            ? <p className="text-xs text-zinc-400">Aucun résultat d'exercice n'est touché : seules des dates changent.</p>
            : (
              <div className="space-y-1">
                {impact.parExercice.map((x) => (
                  <div key={x.label} className="flex justify-between font-mono text-xs">
                    <span className="font-sans text-zinc-300">Résultat {x.label} <span className="text-zinc-600">({x.nb} écriture{x.nb > 1 ? 's' : ''})</span></span>
                    <span className={cn(x.delta > 0 ? 'text-emerald-400' : x.delta < 0 ? 'text-rose-400' : 'text-zinc-500')}>
                      {x.delta > 0 ? '+' : ''}{m(x.delta)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          {impact.sansEffetSurLeResultat > 0 && (
            <p className="text-xs text-zinc-400">
              {impact.sansEffetSurLeResultat} correction(s) de date : aucun effet sur les résultats, l'écriture reste dans son exercice.
            </p>
          )}
          <p className="text-xs text-amber-200/80">
            À l'exécution, les contre-passations sont <strong>comptabilisées immédiatement</strong> dans leur exercice d'origine ;
            les réécritures restent en brouillon. Entre les deux, ces écritures ne figurent nulle part.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={chiffrer} disabled={!pret || busy !== null || dates.length > 0}
          title={dates.length ? 'Renseignez la date corrigée des lignes concernées' : undefined}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
          {busy === 'impact' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Chiffrer l'impact ({selection.size})
        </button>
        {impact && (
          <button onClick={executer} disabled={busy !== null}
            className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">
            {busy === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Redresser les {impact.total} écritures
          </button>
        )}
        {dates.length > 0 && <span className="text-xs text-amber-300">{dates.length} date(s) corrigée(s) à renseigner.</span>}
      </div>
    </section>
  );
}
