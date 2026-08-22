import React, { useEffect, useState } from 'react';
import { Loader2, Sparkles, CheckCircle2, AlertTriangle, Info, Wand2, Plus, Trash2, ArrowRight, Lock } from 'lucide-react';
import { api, fmtMoney, type ModeleActivite, type AxeAcreer, type EtatVentilation, type ApercuVentilation, type SuggestionVentilation, type AnalyticAxe, type AnalyticSection } from '../lib/api';
import { cn } from '../lib/utils';

// Assistant de mise en place analytique — trois étapes.
//
// Le vrai risque d'un module analytique n'est pas d'être long à créer : c'est
// de rester VIDE. On crée les sections, on ne ventile jamais, et six mois plus
// tard le résultat analytique n'existe pas. L'étape 3 est donc la seule qui
// décide de la réussite — c'est pour elle que l'assistant existe.

type Etape = 1 | 2 | 3;

export default function AssistantAnalytique({ dossierId, currency, fiscalYearId, onDone }: {
  dossierId: string; currency: string; fiscalYearId?: string; onDone: () => void;
}) {
  const [etape, setEtape] = useState<Etape>(1);
  const [modeles, setModeles] = useState<ModeleActivite[]>([]);
  const [choisi, setChoisi] = useState<string | null>(null);
  const [axes, setAxes] = useState<AxeAcreer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const m = (n: number) => fmtMoney(n, currency);

  useEffect(() => { api.modelesAnalytiques(dossierId).then(setModeles).catch(() => {}); }, [dossierId]);

  const prendreModele = (cle: string) => {
    const mo = modeles.find((x) => x.cle === cle);
    if (!mo) return;
    setChoisi(cle);
    setAxes(mo.axes.map((a) => ({ code: a.code, label: a.label, sections: [...a.sections] })));
    setEtape(2);
  };

  const creer = async () => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.appliquerModeleAnalytique(dossierId, axes);
      const bouts: string[] = [];
      if (r.axesCrees.length) bouts.push(`${r.axesCrees.length} axe(s)`);
      if (r.sectionsCreees.length) bouts.push(`${r.sectionsCreees.length} section(s)`);
      setMsg(bouts.length
        ? `${bouts.join(' et ')} créé(e)s.${r.principalRenomme ? ` L'axe principal du dossier porte désormais le nom « ${r.principalRenomme} ».` : ''}${r.ignores.length ? ` ${r.ignores.length} élément(s) déjà présent(s) ont été laissés intacts.` : ''}`
        : `Rien à créer : tout existait déjà. ${r.ignores.join(', ')}`);
      onDone();
      setEtape(3);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-sky-500/25 bg-sky-500/[0.04] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-sky-200">
          <Sparkles className="h-4 w-4" /> Mise en place guidée
        </div>
        <div className="flex items-center gap-1 text-xs">
          {([[1, 'Activité'], [2, 'Structure'], [3, "Ventiler l'existant"]] as const).map(([n, l]) => (
            <button key={n} onClick={() => setEtape(n as Etape)} disabled={n > 1 && !choisi}
              className={cn('rounded-md px-2 py-1 transition-colors',
                etape === n ? 'bg-sky-500 font-medium text-zinc-950' : 'text-zinc-400 hover:text-zinc-200 disabled:opacity-30')}>
              {n}. {l}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {msg && <p className="flex items-start gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {msg}</p>}

      {etape === 1 && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">
            Quelle est l'activité de l'entreprise ? Nova propose un découpage courant pour ce métier — vous le modifiez ensuite.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {modeles.map((mo) => (
              <button key={mo.cle} onClick={() => prendreModele(mo.cle)}
                className="rounded-xl border border-white/10 bg-zinc-900/50 p-3 text-left transition-colors hover:border-sky-500/40 hover:bg-sky-500/5">
                <div className="text-sm font-medium text-zinc-100">{mo.label}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{mo.description}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {mo.axes.map((a) => (
                    <span key={a.code} className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-sky-300">{a.label}</span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {etape === 2 && (
        <EtapeStructure axes={axes} setAxes={setAxes} busy={busy} onCreer={creer} onRetour={() => setEtape(1)} />
      )}

      {etape === 3 && (
        <EtapeVentilation dossierId={dossierId} fiscalYearId={fiscalYearId} m={m} onDone={onDone} />
      )}
    </div>
  );
}

// --- Étape 2 : ajuster la structure avant de créer --------------------------

function EtapeStructure({ axes, setAxes, busy, onCreer, onRetour }: {
  axes: AxeAcreer[]; setAxes: (a: AxeAcreer[]) => void; busy: boolean;
  onCreer: () => void; onRetour: () => void;
}) {
  const maj = (i: number, patch: Partial<AxeAcreer>) => setAxes(axes.map((a, k) => (k === i ? { ...a, ...patch } : a)));
  const ajouterSection = (i: number) => maj(i, { sections: [...axes[i].sections, { code: '', label: '' }] });
  const majSection = (i: number, j: number, patch: Partial<{ code: string; label: string }>) =>
    maj(i, { sections: axes[i].sections.map((s, k) => (k === j ? { ...s, ...patch } : s)) });
  const retirerSection = (i: number, j: number) => maj(i, { sections: axes[i].sections.filter((_, k) => k !== j) });

  const pret = axes.every((a) => a.code.trim() && a.label.trim())
    && axes.some((a) => a.sections.some((s) => s.code.trim() && s.label.trim()));

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1.5 text-xs text-zinc-400">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Un <strong>axe</strong> est une façon de découper : par agence, par activité, par chantier.
        Une <strong>section</strong> est une valeur de ce découpage. Nova ne propose que les sections qu'elle peut connaître —
        les noms de vos chantiers ou de vos boutiques, c'est à vous de les écrire.
      </p>

      {axes.map((a, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/40 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-zinc-500">Code de l'axe
              <input value={a.code} onChange={(e) => maj(i, { code: e.target.value.toUpperCase() })}
                className="mt-1 block w-32 rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 font-mono text-sm text-zinc-100 outline-none focus:border-sky-500/50" />
            </label>
            <label className="min-w-[10rem] flex-1 text-xs text-zinc-500">Intitulé
              <input value={a.label} onChange={(e) => maj(i, { label: e.target.value })}
                className="mt-1 block w-full rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500/50" />
            </label>
            {i === 0 && <span className="rounded-md bg-emerald-500/15 px-1.5 py-1 text-[10px] text-emerald-300" title="Renseigné à la saisie, dans l'écriture elle-même">axe principal</span>}
          </div>

          <div className="space-y-1">
            {a.sections.map((s, j) => (
              <div key={j} className="flex items-center gap-2">
                <input value={s.code} onChange={(e) => majSection(i, j, { code: e.target.value.toUpperCase() })} placeholder="CODE"
                  className="w-32 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/50" />
                <input value={s.label} onChange={(e) => majSection(i, j, { label: e.target.value })} placeholder="Intitulé de la section"
                  className="flex-1 rounded-md border border-white/10 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500/50" />
                <button onClick={() => retirerSection(i, j)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            <button onClick={() => ajouterSection(i)} className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300">
              <Plus className="h-3 w-3" /> Ajouter une section
            </button>
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onRetour} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Retour</button>
        <button onClick={onCreer} disabled={busy || !pret}
          title={!pret ? 'Renseignez au moins une section' : undefined}
          className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-sky-400 disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Créer la structure
        </button>
        <span className="text-xs text-zinc-500">Relancer l'assistant plus tard ne créera jamais de doublon.</span>
      </div>
    </div>
  );
}

// --- Étape 3 : ventiler ce qui est déjà comptabilisé ------------------------

function EtapeVentilation({ dossierId, fiscalYearId, m, onDone }: {
  dossierId: string; fiscalYearId?: string; m: (n: number) => string; onDone: () => void;
}) {
  const [axes, setAxes] = useState<AnalyticAxe[]>([]);
  const [axe, setAxe] = useState('');
  const [etat, setEtat] = useState<EtatVentilation | null>(null);
  const [sections, setSections] = useState<AnalyticSection[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionVentilation[]>([]);
  const [section, setSection] = useState('');
  const [comptes, setComptes] = useState('');
  const [apercu, setApercu] = useState<ApercuVentilation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.analyticAxes(dossierId).then((a) => {
      setAxes(a);
      // On propose d'emblée un axe SECONDAIRE : c'est le seul qui se ventile
      // rétroactivement, et présenter l'axe principal ne mènerait qu'à un refus.
      setAxe((a.find((x) => !x.isPrimary) ?? a[0])?.id ?? '');
    }).catch(() => {});
  }, [dossierId]);

  const recharger = async () => {
    if (!axe) return;
    setError(null); setApercu(null);
    try {
      const [e, s] = await Promise.all([
        api.etatVentilation(dossierId, axe, fiscalYearId),
        api.analyticSections(dossierId, axe),
      ]);
      setEtat(e); setSections(s);
      setSection((prev) => (s.some((x) => x.code === prev) ? prev : s[0]?.code ?? ''));
      setSuggestions(e.retroactif ? await api.suggestionsVentilation(dossierId, axe, fiscalYearId) : []);
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { recharger(); }, [axe, dossierId, fiscalYearId]);

  const listeComptes = () => comptes.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

  const chiffrer = async () => {
    setBusy('apercu'); setError(null); setMsg(null);
    try { setApercu(await api.apercuVentilation(dossierId, { axe, section, comptes: listeComptes() }, fiscalYearId)); }
    catch (e: any) { setError(e.message); setApercu(null); } finally { setBusy(null); }
  };

  const appliquer = async (regle: { section: string; comptes: string[] }, libelle: string) => {
    setBusy('appliquer'); setError(null); setMsg(null);
    try {
      const r = await api.appliquerVentilation(dossierId, { axe, ...regle }, fiscalYearId);
      setMsg(`${r.ventilees} ligne(s) ventilée(s) sur « ${libelle} ». Aucune écriture n'a été modifiée.`);
      setApercu(null); setComptes('');
      await recharger(); onDone();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-zinc-500">Axe à ventiler
          <select value={axe} onChange={(e) => setAxe(e.target.value)}
            className="ml-2 rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-sky-500/50">
            {axes.map((a) => <option key={a.id} value={a.id}>{a.label}{a.isPrimary ? ' (principal)' : ''}</option>)}
          </select>
        </label>
      </div>

      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {msg && <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}

      {!etat ? <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Lecture…</div>
        : !etat.retroactif ? (
          <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-200"><Lock className="h-4 w-4" /> Cet axe ne se ventile pas après coup</div>
            <p className="text-xs text-amber-200/80">{etat.message}</p>
            {axes.some((a) => !a.isPrimary) && (
              <button onClick={() => setAxe(axes.find((a) => !a.isPrimary)!.id)}
                className="flex items-center gap-1.5 text-xs text-sky-300 hover:text-sky-200">
                <ArrowRight className="h-3.5 w-3.5" /> Passer à un axe secondaire
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-zinc-900/40 px-3 py-2 text-xs">
              <span className="text-zinc-300"><strong className="font-mono text-zinc-100">{etat.nonVentilees}</strong> ligne(s) non ventilée(s)</span>
              <span className="text-zinc-500">sur {etat.ventilables}</span>
              {etat.nonVentilees > 0 && <span className="text-zinc-500">· {m(etat.montantNonVentile)} en jeu</span>}
              {etat.nonVentilees === 0 && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> tout est ventilé</span>}
              <span className="ml-auto text-emerald-400/70">rétroactif — aucune écriture n'est modifiée</span>
            </div>

            {suggestions.length > 0 && (
              <div className="space-y-1.5 rounded-xl border border-sky-500/25 bg-sky-500/5 p-3">
                <div className="text-xs font-medium text-sky-200">Suggestions tirées de vos propres habitudes</div>
                <p className="text-[11px] text-zinc-400">
                  Nova ne devine pas : elle reprend la section déjà retenue pour ce compte dans ce dossier, et vous dit sur combien de précédents.
                </p>
                {suggestions.map((s) => (
                  <div key={s.compte} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-zinc-400">{s.compte}</span>
                    <span className="flex-1 truncate text-zinc-300">{s.intitule}</span>
                    <span className="text-zinc-500">{s.concernees} ligne(s) → </span>
                    <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">{s.sectionLabel}</span>
                    <span className="text-zinc-600">{s.precedents} précédent(s)</span>
                    <button onClick={() => appliquer({ section: s.section, comptes: [s.compte] }, s.sectionLabel)}
                      disabled={busy !== null}
                      className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-300 hover:bg-sky-500/20 disabled:opacity-40">
                      Appliquer
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/40 p-3">
              <div className="text-xs font-medium text-zinc-200">Ventiler par règle</div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-zinc-500">Comptes
                  <input value={comptes} onChange={(e) => { setComptes(e.target.value); setApercu(null); }} placeholder="706, 7011"
                    title="Un début de numéro suffit : « 706 » prend 706, 7061, 70611…"
                    className="mt-1 block w-56 rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 font-mono text-sm text-zinc-100 outline-none focus:border-sky-500/50" />
                </label>
                <span className="pb-2 text-zinc-600">→</span>
                <label className="text-xs text-zinc-500">Section
                  <select value={section} onChange={(e) => { setSection(e.target.value); setApercu(null); }}
                    className="mt-1 block rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500/50">
                    {sections.map((s) => <option key={s.id} value={s.code}>{s.code} · {s.label}</option>)}
                  </select>
                </label>
                <button onClick={chiffrer} disabled={busy !== null || !listeComptes().length || !section}
                  className="flex h-[34px] items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
                  {busy === 'apercu' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Chiffrer
                </button>
              </div>

              {apercu && (
                <div className="space-y-2 rounded-lg border border-white/10 bg-black/20 p-2 text-xs">
                  {apercu.nb === 0 ? <p className="text-zinc-500">Aucune ligne non ventilée ne correspond à cette règle.</p> : (
                    <>
                      <div className="text-zinc-300">
                        <strong className="font-mono">{apercu.nb}</strong> ligne(s) seront rattachées à « {sections.find((s) => s.code === section)?.label} »
                        <span className="ml-2 text-zinc-500">{m(apercu.montant)}</span>
                      </div>
                      <div className="space-y-0.5">
                        {apercu.exemples.map((e, i) => (
                          <div key={i} className="flex justify-between gap-3 font-mono text-[11px] text-zinc-500">
                            <span>{e.date} · {e.compte} · <span className="font-sans">{e.libelle}</span></span>
                            <span>{m(e.montant)}</span>
                          </div>
                        ))}
                      </div>
                      <button onClick={() => appliquer({ section, comptes: listeComptes() }, sections.find((s) => s.code === section)?.label ?? section)}
                        disabled={busy !== null}
                        className="rounded-lg bg-sky-500 px-3 py-1 text-xs font-semibold text-zinc-950 hover:bg-sky-400 disabled:opacity-40">
                        Ventiler ces {apercu.nb} ligne(s)
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            <p className="flex items-start gap-1.5 text-[11px] text-zinc-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              La ventilation d'un axe secondaire vit hors du grand livre : elle ne touche aucune écriture, aucun solde, aucun état financier.
              Seul le résultat analytique change.
            </p>
          </>
        )}
    </div>
  );
}
