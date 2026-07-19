import React, { useEffect, useState } from 'react';
import { Loader2, Building2, CheckCircle2, Save } from 'lucide-react';
import { api, type DossierProfile } from '../lib/api';

// Fiche d'identité de l'entreprise : coordonnées, identifiants légaux et
// fiscaux, banque. Ces informations alimentent l'en-tête des bulletins de paie,
// les attestations, les courriers officiels et les déclarations.

const FORMES = ['', 'EI', 'SARL', 'SUARL', 'SA', 'SAS', 'SCI', 'GIE', 'Association'];
const REGIMES: [string, string][] = [
  ['', '— non précisé —'],
  ['reel_normal', 'Réel normal'],
  ['reel_simplifie', 'Réel simplifié'],
  ['synthetique', 'Impôt synthétique'],
];

const input = 'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';

// ⚠️ Défini AU NIVEAU MODULE, jamais dans le corps du composant : sinon React
// voit un nouveau type de composant à chaque rendu, démonte/remonte le champ,
// et l'input perd le focus à chaque caractère saisi.
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div><label className="mb-1 block text-xs text-zinc-500">{label}{hint && <span className="text-zinc-600"> · {hint}</span>}</label>{children}</div>
  );
}

export default function FicheEntreprise({ dossierId, onRenamed }: { dossierId: string; onRenamed?: (name: string) => void }) {
  const [p, setP] = useState<DossierProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let on = true;
    setLoading(true);
    api.dossierProfile(dossierId)
      .then((d) => { if (on) setP(d); })
      .catch((e) => { if (on) setError(e.message); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [dossierId]);

  const set = (patch: Partial<DossierProfile>) => { setP((x) => (x ? { ...x, ...patch } : x)); setSaved(false); };

  const save = async () => {
    if (!p) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const r = await api.updateDossierProfile(dossierId, {
        raisonSociale: p.raisonSociale, adresse: p.adresse, ville: p.ville, telephone: p.telephone,
        taxId: p.taxId, rccm: p.rccm, numeroCnps: p.numeroCnps,
        formeJuridique: p.formeJuridique, regimeFiscal: p.regimeFiscal, bankName: p.bankName, rib: p.rib,
      });
      setP(r.profile); setSaved(true);
      onRenamed?.(r.raison_sociale);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement de la fiche…</div>;
  if (!p) return <p className="text-sm text-rose-400">{error ?? 'Fiche indisponible.'}</p>;

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 font-display text-lg font-semibold text-zinc-100"><Building2 className="h-5 w-5 text-emerald-400" /> Fiche entreprise</div>
        <p className="mt-1 text-sm text-zinc-400">Ces informations apparaissent sur les <strong>bulletins de paie</strong>, les <strong>attestations</strong>, les <strong>courriers</strong> et les <strong>déclarations</strong>. Renseignez-les une fois.</p>
      </div>

      <section className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-sm font-medium text-zinc-200">Identité &amp; coordonnées</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Raison sociale"><input value={p.raisonSociale} onChange={(e) => set({ raisonSociale: e.target.value })} className={input} /></Field>
          <Field label="Forme juridique">
            <select value={p.formeJuridique ?? ''} onChange={(e) => set({ formeJuridique: e.target.value || null })} className={input}>
              {FORMES.map((f) => <option key={f} value={f}>{f || '— non précisée —'}</option>)}
            </select>
          </Field>
          <Field label="Adresse" hint="siège"><input value={p.adresse ?? ''} onChange={(e) => set({ adresse: e.target.value })} placeholder="Ex : Grand-Bassam, Quartier CAFOP II, Lot 1305" className={input} /></Field>
          <Field label="Ville"><input value={p.ville ?? ''} onChange={(e) => set({ ville: e.target.value })} placeholder="Abidjan" className={input} /></Field>
          <Field label="Téléphone"><input value={p.telephone ?? ''} onChange={(e) => set({ telephone: e.target.value })} placeholder="+225 07 00 00 00 00" className={input} /></Field>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-sm font-medium text-zinc-200">Identifiants légaux &amp; fiscaux</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="NCC / IFU" hint="n° contribuable"><input value={p.taxId ?? ''} onChange={(e) => set({ taxId: e.target.value })} placeholder="2404902H" className={input} /></Field>
          <Field label="RCCM" hint="registre du commerce"><input value={p.rccm ?? ''} onChange={(e) => set({ rccm: e.target.value })} className={input} /></Field>
          <Field label="N° employeur CNPS" hint="bulletins & déclarations"><input value={p.numeroCnps ?? ''} onChange={(e) => set({ numeroCnps: e.target.value })} className={input} /></Field>
          <Field label="Régime fiscal">
            <select value={p.regimeFiscal ?? ''} onChange={(e) => set({ regimeFiscal: e.target.value || null })} className={input}>
              {REGIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-sm font-medium text-zinc-200">Banque</div>
        <p className="text-xs text-zinc-500">Utilisée pour l'ordre de virement des salaires et le courrier à la banque.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Banque"><input value={p.bankName ?? ''} onChange={(e) => set({ bankName: e.target.value })} placeholder="Ex : SGBCI" className={input} /></Field>
          <Field label="RIB / N° de compte"><input value={p.rib ?? ''} onChange={(e) => set({ rib: e.target.value })} className={input} /></Field>
        </div>
      </section>

      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Enregistrer
        </button>
        {saved && <span className="flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Fiche enregistrée</span>}
      </div>
    </div>
  );
}
