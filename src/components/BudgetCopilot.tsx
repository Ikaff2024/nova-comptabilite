import React, { useEffect, useState } from 'react';
import { Loader2, Sparkles, Wand2, GitCompareArrows, LineChart, CheckCircle2, AlertTriangle, HelpCircle } from 'lucide-react';
import { api, fmtMoney, type GeneratedBudget, type ScenariosReport, type ProvisionalReport } from '../lib/api';
import { cn } from '../lib/utils';

type Sub = 'generer' | 'scenarios' | 'previsionnel';

export default function BudgetCopilot({ dossierId, fy, currency, onApplied }: { dossierId: string; fy: string; currency: string; onApplied: () => void }) {
  const [sub, setSub] = useState<Sub>('generer');
  const m = (n: number) => fmtMoney(n, currency);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-2.5 text-sm text-zinc-300">
        <Sparkles className="h-4 w-4 text-emerald-400" />
        <span><b className="text-zinc-100">Lexa prépare, simule et explique.</b> Vous gardez la décision — rien n'est appliqué sans votre validation.</span>
      </div>
      <div className="inline-flex flex-wrap rounded-xl border border-white/10 bg-white/5 p-0.5 text-sm">
        {([['generer', 'Générer', Wand2], ['scenarios', 'Scénarios', GitCompareArrows], ['previsionnel', 'Prévisionnel', LineChart]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setSub(k)} className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors', sub === k ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {sub === 'generer' && <Generer dossierId={dossierId} fy={fy} m={m} onApplied={onApplied} />}
      {sub === 'scenarios' && <Scenarios dossierId={dossierId} fy={fy} m={m} />}
      {sub === 'previsionnel' && <Previsionnel dossierId={dossierId} fy={fy} m={m} />}
    </div>
  );
}

// --- Phase 2 : génération depuis l'historique --------------------------------
function Generer({ dossierId, fy, m, onApplied }: { dossierId: string; fy: string; m: (n: number) => string; onApplied: () => void }) {
  const [growth, setGrowth] = useState(5);
  const [inflation, setInflation] = useState(3);
  const [data, setData] = useState<GeneratedBudget | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true); setError(null); setMsg(null);
    try { setData(await api.generateBudget(dossierId, fy, growth / 100, inflation / 100)); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  const apply = async () => {
    if (!data) return;
    setApplying(true); setError(null);
    try { const r = await api.applyBudget(dossierId, fy, data.lines.map((l) => ({ accountCode: l.account_code, amount: l.montant }))); setMsg(`${r.applied} ligne(s) appliquée(s) au budget.`); onApplied(); }
    catch (e: any) { setError(e.message); } finally { setApplying(false); }
  };

  const produits = data?.lines.filter((l) => l.classNo === 7) ?? [];
  const charges = data?.lines.filter((l) => l.classNo === 6) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div><label className="mb-1 block text-xs text-zinc-500">Croissance des produits (%)</label><input type="number" value={growth} onChange={(e) => setGrowth(Number(e.target.value))} className="w-28 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
        <div><label className="mb-1 block text-xs text-zinc-500">Inflation des charges (%)</label><input type="number" value={inflation} onChange={(e) => setInflation(Number(e.target.value))} className="w-28 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
        <button onClick={generate} disabled={loading} className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Générer depuis l'historique</button>
      </div>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {msg && <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}

      {data && !data.priorYear && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">Aucun exercice précédent avec des mouvements : impossible de générer depuis l'historique. Saisissez le budget manuellement dans l'onglet « Budget vs réalisé ».</p>
      )}

      {data && data.priorYear && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi label={`Produits projetés (base ${data.priorYear})`} value={m(data.totals.produits)} />
            <Kpi label="Charges projetées" value={m(data.totals.charges)} />
            <Kpi label="Résultat projeté" value={m(data.totals.resultat)} tone={data.totals.resultat >= 0 ? 'pos' : 'neg'} highlight />
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-zinc-200"><HelpCircle className="h-4 w-4 text-emerald-400" /> Questions de Lexa avant de valider</div>
            <ul className="space-y-1 text-sm text-zinc-400">{data.questions.map((q, i) => <li key={i} className="flex gap-2"><span className="text-emerald-400">•</span> {q}</li>)}</ul>
          </div>

          <ProvTable title="Produits" rows={produits} m={m} />
          <ProvTable title="Charges" rows={charges} m={m} />

          <div className="flex items-center gap-3">
            <button onClick={apply} disabled={applying} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Appliquer au budget</button>
            <span className="text-xs text-zinc-500">Écrit ces montants dans le budget de l'exercice (modifiable ensuite ligne à ligne).</span>
          </div>
        </>
      )}
    </div>
  );
}

function ProvTable({ title, rows, m }: { title: string; rows: GeneratedBudget['lines']; m: (n: number) => string }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
      <div className="border-b border-white/10 px-4 py-2.5 text-xs uppercase text-zinc-400">{title}</div>
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-xs uppercase text-zinc-500"><tr className="border-b border-white/10">
          <th className="px-3 py-2 text-left font-medium">Compte</th><th className="px-3 py-2 text-left font-medium">Intitulé</th>
          <th className="px-3 py-2 text-right font-medium">Réalisé N-1</th><th className="px-3 py-2 text-right font-medium">Taux</th><th className="px-3 py-2 text-right font-medium">Budget proposé</th>
        </tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.account_code} className="border-b border-white/5">
            <td className="px-3 py-1.5 font-mono text-xs text-zinc-400">{r.account_code}</td>
            <td className="px-3 py-1.5 text-zinc-300">{r.label}</td>
            <td className="px-3 py-1.5 text-right font-mono text-zinc-400">{m(r.base)}</td>
            <td className="px-3 py-1.5 text-right font-mono text-zinc-500">{r.taux >= 0 ? '+' : ''}{Math.round(r.taux * 1000) / 10}%</td>
            <td className="px-3 py-1.5 text-right font-mono font-semibold text-emerald-300">{m(r.montant)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// --- Phase 3 : scénarios -----------------------------------------------------
function Scenarios({ dossierId, fy, m }: { dossierId: string; fy: string; m: (n: number) => string }) {
  const [data, setData] = useState<ScenariosReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setLoading(true); api.budgetScenarios(dossierId, fy).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [dossierId, fy]);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul des scénarios…</div>;
  if (error) return <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>;
  if (!data) return null;
  if (!data.priorYear) return <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">Aucun historique (exercice précédent) : les scénarios se calculent à partir du réalisé de l'exercice antérieur.</p>;

  const accent: Record<string, string> = { prudent: 'border-sky-500/40', central: 'border-emerald-500/50', ambitieux: 'border-amber-500/40' };
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">Projections depuis le réalisé <b className="text-zinc-300">{data.priorYear}</b> (produits {m(data.base.produits)} · charges {m(data.base.charges)}).</p>
      <div className="grid gap-3 md:grid-cols-3">
        {data.scenarios.map((s) => (
          <div key={s.key} className={cn('rounded-2xl border bg-white/5 p-4', accent[s.key] ?? 'border-white/10')}>
            <div className="flex items-baseline justify-between">
              <div className="font-display text-lg font-semibold text-zinc-100">{s.label}</div>
              <div className="font-mono text-xs text-zinc-500">CA {s.growthProduits >= 0 ? '+' : ''}{Math.round(s.growthProduits * 100)}% · ch. +{Math.round(s.inflationCharges * 100)}%</div>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">{s.hypotheses}</p>
            <div className="mt-3 space-y-1.5 text-sm">
              <Line l="Produits" v={m(s.produits)} />
              <Line l="Charges" v={m(s.charges)} />
              <div className="my-1 border-t border-white/10" />
              <Line l="Résultat" v={m(s.resultat)} strong tone={s.resultat >= 0 ? 'pos' : 'neg'} />
              <Line l="Marge nette" v={s.margeNette != null ? `${s.margeNette}%` : '—'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Phase 4 : prévisionnel + trésorerie + stress ----------------------------
function Previsionnel({ dossierId, fy, m }: { dossierId: string; fy: string; m: (n: number) => string }) {
  const [scenario, setScenario] = useState('central');
  const [stress, setStress] = useState(0);
  const [data, setData] = useState<ProvisionalReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setLoading(true); api.budgetProvisional(dossierId, fy, scenario, stress / 100).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [dossierId, fy, scenario, stress]);

  const cr = data?.compteResultat;
  const ind = data?.indicateurs;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div><label className="mb-1 block text-xs text-zinc-500">Scénario</label>
          <select value={scenario} onChange={(e) => setScenario(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
            <option value="prudent">Prudent</option><option value="central">Central</option><option value="ambitieux">Ambitieux</option>
          </select>
        </div>
        <div><label className="mb-1 block text-xs text-zinc-500">Stress test (%)</label>
          <input type="number" value={stress} onChange={(e) => setStress(Math.max(0, Number(e.target.value)))} className="w-24 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" />
        </div>
        <span className="pb-2 text-xs text-zinc-500">Le stress applique une baisse des produits et une hausse des charges du même taux.</span>
      </div>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {loading || !data ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Projection…</div> : (
        <>
          {ind?.alerte_tresorerie && <p className="flex items-center gap-1.5 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400"><AlertTriangle className="h-4 w-4" /> Alerte : la trésorerie devient négative sur l'année (minimum {m(ind.tresorerie_mini)}).</p>}
          <div className="grid gap-3 sm:grid-cols-4">
            <Kpi label="Résultat prévisionnel" value={m(cr!.resultat)} tone={cr!.resultat >= 0 ? 'pos' : 'neg'} highlight />
            <Kpi label="Marge nette" value={cr!.margeNette != null ? `${cr!.margeNette}%` : '—'} />
            <Kpi label="Trésorerie minimale" value={m(ind!.tresorerie_mini)} tone={ind!.tresorerie_mini < 0 ? 'neg' : undefined} />
            <Kpi label="BFR" value={ind!.bfr != null ? m(ind!.bfr) : '—'} />
          </div>

          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
            <div className="border-b border-white/10 px-4 py-2.5 text-xs uppercase text-zinc-400">Budget de trésorerie mensuel — départ {m(data.tresorerie.position_actuelle)}</div>
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-xs uppercase text-zinc-500"><tr className="border-b border-white/10">
                <th className="px-3 py-2 text-left font-medium">Mois</th><th className="px-3 py-2 text-right font-medium">Encaissements</th><th className="px-3 py-2 text-right font-medium">Décaissements</th><th className="px-3 py-2 text-right font-medium">Solde fin de mois</th>
              </tr></thead>
              <tbody>{data.tresorerie.mensuel.map((t, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="px-3 py-1.5 text-zinc-300">{t.mois}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-emerald-300">{m(t.encaissements)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-rose-300">{m(t.decaissements)}</td>
                  <td className={cn('px-3 py-1.5 text-right font-mono font-semibold', t.solde_fin < 0 ? 'text-rose-400' : 'text-zinc-100')}>{m(t.solde_fin)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="mb-2 text-sm font-medium text-zinc-200">Compte de résultat prévisionnel</div>
              <div className="space-y-1.5 text-sm"><Line l="Produits" v={m(cr!.produits)} /><Line l="Charges" v={m(cr!.charges)} /><div className="my-1 border-t border-white/10" /><Line l="Résultat" v={m(cr!.resultat)} strong tone={cr!.resultat >= 0 ? 'pos' : 'neg'} /></div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="mb-2 text-sm font-medium text-zinc-200">Masses prévisionnelles <span className="text-xs font-normal text-zinc-500">(simplifié)</span></div>
              <div className="space-y-1.5 text-sm">
                <Line l="Capitaux propres actuels" v={m(data.bilanSimplifie.capitaux_propres_actuels)} />
                <Line l="+ Résultat projeté" v={m(data.bilanSimplifie.resultat_projete)} />
                <Line l="= Capitaux propres projetés" v={m(data.bilanSimplifie.capitaux_propres_projetes)} strong />
                <div className="my-1 border-t border-white/10" />
                <Line l="Trésorerie projetée (fin)" v={m(data.bilanSimplifie.tresorerie_projetee_fin)} tone={data.bilanSimplifie.tresorerie_projetee_fin < 0 ? 'neg' : undefined} />
              </div>
            </div>
          </div>
          <p className="text-xs text-zinc-500">Projection à étalement linéaire (hors saisonnalité), à partir du réalisé {data.priorYear ?? 'antérieur'}. Le bilan est présenté en masses simplifiées — à affiner avec les hypothèses détaillées.</p>
        </>
      )}
    </div>
  );
}

// --- petits éléments ---------------------------------------------------------
function Kpi({ label, value, tone, highlight }: { label: string; value: string; tone?: 'pos' | 'neg'; highlight?: boolean }) {
  return (
    <div className={cn('rounded-2xl border p-4', highlight ? 'border-emerald-500/40 bg-emerald-500/[0.07]' : 'border-white/10 bg-white/5')}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cn('mt-1 font-mono text-lg font-bold', tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-100')}>{value}</div>
    </div>
  );
}
function Line({ l, v, strong, tone }: { l: string; v: string; strong?: boolean; tone?: 'pos' | 'neg' }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={cn(strong ? 'font-medium text-zinc-200' : 'text-zinc-400')}>{l}</span>
      <span className={cn('font-mono', strong && 'font-semibold', tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : strong ? 'text-zinc-100' : 'text-zinc-300')}>{v}</span>
    </div>
  );
}
