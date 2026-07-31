import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Trash2, Calculator, Info, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, fmtMoney, type PayrollEmployee, type ElementVariable, type AnalysePointage, type CaVendeur } from '../lib/api';
import { cn } from '../lib/utils';

// Rémunération variable et import du pointage.
//
// Le principe tenu par tout l'écran : la BASE fait foi, le montant en dérive.
// Une prime de 210 000 ne veut rien dire ; « 3 % de 7 000 000 facturés sur
// 8 factures » se défend devant le salarié, devant l'inspecteur du travail, et
// se recalcule six mois plus tard.

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const MODELE_POINTAGE = `Matricule;Date;Heures jour;Heures nuit;Férié
E001;2026-06-01;8;0;non
E001;2026-06-02;8;2;non
E002;01/06/2026;10;0;oui`;

export default function PaieVariable({ dossierId, employees, year, month, currency, onChanged }: {
  dossierId: string; employees: PayrollEmployee[]; year: number; month: number; currency: string; onChanged: () => void;
}) {
  const [elements, setElements] = useState<ElementVariable[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const m = (n: number) => fmtMoney(n, currency);

  const load = async () => {
    try { setElements(await api.elementsVariables(dossierId, year, month)); } catch { /* ignore */ }
  };
  useEffect(() => { load(); }, [dossierId, year, month]);

  const supprimer = async (e: ElementVariable) => {
    if (!confirm(`Supprimer « ${e.libelle} » (${m(e.montant)}) ?`)) return;
    setError(null);
    try { await api.supprimerElementVariable(dossierId, e.id); await load(); onChanged(); }
    catch (err: any) { setError(err.message); }
  };

  const total = elements.reduce((s, e) => s + e.montant, 0);

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-base font-semibold text-zinc-100">Rémunération variable — {MOIS[month]} {year}</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Tâches et commissions. Le montant est calculé depuis sa base, et la base s'imprime sur le bulletin.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {elements.length > 0 && <span className="font-mono text-sm text-zinc-300">{elements.length} élément(s) · {m(total)}</span>}
          <button onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20">
            <Plus className="h-4 w-4" /> Ajouter
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      {msg && <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}

      {showForm && (
        <FormElement dossierId={dossierId} employees={employees} year={year} month={month} currency={currency}
          onDone={async (t) => { setMsg(t); setShowForm(false); await load(); onChanged(); }} onError={setError} />
      )}

      {elements.length === 0 ? (
        <p className="text-sm text-zinc-500">Aucun élément variable ce mois-ci.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-3 py-2 font-medium">Salarié</th>
              <th className="px-3 py-2 font-medium">Nature</th>
              <th className="px-3 py-2 font-medium">Libellé</th>
              <th className="px-3 py-2 font-medium">Base de calcul</th>
              <th className="px-3 py-2 text-right font-medium">Montant</th>
              <th className="px-3 py-2"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {elements.map((e) => (
                <tr key={e.id} className="hover:bg-white/5">
                  <td className="px-3 py-2 text-zinc-200">{e.salarie}<span className="ml-2 font-mono text-xs text-zinc-500">{e.matricule}</span></td>
                  <td className="px-3 py-2">
                    <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                      e.type === 'commission' ? 'bg-sky-500/15 text-sky-300' : 'bg-amber-500/15 text-amber-300')}>
                      {e.type === 'commission' ? 'Commission' : 'Tâche'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{e.libelle}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                    {e.justification}
                    {e.type === 'commission' && e.periodeDebut && (
                      <span className="ml-2 text-zinc-600">{e.periodeDebut} → {e.periodeFin} · CA {e.baseCa === 'encaisse' ? 'encaissé' : 'facturé'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-100">{m(e.montant)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => supprimer(e)} title="Supprimer" className="text-zinc-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {elements.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-zinc-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Ces montants s'ajouteront au brut au prochain lancement de la paie — ils entrent donc dans les cotisations et l'impôt.
          Ils s'ajoutent à une éventuelle prime saisie à la main, ils ne la remplacent pas.
        </p>
      )}
    </section>
  );
}

// --- Import du pointage ------------------------------------------------------

export function ImportPointage({ dossierId, onDone, onError }: {
  dossierId: string; onDone: (msg: string) => void; onError: (s: string) => void;
}) {
  const [csv, setCsv] = useState('');
  const [analyse, setAnalyse] = useState<AnalysePointage | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const lire = (f: File) => {
    const r = new FileReader();
    r.onload = () => { setCsv(String(r.result ?? '')); setAnalyse(null); };
    r.readAsText(f);
  };

  const analyser = async () => {
    setBusy(true); onError('');
    try { setAnalyse(await api.analyserPointage(dossierId, csv)); }
    catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  const valider = async () => {
    setBusy(true); onError('');
    try {
      const r = await api.importerPointage(dossierId, csv);
      onDone(`${r.importees} pointage(s) enregistré(s)${r.remplacees ? `, dont ${r.remplacees} en remplacement` : ''}${r.rejetees ? ` — ${r.rejetees} ligne(s) écartée(s)` : ''}.`);
      setCsv(''); setAnalyse(null);
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  const rejets = analyse?.lignes.filter((l) => l.erreur) ?? [];

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-zinc-300">
          Pointage du mois — un fichier au lieu de quatre cents saisies.
          <span className="ml-1 text-xs text-zinc-500">Matricule ; Date ; Heures jour ; Heures nuit ; Férié</span>
        </div>
        <div className="flex gap-3">
          <button onClick={() => fileRef.current?.click()} className="text-xs text-zinc-400 hover:text-emerald-400">Choisir un fichier</button>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && lire(e.target.files[0])} />
          <button onClick={() => { setCsv(MODELE_POINTAGE); setAnalyse(null); }} className="text-xs text-zinc-400 hover:text-emerald-400">Voir le modèle</button>
        </div>
      </div>

      <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setAnalyse(null); }} rows={5} placeholder={MODELE_POINTAGE}
        className="w-full rounded-xl border border-white/10 bg-zinc-900/60 p-3 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={analyser} disabled={busy || !csv.trim()}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />} Analyser
        </button>
        {analyse && analyse.valides > 0 && (
          <button onClick={valider} disabled={busy}
            className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">
            Enregistrer {analyse.valides} pointage(s)
          </button>
        )}
      </div>

      {analyse && (
        <div className="space-y-2 text-xs">
          <div className="text-zinc-400">
            {analyse.valides} ligne(s) valide(s) · {analyse.totalHeures} h
            {analyse.periode && ` · du ${analyse.periode.debut} au ${analyse.periode.fin}`}
            {analyse.remplacees > 0 && (
              <span className="ml-2 text-amber-300">{analyse.remplacees} remplaceront un pointage existant</span>
            )}
          </div>
          {rejets.length > 0 && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5" /> {rejets.length} ligne(s) écartée(s) — les autres seront enregistrées
              </div>
              <ul className="space-y-0.5 text-amber-200/80">
                {rejets.slice(0, 8).map((l) => (
                  <li key={l.ligne}>ligne {l.ligne} · {l.matricule || '(sans matricule)'} — {l.erreur}</li>
                ))}
                {rejets.length > 8 && <li>… et {rejets.length - 8} autre(s)</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Ajout d'un élément variable --------------------------------------------

function FormElement({ dossierId, employees, year, month, currency, onDone, onError }: {
  dossierId: string; employees: PayrollEmployee[]; year: number; month: number; currency: string;
  onDone: (msg: string) => void; onError: (s: string) => void;
}) {
  const [type, setType] = useState<'tache' | 'commission'>('tache');
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const [libelle, setLibelle] = useState('');
  const [quantite, setQuantite] = useState('');
  const [prixUnitaire, setPrixUnitaire] = useState('');
  const [taux, setTaux] = useState('3');
  const [baseCa, setBaseCa] = useState<'facture' | 'encaisse'>('facture');
  const dernierJour = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const [debut, setDebut] = useState(`${year}-${String(month + 1).padStart(2, '0')}-01`);
  const [fin, setFin] = useState(`${year}-${String(month + 1).padStart(2, '0')}-${dernierJour}`);
  const [ca, setCa] = useState<CaVendeur | null>(null);
  const [busy, setBusy] = useState(false);
  const m = (n: number) => fmtMoney(n, currency);

  const apercu = type === 'tache'
    ? (Number(quantite) || 0) * (Number(prixUnitaire) || 0)
    : ((ca?.total ?? 0) * (Number(taux) || 0)) / 100;

  const lireCa = async () => {
    setBusy(true); onError('');
    try { setCa(await api.caVendeur(dossierId, employeeId, debut, fin, baseCa)); }
    catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault(); setBusy(true); onError('');
    try {
      const r = await api.ajouterElementVariable(dossierId, {
        employeeId, annee: year, mois: month, type, libelle: libelle.trim(),
        ...(type === 'tache'
          ? { quantite: Number(quantite), prixUnitaire: Number(prixUnitaire) }
          : { taux: Number(taux), baseCa, periodeDebut: debut, periodeFin: fin }),
      });
      onDone(type === 'tache'
        ? `Tâche enregistrée : ${m(r.montant)}.`
        : `Commission enregistrée : ${Number(taux)} % de ${m(r.assiette ?? 0)} = ${m(r.montant)}.`);
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/40 p-4">
      <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-sm">
        {([['tache', 'À la tâche'], ['commission', 'Commission sur le CA']] as const).map(([v, l]) => (
          <button key={v} type="button" onClick={() => { setType(v); setCa(null); }}
            className={cn('rounded-md px-3 py-1 font-medium transition-colors', type === v ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
            {l}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-zinc-400">Salarié
          <select value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setCa(null); }}
            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
            {employees.map((e) => <option key={e.id} value={e.id}>{e.matricule} · {e.nom} {e.prenoms}</option>)}
          </select>
        </label>
        <label className="text-xs text-zinc-400 sm:col-span-2">Libellé
          <input value={libelle} onChange={(e) => setLibelle(e.target.value)} required
            placeholder={type === 'tache' ? 'Sacs cousus' : 'Commission juin'}
            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
        </label>

        {type === 'tache' ? (
          <>
            <label className="text-xs text-zinc-400">Quantité
              <input value={quantite} onChange={(e) => setQuantite(e.target.value)} inputMode="decimal" required placeholder="240"
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
            </label>
            <label className="text-xs text-zinc-400">Prix unitaire
              <input value={prixUnitaire} onChange={(e) => setPrixUnitaire(e.target.value)} inputMode="decimal" required placeholder="350"
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
            </label>
          </>
        ) : (
          <>
            <label className="text-xs text-zinc-400">Taux (%)
              <input value={taux} onChange={(e) => setTaux(e.target.value)} inputMode="decimal" required
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
            </label>
            <label className="text-xs text-zinc-400">Assiette
              <select value={baseCa} onChange={(e) => { setBaseCa(e.target.value as any); setCa(null); }}
                title="Le CA encaissé ne commissionne pas les impayés — il protège la trésorerie."
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
                <option value="facture">CA facturé</option>
                <option value="encaisse">CA encaissé</option>
              </select>
            </label>
            <label className="text-xs text-zinc-400">Période du
              <input type="date" value={debut} onChange={(e) => { setDebut(e.target.value); setCa(null); }}
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
            </label>
            <label className="text-xs text-zinc-400">au
              <input type="date" value={fin} onChange={(e) => { setFin(e.target.value); setCa(null); }}
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50" />
            </label>
          </>
        )}
      </div>

      {type === 'commission' && (
        <div className="space-y-2">
          <button type="button" onClick={lireCa} disabled={busy || !employeeId}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />} Lire le chiffre d'affaires
          </button>
          {ca && (
            <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs">
              <div className="mb-1 text-zinc-400">
                CA {ca.base === 'encaisse' ? 'encaissé' : 'facturé'} net des avoirs :
                <span className="ml-2 font-mono text-emerald-400">{m(ca.total)}</span>
                <span className="ml-2 text-zinc-500">sur {ca.factures.length} pièce(s)</span>
              </div>
              <div className="max-h-32 space-y-0.5 overflow-y-auto">
                {ca.factures.map((f) => (
                  <div key={f.id} className="flex justify-between text-zinc-500">
                    <span>{f.date} · {f.numero} {f.client ? `· ${f.client}` : ''}{f.sens === 'avoir' ? ' (avoir)' : ''}</span>
                    <span className={cn('font-mono', f.montant < 0 && 'text-rose-400')}>{m(f.montant)}</span>
                  </div>
                ))}
                {ca.factures.length === 0 && <div className="text-zinc-600">Aucune facture rattachée à ce vendeur sur la période.</div>}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !libelle.trim() || (type === 'commission' && !ca)}
          title={type === 'commission' && !ca ? "Lisez d'abord le chiffre d'affaires : la commission s'appuie dessus" : undefined}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
          Enregistrer
        </button>
        {apercu > 0 && (
          <span className="font-mono text-sm text-zinc-300">
            {type === 'tache' ? `${quantite} × ${prixUnitaire}` : `${taux} % de ${m(ca?.total ?? 0)}`} = <span className="text-emerald-400">{m(apercu)}</span>
          </span>
        )}
      </div>
    </form>
  );
}
