import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, ChevronRight, Info } from 'lucide-react';
import { api, fmtMoney, type NotesImmobilisations, type NoteImmobilisations } from '../lib/api';
import { cn } from '../lib/utils';

// Notes annexes 3A et 3C — mouvements des immobilisations et des amortissements.
//
// Les quatre colonnes sont LUES dans la comptabilité (à-nouveaux d'un côté,
// mouvements de l'exercice de l'autre), jamais déduites d'un écart de soldes.
// Conséquence visible à l'écran : une acquisition et une cession de la même
// année sur le même poste apparaissent toutes les deux, là où un écart de
// soldes n'aurait montré que leur différence.

export default function NotesAnnexes({ dossierId, fiscalYearId, currency }: {
  dossierId: string; fiscalYearId?: string; currency: string;
}) {
  const [data, setData] = useState<NotesImmobilisations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const m = (n: number) => fmtMoney(n, currency);

  useEffect(() => {
    setLoading(true); setError(null);
    api.notesImmobilisations(dossierId, fiscalYearId)
      .then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [dossierId, fiscalYearId]);

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul des notes…</div>;
  if (error) return <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <Note note={data.note3A} m={m} sensLabel={['Augmentations', 'Diminutions']} />
      <Note note={data.note3C} m={m} sensLabel={['Dotations', 'Reprises / sorties']} />

      {/* Rapprochement avec le registre : un contrôle que le grand livre seul
          ne peut pas faire, puisqu'il ignore le détail bien par bien. */}
      <section className={cn('rounded-2xl border p-4',
        data.registre.concordant ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/[0.07]')}>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          {data.registre.concordant
            ? <><CheckCircle2 className="h-4 w-4 text-emerald-400" /><span className="text-emerald-200">Registre et comptabilité concordent</span></>
            : <><AlertTriangle className="h-4 w-4 text-amber-400" /><span className="text-amber-200">Écart entre le registre des immobilisations et la comptabilité</span></>}
        </div>
        <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <Ligne label="Valeur brute — registre" value={m(data.registre.registreBrut)} />
          <Ligne label="Valeur brute — comptabilité" value={m(data.registre.comptaBrut)} />
          <Ligne label="Amortissements — registre" value={m(data.registre.registreAmort)} />
          <Ligne label="Amortissements — comptabilité" value={m(data.registre.comptaAmort)} />
        </div>
        {!data.registre.concordant && (
          <p className="mt-2 text-xs text-amber-200/80">
            Écart brut {m(data.registre.ecartBrut)}, écart amortissements {m(data.registre.ecartAmort)}.
            Une immobilisation comptabilisée sans être inscrite au registre ne sera <strong>jamais amortie</strong> ;
            à l'inverse, un bien au registre absent de la comptabilité fausse la note.
          </p>
        )}
      </section>
    </div>
  );
}

function Ligne({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-400">{label}</span>
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  );
}

function Note({ note, m, sensLabel }: {
  note: NoteImmobilisations; m: (n: number) => string; sensLabel: [string, string];
}) {
  const [ouvert, setOuvert] = useState<string | null>(null);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-200">{note.intitule}</h3>
        {note.articulee
          ? <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> articulée avec le bilan</span>
          : <span className="flex items-center gap-1 text-xs text-rose-400"><AlertTriangle className="h-3.5 w-3.5" /> écart avec le bilan</span>}
      </div>

      {note.lignes.length === 0 ? (
        <p className="text-sm text-zinc-500">Aucune immobilisation sur cet exercice.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full min-w-[42rem] text-right text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-3 py-2.5 text-left font-medium">Poste</th>
              <th className="px-3 py-2.5 font-medium">Ouverture</th>
              <th className="px-3 py-2.5 font-medium">{sensLabel[0]}</th>
              <th className="px-3 py-2.5 font-medium">{sensLabel[1]}</th>
              <th className="px-3 py-2.5 font-medium">Clôture</th>
            </tr></thead>
            <tbody className="divide-y divide-white/5 font-mono">
              {note.lignes.map((l) => (
                <React.Fragment key={l.ref}>
                  <tr onClick={() => setOuvert(ouvert === l.ref ? null : l.ref)} className="cursor-pointer hover:bg-white/5">
                    <td className="px-3 py-2 text-left font-sans text-zinc-200">
                      <span className="inline-flex items-center gap-1.5">
                        <ChevronRight className={cn('h-3.5 w-3.5 text-zinc-500 transition-transform', ouvert === l.ref && 'rotate-90')} />
                        <span className="font-mono text-xs text-zinc-500">{l.ref}</span> {l.libelle}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-zinc-300">{l.ouverture ? m(l.ouverture) : '—'}</td>
                    <td className="px-3 py-2 text-emerald-400/80">{l.augmentations ? m(l.augmentations) : '—'}</td>
                    <td className="px-3 py-2 text-rose-400/80">{l.diminutions ? m(l.diminutions) : '—'}</td>
                    <td className="px-3 py-2 font-medium text-zinc-100">{m(l.cloture)}</td>
                  </tr>
                  {ouvert === l.ref && (
                    <tr className="bg-black/20"><td colSpan={5} className="px-3 py-2">
                      <table className="w-full text-right text-xs">
                        <tbody>
                          {l.comptes.map((x) => (
                            <tr key={x.code} className="border-b border-white/5">
                              <td className="py-1 pr-2 text-left font-mono text-zinc-500">{x.code}</td>
                              <td className="py-1 pr-2 text-left font-sans text-zinc-400">{x.libelle}</td>
                              <td className="py-1 pr-2 text-zinc-400">{x.ouverture ? m(x.ouverture) : '·'}</td>
                              <td className="py-1 pr-2 text-emerald-400/60">{x.augmentations ? m(x.augmentations) : '·'}</td>
                              <td className="py-1 pr-2 text-rose-400/60">{x.diminutions ? m(x.diminutions) : '·'}</td>
                              <td className="py-1 text-zinc-300">{m(x.cloture)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
              <td className="px-3 py-2.5 text-left font-sans font-semibold text-zinc-200">Total</td>
              <td className="px-3 py-2.5 font-semibold text-zinc-100">{m(note.totaux.ouverture)}</td>
              <td className="px-3 py-2.5 font-semibold text-emerald-400">{m(note.totaux.augmentations)}</td>
              <td className="px-3 py-2.5 font-semibold text-rose-400">{m(note.totaux.diminutions)}</td>
              <td className="px-3 py-2.5 font-semibold text-zinc-100">{m(note.totaux.cloture)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}

      {note.comptesNonAffectes.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {note.comptesNonAffectes.length} compte(s) hors des postes du bilan, donc absents du tableau :{' '}
            <span className="font-mono">{note.comptesNonAffectes.map((x) => x.code).join(', ')}</span>.
            Ils sont signalés plutôt que fondus dans un total — leur rattachement dépend d'une lecture à confirmer.
          </span>
        </p>
      )}
    </section>
  );
}
