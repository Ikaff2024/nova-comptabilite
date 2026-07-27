import React, { useEffect, useState } from 'react';
import { Loader2, TrendingUp, Info } from 'lucide-react';
import { api, fmtMoney, type RapportRentabilite } from '../lib/api';
import { cn } from '../lib/utils';

// Rentabilité par activité. L'analytique dit ce qu'une activité a produit et
// dépensé ; elle ne dit pas ce qu'elle a demandé d'investir. Or une activité
// peut afficher une belle marge et n'avoir jamais remboursé sa mise de départ —
// c'est ce rapprochement que cet écran rend visible.

export default function Rentabilite({ dossierId, fiscalYearId, currency }: {
  dossierId: string; fiscalYearId?: string; currency: string;
}) {
  const [r, setR] = useState<RapportRentabilite | null>(null);
  const [loading, setLoading] = useState(true);
  const m = (n: number) => fmtMoney(n, currency);

  useEffect(() => {
    let on = true; setLoading(true);
    api.rentabilite(dossierId, fiscalYearId || undefined)
      .then((d) => { if (on) { setR(d); setLoading(false); } })
      .catch(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [dossierId, fiscalYearId]);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div>;
  if (!r || r.activites.length === 0) {
    return <p className="text-sm text-zinc-500">Aucune activité à analyser. Créez des sections analytiques, affectez-les en saisie, et rattachez-y vos immobilisations.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-zinc-400">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span>
          La marge <b className="text-zinc-300">cumulée</b> couvre toute la vie de l'activité ; l'investissement additionne les
          immobilisations rattachées et les chantiers encore en cours. Le retour rapporte l'une à l'autre — c'est un
          indicateur de gestion, pas un poste comptable.
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium" rowSpan={2}>Activité</th>
              <th className="border-l border-white/10 px-4 py-2 text-center font-medium" colSpan={3}>Exercice</th>
              <th className="border-l border-white/10 px-4 py-2 text-center font-medium" colSpan={1}>Cumulé</th>
              <th className="border-l border-white/10 px-4 py-2 text-center font-medium" colSpan={3}>Investissement</th>
              <th className="border-l border-white/10 px-4 py-2 text-center font-medium" rowSpan={2}>Retour</th>
            </tr>
            <tr>
              <th className="border-l border-white/10 px-4 py-2 text-right font-medium">Produits</th>
              <th className="px-4 py-2 text-right font-medium">Charges</th>
              <th className="px-4 py-2 text-right font-medium">Marge</th>
              <th className="border-l border-white/10 px-4 py-2 text-right font-medium">Marge</th>
              <th className="border-l border-white/10 px-4 py-2 text-right font-medium">Immobilisé</th>
              <th className="px-4 py-2 text-right font-medium">En cours</th>
              <th className="px-4 py-2 text-right font-medium">VNC</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {r.activites.map((a) => (
              <tr key={a.code} className="hover:bg-white/5">
                <td className="px-4 py-2 font-sans">
                  <div className="text-zinc-200">{a.libelle}</div>
                  <div className="text-xs text-zinc-500">{a.code}{a.investissement.nbImmobilisations > 0 && ` · ${a.investissement.nbImmobilisations} immo.`}</div>
                </td>
                <td className="border-l border-white/10 px-4 py-2 text-right text-zinc-300">{a.exercice.produits ? m(a.exercice.produits) : '—'}</td>
                <td className="px-4 py-2 text-right text-zinc-300">{a.exercice.charges ? m(a.exercice.charges) : '—'}</td>
                <td className={cn('px-4 py-2 text-right font-medium', a.exercice.marge >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                  {m(a.exercice.marge)}
                  {a.exercice.tauxMarge != null && <span className="ml-1.5 text-xs text-zinc-500">{a.exercice.tauxMarge} %</span>}
                </td>
                <td className={cn('border-l border-white/10 px-4 py-2 text-right font-medium', a.cumul.marge >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{m(a.cumul.marge)}</td>
                <td className="border-l border-white/10 px-4 py-2 text-right text-zinc-300">{a.investissement.immobilise ? m(a.investissement.immobilise) : '—'}</td>
                <td className="px-4 py-2 text-right text-amber-300/90">{a.investissement.enCours ? m(a.investissement.enCours) : '—'}</td>
                <td className="px-4 py-2 text-right text-zinc-400">{a.investissement.vnc ? m(a.investissement.vnc) : '—'}</td>
                <td className="px-4 py-2 text-right" title={a.retour.commentaire}>
                  {a.retour.ratio == null ? <span className="text-zinc-600">—</span> : (
                    <span className={cn('font-medium', a.retour.ratio >= 100 ? 'text-emerald-400' : a.retour.ratio >= 0 ? 'text-amber-300' : 'text-rose-400')}>
                      {a.retour.ratio} %
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-white/10 bg-white/5 font-mono">
            <tr>
              <td className="px-4 py-3 font-sans font-semibold text-zinc-200">Ensemble</td>
              <td className="border-l border-white/10 px-4 py-3" colSpan={2}></td>
              <td className={cn('px-4 py-3 text-right font-semibold', r.totaux.margeExercice >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{m(r.totaux.margeExercice)}</td>
              <td className={cn('border-l border-white/10 px-4 py-3 text-right font-semibold', r.totaux.margeCumulee >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{m(r.totaux.margeCumulee)}</td>
              <td className="border-l border-white/10 px-4 py-3 text-right font-semibold text-zinc-100">{m(r.totaux.investissement)}</td>
              <td className="px-4 py-3"></td>
              <td className="px-4 py-3 text-right font-semibold text-zinc-100">{m(r.totaux.vnc)}</td>
              <td className="px-4 py-3"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {r.activites.some((a) => a.retour.ratio != null) && (
        <div className="space-y-1 text-xs text-zinc-500">
          {r.activites.filter((a) => a.retour.ratio != null).map((a) => (
            <div key={a.code}><span className="text-zinc-400">{a.libelle}</span> — {a.retour.commentaire}</div>
          ))}
        </div>
      )}

      {r.sansSection && (r.sansSection.produits || r.sansSection.charges) ? (
        <p className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200/90">
          Hors activité : {m(r.sansSection.produits)} de produits et {m(r.sansSection.charges)} de charges ne sont
          ventilés sur aucune section — ils échappent à cette lecture.
        </p>
      ) : null}
    </div>
  );
}
