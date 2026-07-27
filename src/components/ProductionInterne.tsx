import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Hammer, CheckCircle2, Trash2, Calculator, Info } from 'lucide-react';
import { api, fmtMoney, type Wip, type AnalyticSection } from '../lib/api';
import { cn } from '../lib/utils';

// Immobilisations PRODUITES EN INTERNE — un logiciel, un agencement, un bâtiment
// que l'entreprise construit pour elle-même. Les charges engagées ne restent pas
// en charges : elles s'accumulent en compte d'en-cours par le crédit du compte 72
// « Production immobilisée », puis basculent au compte définitif à la mise en
// service, qui ouvre l'amortissement.

const ENCOURS = [
  { code: '2193', libelle: 'Logiciel / site internet', cible: '212' },
  { code: '2191', libelle: 'Frais de développement', cible: '211' },
  { code: '2198', libelle: 'Autres droits incorporels', cible: '218' },
  { code: '2391', libelle: 'Bâtiment en cours', cible: '231' },
  { code: '2392', libelle: 'Installation technique en cours', cible: '232' },
  { code: '2395', libelle: 'Aménagement de bureaux en cours', cible: '235' },
];

export default function ProductionInterne({ dossierId, currency, onChanged }: {
  dossierId: string; currency: string; onChanged: () => void;
}) {
  const [rows, setRows] = useState<Wip[]>([]);
  const [sections, setSections] = useState<AnalyticSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const m = (n: number) => fmtMoney(n, currency);
  const load = async () => {
    setLoading(true);
    try { setRows(await api.wipList(dossierId)); } finally { setLoading(false); }
  };
  useEffect(() => {
    load();
    api.analyticSections(dossierId).then(setSections).catch(() => {});
  }, [dossierId]);

  const supprimer = async (w: Wip) => {
    if (!confirm(`Supprimer le chantier « ${w.label} » ?`)) return;
    setError(null);
    try { await api.wipDelete(dossierId, w.id); await load(); } catch (e: any) { setError(e.message); }
  };

  const enCours = rows.filter((r) => r.statut === 'en_cours');
  const total = enCours.reduce((s, r) => s + r.cumul, 0);

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-display text-base font-semibold text-zinc-100">
            <Hammer className="h-4 w-4 text-emerald-400" /> Produites en interne
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Ce que l'entreprise construit pour elle-même. Les charges engagées deviennent un actif,
            neutralisées par le compte 72 « Production immobilisée ».
          </p>
        </div>
        <div className="flex items-center gap-3">
          {enCours.length > 0 && <span className="font-mono text-sm text-zinc-400">{enCours.length} en cours · {m(total)}</span>}
          <button onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20">
            <Plus className="h-4 w-4" /> Ouvrir un chantier
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {msg && <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{msg}</p>}

      {showForm && (
        <NouveauChantier dossierId={dossierId} sections={sections}
          onDone={async () => { setShowForm(false); await load(); }} onError={setError} />
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">Aucun chantier. Ouvrez-en un pour capitaliser un développement en cours.</p>
      ) : (
        <div className="divide-y divide-white/5 rounded-xl border border-white/10">
          {rows.map((w) => (
            <div key={w.id}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <button onClick={() => setOpen(open === w.id ? null : w.id)} className="flex-1 text-left">
                  <div className="flex items-center gap-2 text-sm text-zinc-200">
                    {w.label}
                    <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                      w.statut === 'en_service' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300')}>
                      {w.statut === 'en_service' ? 'en service' : 'en cours'}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-zinc-500">
                    {w.wipAccountCode} → {w.targetAccountCode}
                    {w.analyticSection && ` · section ${w.analyticSection}`}
                    {` · ${w.nbCapitalisations} capitalisation(s)`}
                  </div>
                </button>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-zinc-200">{m(w.cumul)}</span>
                  {w.statut === 'en_cours' && w.cumul === 0 && (
                    <button onClick={() => supprimer(w)} title="Supprimer" className="text-zinc-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                  )}
                </div>
              </div>
              {open === w.id && w.statut === 'en_cours' && (
                <PanneauChantier dossierId={dossierId} wip={w} currency={currency}
                  onDone={async (t) => { setMsg(t); await load(); onChanged(); }} onError={setError} />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NouveauChantier({ dossierId, sections, onDone, onError }: {
  dossierId: string; sections: AnalyticSection[]; onDone: () => void; onError: (s: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [compte, setCompte] = useState('2193');
  const [cible, setCible] = useState('');
  const [libre, setLibre] = useState(false);
  const [section, setSection] = useState('');
  const [debut, setDebut] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); onError('');
    try {
      await api.wipCreate(dossierId, {
        label: label.trim(), wipAccountCode: compte.trim(),
        targetAccountCode: libre ? cible.trim() : undefined,
        analyticSection: section || undefined, startedOn: debut,
      });
      onDone();
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-white/10 bg-zinc-900/40 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <label className="text-xs text-zinc-400">Libellé
        <input value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="Nova — plateforme comptable"
          className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
      </label>
      {/* Les six natures courantes ne sont qu'un raccourci : tout compte du plan
          du dossier est admis, et sa destination est libre. Une entreprise a ses
          propres subdivisions — on ne lui impose pas les nôtres. */}
      <label className="text-xs text-zinc-400">Nature
        <select value={libre ? 'autre' : compte}
          onChange={(e) => { if (e.target.value === 'autre') { setLibre(true); } else { setLibre(false); setCompte(e.target.value); setCible(''); } }}
          className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
          {ENCOURS.map((x) => <option key={x.code} value={x.code}>{x.libelle} ({x.code} → {x.cible})</option>)}
          <option value="autre">Autre compte…</option>
        </select>
      </label>
      {libre && (
        <>
          <label className="text-xs text-zinc-400">Compte d'en-cours
            <input value={compte} onChange={(e) => setCompte(e.target.value)} required placeholder="2193"
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
          </label>
          <label className="text-xs text-zinc-400">Compte définitif
            <input value={cible} onChange={(e) => setCible(e.target.value)} required placeholder="212"
              title="Compte qui portera l'immobilisation à la mise en service"
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
          </label>
        </>
      )}
      <label className="text-xs text-zinc-400">Section analytique
        <select value={section} onChange={(e) => setSection(e.target.value)}
          title="La section qui porte les charges du chantier : elle servira à proposer le montant à capitaliser."
          className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
          <option value="">— aucune —</option>
          {sections.map((s) => <option key={s.code} value={s.code}>{s.code} · {s.label}</option>)}
        </select>
      </label>
      <label className="text-xs text-zinc-400">Début
        <input type="date" value={debut} onChange={(e) => setDebut(e.target.value)} required
          className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
      </label>
      <div className="sm:col-span-2 lg:col-span-4">
        <button type="submit" disabled={busy}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
          {busy ? 'Création…' : 'Ouvrir le chantier'}
        </button>
      </div>
    </form>
  );
}

function PanneauChantier({ dossierId, wip, currency, onDone, onError }: {
  dossierId: string; wip: Wip; currency: string; onDone: (msg: string) => void; onError: (s: string) => void;
}) {
  const annee = new Date().getFullYear();
  const [from, setFrom] = useState(`${annee}-01-01`);
  const [to, setTo] = useState(`${annee}-12-31`);
  const [couts, setCouts] = useState<{ total: number; parCompte: { compte: string; intitule: string; montant: number }[] } | null>(null);
  const [montant, setMontant] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [duree, setDuree] = useState('3');
  const [busy, setBusy] = useState(false);
  const m = (n: number) => fmtMoney(n, currency);

  const lire = async () => {
    onError(''); setBusy(true);
    try {
      const r = await api.wipCosts(dossierId, wip.id, from, to);
      setCouts(r);
      if (r.total > 0 && !montant) setMontant(String(Math.round(r.total)));
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  const capitaliser = async () => {
    const v = Number(montant);
    if (!(v > 0)) { onError('Montant à capitaliser invalide.'); return; }
    setBusy(true); onError('');
    try {
      const r = await api.wipCapitalize(dossierId, wip.id, { date, montant: v, from, to });
      onDone(`Capitalisation de ${m(r.montant)} comptabilisée (${wip.wipAccountCode} par le crédit du ${wip.productionAccountCode}).`);
      setMontant('');
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  const mettreEnService = async () => {
    const d = Number(duree);
    if (!(d > 0)) { onError("Durée d'utilité invalide."); return; }
    if (!confirm(`Mettre en service « ${wip.label} » pour ${m(wip.cumul)} et amortir sur ${d} ans ?`)) return;
    setBusy(true); onError('');
    try {
      const r = await api.wipCommission(dossierId, wip.id, { date, durationYears: d });
      onDone(`Mise en service : ${m(r.montant)} virés en ${wip.targetAccountCode}. L'amortissement démarre.`);
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4 border-t border-white/5 bg-zinc-900/30 px-4 py-4">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Seule la phase de <b>développement</b> se capitalise — la recherche reste en charges.
          Et l'on ne capitalise que des coûts réellement enregistrés : du temps non rémunéré ne s'immobilise pas.
          La capitalisation augmente le résultat de l'exercice, donc l'impôt ; l'amortissement le rendra ensuite.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-xs text-zinc-400">Période du
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
        </label>
        <label className="text-xs text-zinc-400">au
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
        </label>
        <div className="flex items-end">
          <button onClick={lire} disabled={busy || !wip.analyticSection}
            title={wip.analyticSection ? 'Lire les charges portées par la section sur la période' : 'Aucune section analytique sur ce chantier'}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
            <Calculator className="h-4 w-4" /> Lire les coûts
          </button>
        </div>
      </div>

      {couts && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="mb-2 text-xs text-zinc-400">
            Charges portées par la section <b className="text-zinc-200">{wip.analyticSection}</b> sur la période :
            <span className="ml-2 font-mono text-emerald-400">{m(couts.total)}</span>
          </div>
          <div className="divide-y divide-white/5 text-xs">
            {couts.parCompte.map((x) => (
              <div key={x.compte} className="flex justify-between py-1">
                <span className="text-zinc-400"><span className="font-mono text-zinc-500">{x.compte}</span> {x.intitule}</span>
                <span className="font-mono text-zinc-300">{m(x.montant)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Montant proposé, à ajuster : ne retenez que la quote-part réellement consacrée au développement.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-xs text-zinc-400">Montant à capitaliser
          <input value={montant} onChange={(e) => setMontant(e.target.value)} inputMode="numeric" placeholder="0"
            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
        </label>
        <label className="text-xs text-zinc-400">Date d'écriture
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
        </label>
        <div className="flex items-end">
          <button onClick={capitaliser} disabled={busy}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            Capitaliser
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-white/5 pt-4">
        <label className="text-xs text-zinc-400">Durée d'utilité (ans)
          <input value={duree} onChange={(e) => setDuree(e.target.value)} inputMode="numeric"
            className="mt-1 w-24 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
        </label>
        <button onClick={mettreEnService} disabled={busy || wip.cumul <= 0}
          title={wip.cumul > 0 ? 'Vire l\'en-cours au compte définitif et démarre l\'amortissement' : 'Aucune capitalisation à mettre en service'}
          className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">
          <CheckCircle2 className="h-4 w-4" /> Mettre en service ({m(wip.cumul)})
        </button>
      </div>
    </div>
  );
}
