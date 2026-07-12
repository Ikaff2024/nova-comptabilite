import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Pencil, Play, BookCheck, Users, ChevronRight, CheckCircle2 } from 'lucide-react';
import { api, fmtMoney, type PayrollEmployee, type Payslip } from '../lib/api';
import { cn } from '../lib/utils';

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const CATEGORIES = ['Ouvrier', 'Employe', 'Agent de Maitrise', 'Cadre'];
const STATUTS = ['Celibataire', 'Marie(e)', 'Divorce(e)', 'Veuf/Veuve'];
const inputCls = 'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';

const emptyForm = (): Partial<PayrollEmployee> => ({
  matricule: '', nom: '', prenoms: '', poste: '', categorie: 'Employe', statutMatrimonial: 'Celibataire',
  nombreEnfants: 0, nombrePartsIGR: 1, dateEmbauche: new Date().toISOString().slice(0, 10),
  salaireBase: 0, sursalaire: 0, indemniteTransport: 0, indemniteLogement: 0, autresPrimes: 0,
});

export default function Paie({ dossierId, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const m = (n: number) => fmtMoney(n, currency);
  const [employees, setEmployees] = useState<PayrollEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth());
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Formulaire salarié
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<PayrollEmployee>>(emptyForm());
  const setF = (p: Partial<PayrollEmployee>) => setForm((f) => ({ ...f, ...p }));

  const loadEmployees = async () => { setLoading(true); try { setEmployees(await api.payrollEmployees(dossierId)); } finally { setLoading(false); } };
  const loadPayslips = async () => { try { setPayslips(await api.payrollPayslips(dossierId, year, month)); } catch { setPayslips([]); } };
  useEffect(() => { loadEmployees(); }, [dossierId]);
  useEffect(() => { loadPayslips(); }, [dossierId, year, month]);

  const submitEmployee = async () => {
    setBusy('emp'); setError(null);
    try {
      const body = { ...form, nombreEnfants: Number(form.nombreEnfants) || 0, nombrePartsIGR: Number(form.nombrePartsIGR) || 1,
        salaireBase: Number(form.salaireBase) || 0, sursalaire: Number(form.sursalaire) || 0,
        indemniteTransport: Number(form.indemniteTransport) || 0, indemniteLogement: Number(form.indemniteLogement) || 0, autresPrimes: Number(form.autresPrimes) || 0 };
      if (editingId) await api.updatePayrollEmployee(dossierId, editingId, body);
      else await api.createPayrollEmployee(dossierId, body);
      setShowForm(false); setEditingId(null); setForm(emptyForm()); await loadEmployees();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const editEmployee = (e: PayrollEmployee) => { setEditingId(e.id); setForm({ ...e }); setShowForm(true); };
  const removeEmployee = async (id: string) => { if (!confirm('Supprimer ce salarié ?')) return; setError(null); try { await api.deletePayrollEmployee(dossierId, id); await loadEmployees(); await loadPayslips(); } catch (e: any) { setError(e.message); } };

  const run = async () => { setBusy('run'); setError(null); try { await api.runPayroll(dossierId, year, month); await loadPayslips(); } catch (e: any) { setError(e.message); } finally { setBusy(null); } };
  const post = async () => {
    if (!confirm(`Comptabiliser l'OD de paie de ${MONTHS[month]} ${year} ? (écriture immuable)`)) return;
    setBusy('post'); setError(null);
    try { await api.postPayroll(dossierId, year, month); await loadPayslips(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const totals = payslips.reduce((a, p) => ({ brut: a.brut + p.brut, net: a.net + p.net, cout: a.cout + p.cout }), { brut: 0, net: 0, cout: 0 });
  const comptabilise = payslips.length > 0 && payslips.every((p) => p.comptabilise);
  const activeCount = employees.filter((e) => e.actif).length;

  return (
    <div className="space-y-6">
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {/* --- Paie du mois --- */}
      <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-display text-lg font-semibold text-zinc-100"><Users className="h-5 w-5 text-emerald-400" /> Paie</div>
          <div className="flex items-center gap-2">
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={cn(inputCls, 'w-auto')}>{MONTHS.map((mo, i) => <option key={i} value={i}>{mo}</option>)}</select>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className={cn(inputCls, 'w-24 font-mono')} />
            <button onClick={run} disabled={busy === 'run' || activeCount === 0 || comptabilise} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Lancer la paie</button>
          </div>
        </div>

        {payslips.length === 0 ? (
          <p className="text-sm text-zinc-500">{activeCount === 0 ? 'Ajoutez des salariés puis lancez la paie.' : `Aucun bulletin pour ${MONTHS[month]} ${year}. Cliquez « Lancer la paie ».`}</p>
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-white/10">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                  <th className="px-4 py-2.5 font-medium">Salarié</th><th className="px-4 py-2.5 text-right font-medium">Brut</th>
                  <th className="px-4 py-2.5 text-right font-medium">Net à payer</th><th className="px-4 py-2.5 text-right font-medium">Coût employeur</th><th className="px-4 py-2.5"></th>
                </tr></thead>
                <tbody className="divide-y divide-white/5">
                  {payslips.map((p) => (
                    <React.Fragment key={p.id}>
                      <tr onClick={() => setExpanded(expanded === p.id ? null : p.id)} className="cursor-pointer hover:bg-white/5">
                        <td className="px-4 py-2.5 text-zinc-200"><span className="inline-flex items-center gap-1.5"><ChevronRight className={cn('h-3.5 w-3.5 text-zinc-500 transition-transform', expanded === p.id && 'rotate-90')} />{p.nom} {p.prenoms} <span className="font-mono text-xs text-zinc-500">{p.matricule}</span></span></td>
                        <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(p.brut)}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-semibold text-emerald-400">{m(p.net)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{m(p.cout)}</td>
                        <td className="px-4 py-2.5 text-right">{p.comptabilise ? <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> comptabilisé</span> : <span className="text-xs text-zinc-500">brouillon</span>}</td>
                      </tr>
                      {expanded === p.id && <tr className="bg-black/20"><td colSpan={5} className="px-4 py-3"><Bulletin calc={p.calculation} m={m} /></td></tr>}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot className="border-t border-white/10 bg-white/5 font-mono text-sm"><tr>
                  <td className="px-4 py-2.5 font-sans font-semibold text-zinc-200">Total ({payslips.length})</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-zinc-100">{m(totals.brut)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-emerald-400">{m(totals.net)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-zinc-100">{m(totals.cout)}</td><td></td>
                </tr></tfoot>
              </table>
            </div>
            <div className="flex items-center justify-end gap-3">
              {comptabilise ? <span className="flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> OD de paie comptabilisée</span>
                : <button onClick={post} disabled={busy === 'post'} className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">{busy === 'post' ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookCheck className="h-4 w-4" />} Comptabiliser l'OD de paie</button>}
            </div>
          </>
        )}
      </section>

      {/* --- Salariés --- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-zinc-200">Salariés ({employees.length})</div>
          <button onClick={() => { setEditingId(null); setForm(emptyForm()); setShowForm((v) => !v); }} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Salarié</button>
        </div>

        {showForm && (
          <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div><label className="mb-1 block text-xs text-zinc-500">Matricule</label><input value={form.matricule ?? ''} onChange={(e) => setF({ matricule: e.target.value })} className={inputCls} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Nom</label><input value={form.nom ?? ''} onChange={(e) => setF({ nom: e.target.value })} className={inputCls} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Prénoms</label><input value={form.prenoms ?? ''} onChange={(e) => setF({ prenoms: e.target.value })} className={inputCls} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Poste</label><input value={form.poste ?? ''} onChange={(e) => setF({ poste: e.target.value })} className={inputCls} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Catégorie</label><select value={form.categorie} onChange={(e) => setF({ categorie: e.target.value })} className={inputCls}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Statut</label><select value={form.statutMatrimonial} onChange={(e) => setF({ statutMatrimonial: e.target.value })} className={inputCls}>{STATUTS.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Nb enfants</label><input type="number" value={form.nombreEnfants ?? 0} onChange={(e) => setF({ nombreEnfants: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Date d'embauche</label><input type="date" value={form.dateEmbauche ?? ''} onChange={(e) => setF({ dateEmbauche: e.target.value })} className={inputCls} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Salaire de base</label><input type="number" value={form.salaireBase ?? 0} onChange={(e) => setF({ salaireBase: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Sursalaire</label><input type="number" value={form.sursalaire ?? 0} onChange={(e) => setF({ sursalaire: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Ind. transport</label><input type="number" value={form.indemniteTransport ?? 0} onChange={(e) => setF({ indemniteTransport: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
            <div><label className="mb-1 block text-xs text-zinc-500">Ind. logement</label><input type="number" value={form.indemniteLogement ?? 0} onChange={(e) => setF({ indemniteLogement: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
            <div className="sm:col-span-2 lg:col-span-4 flex justify-end gap-2">
              <button onClick={() => { setShowForm(false); setEditingId(null); }} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
              <button onClick={submitEmployee} disabled={busy === 'emp' || !form.matricule || !form.nom || !form.prenoms} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy === 'emp' && <Loader2 className="h-4 w-4 animate-spin" />} {editingId ? 'Enregistrer' : 'Ajouter'}</button>
            </div>
          </div>
        )}

        {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : employees.length === 0 ? <p className="text-sm text-zinc-500">Aucun salarié.</p> : (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                <th className="px-4 py-2.5 font-medium">Matricule</th><th className="px-4 py-2.5 font-medium">Nom & prénoms</th><th className="px-4 py-2.5 font-medium">Poste</th><th className="px-4 py-2.5 font-medium">Catégorie</th><th className="px-4 py-2.5 text-right font-medium">Base</th><th className="px-4 py-2.5"></th>
              </tr></thead>
              <tbody className="divide-y divide-white/5">
                {employees.map((e) => (
                  <tr key={e.id} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 font-mono text-zinc-400">{e.matricule}</td>
                    <td className="px-4 py-2.5 text-zinc-200">{e.nom} {e.prenoms}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{e.poste || '—'}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{e.categorie}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(e.salaireBase)}</td>
                    <td className="px-4 py-2.5"><div className="flex items-center justify-end gap-3"><button onClick={() => editEmployee(e)} className="text-zinc-500 hover:text-emerald-400"><Pencil className="h-4 w-4" /></button><button onClick={() => removeEmployee(e.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// Détail d'un bulletin (composants du PayrollResult).
function Bulletin({ calc, m }: { calc: any; m: (n: number) => string }) {
  if (!calc) return null;
  const Row = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => (
    <div className={cn('flex justify-between', strong && 'font-semibold text-zinc-100')}><span className="text-zinc-400">{label}</span><span className="font-mono">{m(value)}</span></div>
  );
  return (
    <div className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-3">
      <div className="space-y-1">
        <div className="mb-1 text-[11px] uppercase text-zinc-500">Brut</div>
        <Row label="Salaire de base + sursalaire" value={calc.salaireBase + calc.sursalaire} />
        {calc.primeAnciennete > 0 && <Row label={`Ancienneté (${calc.tauxAnciennete}%)`} value={calc.primeAnciennete} />}
        {calc.heuresSupMontant > 0 && <Row label="Heures sup." value={calc.heuresSupMontant} />}
        {calc.indemniteLogement > 0 && <Row label="Logement" value={calc.indemniteLogement} />}
        {calc.transportExonere > 0 && <Row label="Transport (exonéré)" value={calc.transportExonere} />}
        <Row label="Brut total" value={calc.salaireBrutTotal} strong />
      </div>
      <div className="space-y-1">
        <div className="mb-1 text-[11px] uppercase text-zinc-500">Retenues salariales</div>
        <Row label="CNPS (6,3%)" value={calc.cnpsSalarial} />
        <Row label="ITS" value={calc.itsSalarial} />
        <Row label="CN" value={calc.cnSalarial} />
        <Row label="IGR" value={calc.igrSalarial} />
        <Row label="CMU" value={calc.cmuSalarial} />
        <Row label="Total retenues" value={calc.totalRetenuesSalariales} strong />
        <Row label="Net à payer" value={calc.salaireNetPaye} strong />
      </div>
      <div className="space-y-1">
        <div className="mb-1 text-[11px] uppercase text-zinc-500">Charges patronales</div>
        <Row label="CNPS famille" value={calc.cnpsFamille} />
        <Row label="CNPS accident" value={calc.cnpsAccident} />
        <Row label="CNPS retraite" value={calc.cnpsRetraitePatronal} />
        <Row label="Taxe apprentissage" value={calc.taxeApprentissage} />
        <Row label="Formation continue" value={calc.formationContinue} />
        <Row label="Total charges patronales" value={calc.totalChargesPatronales} strong />
        <Row label="Coût employeur" value={calc.totalCoutEmployeur} strong />
      </div>
    </div>
  );
}
