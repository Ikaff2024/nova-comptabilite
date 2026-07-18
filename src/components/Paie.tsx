import React, { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Pencil, Play, BookCheck, Users, ChevronRight, CheckCircle2, Printer, FileText, Banknote, ShieldCheck } from 'lucide-react';
import { api, fmtMoney, downloadAuthed, RUPTURE_LABELS, type PayrollEmployee, type Payslip, type PayrollAbsence, type PayrollAdvance, type PayrollTimeEntry, type RuptureType, type StcResult, type PayrollYear, type ValidationReport } from '../lib/api';
import { printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';
import AqmReportCard from './AqmReportCard';

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const CATEGORIES = ['Ouvrier', 'Employe', 'Agent de Maitrise', 'Cadre'];
const STATUTS = ['Celibataire', 'Marie(e)', 'Divorce(e)', 'Veuf/Veuve'];
const inputCls = 'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';

const emptyForm = (): Partial<PayrollEmployee> => ({
  matricule: '', nom: '', prenoms: '', poste: '', categorie: 'Employe', statutMatrimonial: 'Celibataire',
  nombreEnfants: 0, nombrePartsIGR: 1, dateEmbauche: new Date().toISOString().slice(0, 10),
  salaireBase: 0, sursalaire: 0, indemniteTransport: 0, indemniteLogement: 0, autresPrimes: 0,
});

export default function Paie({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const m = (n: number) => fmtMoney(n, currency);
  const [employees, setEmployees] = useState<PayrollEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth());
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [declReport, setDeclReport] = useState<ValidationReport | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sub, setSub] = useState<'paie' | 'pointage' | 'absences' | 'avances' | 'stc' | 'declarations'>('paie');

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

  const period = `${MONTHS[month]} ${year}`;
  const psum = (f: (c: any) => number) => Math.round(payslips.reduce((s, p) => s + (f(p.calculation) || 0), 0));

  const printBulletin = (p: Payslip) => {
    const emp = employees.find((e) => e.id === p.employeeId);
    const c = p.calculation;
    const row = (l: string, v: number) => `<tr><td>${l}</td><td class="n">${m(v)}</td></tr>`;
    const body = `
      <table style="margin-bottom:12px"><tbody>
        <tr><td><b>Employeur :</b> ${dossierName.replace(/[&<>]/g, '')}</td><td class="n">Bulletin de paie — ${period}</td></tr>
        <tr><td><b>Salarié :</b> ${(p.nom + ' ' + p.prenoms).replace(/[&<>]/g, '')} (${p.matricule})</td><td class="n">${emp?.poste ?? ''} · ${emp?.categorie ?? ''}</td></tr>
      </tbody></table>
      <table><thead><tr><th>Gains</th><th class="n">Montant</th></tr></thead><tbody>
        ${row('Salaire de base + sursalaire', c.salaireBase + c.sursalaire)}
        ${c.primeAnciennete > 0 ? row(`Prime d'ancienneté (${c.tauxAnciennete}%)`, c.primeAnciennete) : ''}
        ${c.heuresSupMontant > 0 ? row('Heures supplémentaires', c.heuresSupMontant) : ''}
        ${c.indemniteLogement > 0 ? row('Indemnité de logement', c.indemniteLogement) : ''}
        ${c.transportExonere > 0 ? row('Indemnité de transport (exonérée)', c.transportExonere) : ''}
        ${c.autresPrimes > 0 ? row('Autres primes', c.autresPrimes) : ''}
        <tr class="tot"><td>Salaire brut</td><td class="n">${m(c.salaireBrutTotal)}</td></tr>
      </tbody></table>
      <table style="margin-top:10px"><thead><tr><th>Retenues salariales</th><th class="n">Montant</th></tr></thead><tbody>
        ${row('CNPS (6,3%)', c.cnpsSalarial)}${row('ITS', c.itsSalarial)}${row('Contribution nationale', c.cnSalarial)}${row('IGR', c.igrSalarial)}${row('CMU', c.cmuSalarial)}
        <tr class="tot"><td>Total retenues</td><td class="n">${m(c.totalRetenuesSalariales)}</td></tr>
        <tr class="tot"><td>NET À PAYER</td><td class="n">${m(c.salaireNetPaye)}</td></tr>
      </tbody></table>
      <table style="margin-top:10px"><thead><tr><th>Charges patronales</th><th class="n">Montant</th></tr></thead><tbody>
        ${row('CNPS prestations familiales', c.cnpsFamille)}${row('CNPS accident du travail', c.cnpsAccident)}${row('CNPS retraite (patronal)', c.cnpsRetraitePatronal)}${row("Taxe d'apprentissage", c.taxeApprentissage)}${row('Formation continue (FDFP)', c.formationContinue)}
        <tr class="tot"><td>Total charges patronales</td><td class="n">${m(c.totalChargesPatronales)}</td></tr>
        <tr class="tot"><td>Coût total employeur</td><td class="n">${m(c.totalCoutEmployeur)}</td></tr>
      </tbody></table>
      <p style="margin-top:10px;font-size:11px">Barèmes : ${c.ruleSetLabel ?? c.ruleSetVersion ?? 'CI'}. Édité le ${nowStamp()}.</p>`;
    printDocument(`Bulletin ${p.nom} ${p.prenoms} — ${period}`, `${dossierName} · ${period}`, body);
  };

  const checkDecl = async () => {
    setBusy('aqm'); setError(null); setDeclReport(null);
    try { setDeclReport(await api.validateDeclaration(dossierId, { type: 'cnps', year, month: month + 1 })); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const printDeclaration = (kind: 'cnps' | 'dgi') => {
    if (kind === 'cnps') {
      const cp = (c: any) => c.cnpsFamille + c.cnpsAccident + c.cnpsRetraitePatronal;
      const body = `<table><thead><tr><th>Mat.</th><th>Salarié</th><th class="n">Brut</th><th class="n">CNPS salarial</th><th class="n">CNPS patronal</th><th class="n">Total</th></tr></thead><tbody>
        ${payslips.map((p) => `<tr><td>${p.matricule}</td><td>${(p.nom + ' ' + p.prenoms).replace(/[&<>]/g, '')}</td><td class="n">${m(p.calculation.salaireBrutTotal)}</td><td class="n">${m(p.calculation.cnpsSalarial)}</td><td class="n">${m(cp(p.calculation))}</td><td class="n">${m(p.calculation.cnpsSalarial + cp(p.calculation))}</td></tr>`).join('')}
        <tr class="tot"><td colspan="2">Totaux</td><td class="n">${m(psum((c) => c.salaireBrutTotal))}</td><td class="n">${m(psum((c) => c.cnpsSalarial))}</td><td class="n">${m(psum(cp))}</td><td class="n">${m(psum((c) => c.cnpsSalarial) + psum(cp))}</td></tr>
        </tbody></table>`;
      printDocument(`Bordereau CNPS — ${period}`, `${dossierName} · ${period} · à reverser à la CNPS`, body);
    } else {
      const body = `<table><thead><tr><th>Mat.</th><th>Salarié</th><th class="n">Brut imposable</th><th class="n">ITS</th><th class="n">CN</th><th class="n">IGR</th><th class="n">CMU</th></tr></thead><tbody>
        ${payslips.map((p) => { const c = p.calculation; return `<tr><td>${p.matricule}</td><td>${(p.nom + ' ' + p.prenoms).replace(/[&<>]/g, '')}</td><td class="n">${m(c.salaireBrutImposable)}</td><td class="n">${m(c.itsSalarial)}</td><td class="n">${m(c.cnSalarial)}</td><td class="n">${m(c.igrSalarial)}</td><td class="n">${m(c.cmuSalarial)}</td></tr>`; }).join('')}
        <tr class="tot"><td colspan="2">Totaux</td><td class="n">${m(psum((c) => c.salaireBrutImposable))}</td><td class="n">${m(psum((c) => c.itsSalarial))}</td><td class="n">${m(psum((c) => c.cnSalarial))}</td><td class="n">${m(psum((c) => c.igrSalarial))}</td><td class="n">${m(psum((c) => c.cmuSalarial))}</td></tr>
        </tbody></table><p style="margin-top:8px;font-size:11px">Impôts sur salaires retenus (IUS/CUE 2024) à déclarer à la DGI.</p>`;
      printDocument(`Déclaration impôts sur salaires (DGI) — ${period}`, `${dossierName} · ${period}`, body);
    }
  };

  const downloadOrdreVirement = async () => {
    setBusy('ordre'); setError(null);
    try { await downloadAuthed(`/api/dossiers/${dossierId}/payroll/document?kind=ordre_virement&year=${year}&month=${month}`, `ordre-virement-salaires-${year}-${String(month + 1).padStart(2, '0')}.pdf`); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const downloadCourrierVirement = async () => {
    setBusy('courrier'); setError(null);
    try { await downloadAuthed(`/api/dossiers/${dossierId}/payroll/document?kind=courrier_virement&year=${year}&month=${month}`, `courrier-virement-salaires-${year}-${String(month + 1).padStart(2, '0')}.pdf`); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const totals = payslips.reduce((a, p) => ({ brut: a.brut + p.brut, net: a.net + p.net, cout: a.cout + p.cout }), { brut: 0, net: 0, cout: 0 });
  const comptabilise = payslips.length > 0 && payslips.every((p) => p.comptabilise);
  const activeCount = employees.filter((e) => e.actif).length;

  return (
    <div className="space-y-6">
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-0.5 text-sm">
        {([['paie', 'Bulletins & salariés'], ['pointage', 'Pointage'], ['absences', 'Absences'], ['avances', 'Avances & prêts'], ['stc', 'Solde de tout compte'], ['declarations', 'Déclarations']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setSub(k)}
            className={cn('rounded-lg px-3.5 py-1.5 font-medium transition-colors', sub === k ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
            {label}
          </button>
        ))}
      </div>

      {sub === 'paie' && (<>
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
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {p.comptabilise ? <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> comptabilisé</span> : <span className="text-xs text-zinc-500">brouillon</span>}
                            <button onClick={(ev) => { ev.stopPropagation(); printBulletin(p); }} title="Imprimer le bulletin" className="text-zinc-500 hover:text-zinc-200"><Printer className="h-4 w-4" /></button>
                          </div>
                        </td>
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase text-zinc-500">Documents :</span>
                <button onClick={() => printDeclaration('cnps')} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/10"><FileText className="h-3.5 w-3.5" /> Bordereau CNPS</button>
                <button onClick={() => printDeclaration('dgi')} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/10"><FileText className="h-3.5 w-3.5" /> Impôts sur salaires (DGI)</button>
                <button onClick={checkDecl} disabled={busy === 'aqm'} title="Contrôle qualité AQM des déclarations de paie" className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">{busy === 'aqm' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Vérifier (AQM)</button>
                <button onClick={downloadOrdreVirement} disabled={busy === 'ordre'} className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">{busy === 'ordre' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Banknote className="h-3.5 w-3.5" />} Ordre de virement</button>
                <button onClick={downloadCourrierVirement} disabled={busy === 'courrier'} className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">{busy === 'courrier' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} Courrier à la banque</button>
              </div>
              {comptabilise ? <span className="flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> OD de paie comptabilisée</span>
                : <button onClick={post} disabled={busy === 'post'} className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">{busy === 'post' ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookCheck className="h-4 w-4" />} Comptabiliser l'OD de paie</button>}
            </div>
            {declReport && <AqmReportCard report={declReport} />}
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
      </>)}

      {sub === 'pointage' && <TimePanel dossierId={dossierId} employees={employees} />}
      {sub === 'absences' && <AbsencesPanel dossierId={dossierId} employees={employees} currency={currency} />}
      {sub === 'avances' && <AdvancesPanel dossierId={dossierId} employees={employees} currency={currency} />}
      {sub === 'stc' && <StcPanel dossierId={dossierId} dossierName={dossierName} employees={employees} currency={currency} />}
      {sub === 'declarations' && <DeclarationsPanel dossierId={dossierId} dossierName={dossierName} currency={currency} />}
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

// --- Registre des absences -------------------------------------------------
function AbsencesPanel({ dossierId, employees, currency }: { dossierId: string; employees: PayrollEmployee[]; currency: string }) {
  const [rows, setRows] = useState<PayrollAbsence[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const empty = { employeeId: '', dateDebut: today, dateFin: today, jours: 1, paye: false, justifiee: false, motif: '' };
  const [f, setForm] = useState<any>(empty);
  const setF = (p: any) => setForm((x: any) => ({ ...x, ...p }));

  const load = async () => { setLoading(true); try { setRows(await api.payrollAbsences(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const add = async () => {
    if (!f.employeeId) { setErr('Choisissez un salarié.'); return; }
    setBusy(true); setErr(null);
    try { await api.createAbsence(dossierId, { ...f, jours: Number(f.jours) || 0 }); setForm(empty); setShowForm(false); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (id: string) => { setErr(null); try { await api.deleteAbsence(dossierId, id); await load(); } catch (e: any) { setErr(e.message); } };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-zinc-200">Absences ({rows.length})</div>
        <button onClick={() => { setForm(empty); setShowForm((v) => !v); }} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Absence</button>
      </div>
      <p className="text-xs text-zinc-500">Les absences <strong>non payées</strong> sont automatiquement déduites au prorata lors du prochain calcul de paie.</p>
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{err}</p>}

      {showForm && (
        <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2"><label className="mb-1 block text-xs text-zinc-500">Salarié</label>
            <select value={f.employeeId} onChange={(e) => setF({ employeeId: e.target.value })} className={inputCls}>
              <option value="">— choisir —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.matricule} — {e.nom} {e.prenoms}</option>)}
            </select></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Du</label><input type="date" value={f.dateDebut} onChange={(e) => setF({ dateDebut: e.target.value })} className={inputCls} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Au</label><input type="date" value={f.dateFin} onChange={(e) => setF({ dateFin: e.target.value })} className={inputCls} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Jours ouvrables</label><input type="number" value={f.jours} onChange={(e) => setF({ jours: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Motif</label><input value={f.motif} onChange={(e) => setF({ motif: e.target.value })} placeholder="Maladie, congé…" className={inputCls} /></div>
          <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={f.paye} onChange={(e) => setF({ paye: e.target.checked })} className="accent-emerald-500" /> Payée (maintenue au salaire)</label>
          <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={f.justifiee} onChange={(e) => setF({ justifiee: e.target.checked })} className="accent-emerald-500" /> Justifiée</label>
          <div className="sm:col-span-2 lg:col-span-4 flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            <button onClick={add} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</button>
          </div>
        </div>
      )}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : rows.length === 0 ? <p className="text-sm text-zinc-500">Aucune absence enregistrée.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-2.5 font-medium">Salarié</th><th className="px-4 py-2.5 font-medium">Période</th><th className="px-4 py-2.5 text-right font-medium">Jours</th><th className="px-4 py-2.5 font-medium">Statut</th><th className="px-4 py-2.5 font-medium">Motif</th><th className="px-4 py-2.5"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((a) => (
                <tr key={a.id} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-200">{a.nom} {a.prenoms}</td>
                  <td className="px-4 py-2.5 font-mono text-zinc-400">{a.dateDebut} → {a.dateFin}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{a.jours}</td>
                  <td className="px-4 py-2.5"><span className={cn('rounded-full px-2 py-0.5 text-xs', a.paye ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300')}>{a.paye ? 'Payée' : 'Non payée'}</span>{a.justifiee && <span className="ml-1 text-xs text-zinc-500">justifiée</span>}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{a.motif || '—'}</td>
                  <td className="px-4 py-2.5 text-right"><button onClick={() => del(a.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// --- Avances & prêts sur salaire -------------------------------------------
function AdvancesPanel({ dossierId, employees, currency }: { dossierId: string; employees: PayrollEmployee[]; currency: string }) {
  const m = (n: number) => fmtMoney(n, currency);
  const now = new Date();
  const [rows, setRows] = useState<PayrollAdvance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const empty = { employeeId: '', type: 'avance', montantTotal: 0, mensualite: 0, startYear: now.getUTCFullYear(), startMonth: now.getUTCMonth(), motif: '' };
  const [f, setForm] = useState<any>(empty);
  const setF = (p: any) => setForm((x: any) => ({ ...x, ...p }));

  const load = async () => { setLoading(true); try { setRows(await api.payrollAdvances(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const add = async () => {
    if (!f.employeeId) { setErr('Choisissez un salarié.'); return; }
    if (Number(f.montantTotal) <= 0 || Number(f.mensualite) <= 0) { setErr('Montant et mensualité doivent être positifs.'); return; }
    setBusy(true); setErr(null);
    try { await api.createAdvance(dossierId, { ...f, montantTotal: Number(f.montantTotal), mensualite: Number(f.mensualite), startYear: Number(f.startYear), startMonth: Number(f.startMonth) }); setForm(empty); setShowForm(false); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (id: string) => { setErr(null); try { await api.deleteAdvance(dossierId, id); await load(); } catch (e: any) { setErr(e.message); } };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-zinc-200">Avances & prêts ({rows.length})</div>
        <button onClick={() => { setForm(empty); setShowForm((v) => !v); }} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Avance / prêt</button>
      </div>
      <p className="text-xs text-zinc-500">La <strong>mensualité</strong> est retenue automatiquement sur chaque bulletin, à partir du mois de début, jusqu'au remboursement complet.</p>
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{err}</p>}

      {showForm && (
        <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2"><label className="mb-1 block text-xs text-zinc-500">Salarié</label>
            <select value={f.employeeId} onChange={(e) => setF({ employeeId: e.target.value })} className={inputCls}>
              <option value="">— choisir —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.matricule} — {e.nom} {e.prenoms}</option>)}
            </select></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Type</label><select value={f.type} onChange={(e) => setF({ type: e.target.value })} className={inputCls}><option value="avance">Avance</option><option value="pret">Prêt</option></select></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Motif</label><input value={f.motif} onChange={(e) => setF({ motif: e.target.value })} className={inputCls} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Montant total</label><input type="number" value={f.montantTotal} onChange={(e) => setF({ montantTotal: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Mensualité</label><input type="number" value={f.mensualite} onChange={(e) => setF({ mensualite: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Mois de début</label><select value={f.startMonth} onChange={(e) => setF({ startMonth: Number(e.target.value) })} className={inputCls}>{MONTHS.map((mo, i) => <option key={i} value={i}>{mo}</option>)}</select></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Année</label><input type="number" value={f.startYear} onChange={(e) => setF({ startYear: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div className="sm:col-span-2 lg:col-span-4 flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            <button onClick={add} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</button>
          </div>
        </div>
      )}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : rows.length === 0 ? <p className="text-sm text-zinc-500">Aucune avance ni prêt.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-2.5 font-medium">Salarié</th><th className="px-4 py-2.5 font-medium">Type</th><th className="px-4 py-2.5 text-right font-medium">Montant</th><th className="px-4 py-2.5 text-right font-medium">Mensualité</th><th className="px-4 py-2.5 font-medium">Début</th><th className="px-4 py-2.5 text-right font-medium">Restant dû</th><th className="px-4 py-2.5"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((a) => (
                <tr key={a.id} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-200">{a.nom} {a.prenoms}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{a.type === 'pret' ? 'Prêt' : 'Avance'}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(a.montantTotal)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(a.mensualite)}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{MONTHS[a.startMonth]} {a.startYear}</td>
                  <td className="px-4 py-2.5 text-right font-mono"><span className={cn(a.restant > 0 ? 'text-amber-300' : 'text-emerald-400')}>{a.restant > 0 ? m(a.restant) : 'Soldé'}</span></td>
                  <td className="px-4 py-2.5 text-right"><button onClick={() => del(a.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// --- Pointage (heures) ------------------------------------------------------
function TimePanel({ dossierId, employees }: { dossierId: string; employees: PayrollEmployee[] }) {
  const [rows, setRows] = useState<PayrollTimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const empty = { employeeId: '', jour: today, heuresJour: 8, heuresNuit: 0, ferie: false };
  const [f, setForm] = useState<any>(empty);
  const setF = (p: any) => setForm((x: any) => ({ ...x, ...p }));

  const load = async () => { setLoading(true); try { setRows(await api.payrollTime(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const add = async () => {
    if (!f.employeeId) { setErr('Choisissez un salarié.'); return; }
    setBusy(true); setErr(null);
    try { await api.createTimeEntry(dossierId, { ...f, heuresJour: Number(f.heuresJour) || 0, heuresNuit: Number(f.heuresNuit) || 0 }); setForm(empty); setShowForm(false); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async (id: string) => { setErr(null); try { await api.deleteTimeEntry(dossierId, id); await load(); } catch (e: any) { setErr(e.message); } };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-zinc-200">Pointage ({rows.length})</div>
        <button onClick={() => { setForm(empty); setShowForm((v) => !v); }} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Jour pointé</button>
      </div>
      <p className="text-xs text-zinc-500">Les heures au-delà de la durée normale sont <strong>ventilées automatiquement</strong> au calcul de paie : 15/50 % le jour, 75 % la nuit, 100 % le dimanche ou un jour férié.</p>
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{err}</p>}

      {showForm && (
        <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2"><label className="mb-1 block text-xs text-zinc-500">Salarié</label>
            <select value={f.employeeId} onChange={(e) => setF({ employeeId: e.target.value })} className={inputCls}>
              <option value="">— choisir —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.matricule} — {e.nom} {e.prenoms}</option>)}
            </select></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Jour</label><input type="date" value={f.jour} onChange={(e) => setF({ jour: e.target.value })} className={inputCls} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Heures (jour)</label><input type="number" step="0.5" value={f.heuresJour} onChange={(e) => setF({ heuresJour: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <div><label className="mb-1 block text-xs text-zinc-500">Heures (nuit)</label><input type="number" step="0.5" value={f.heuresNuit} onChange={(e) => setF({ heuresNuit: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={f.ferie} onChange={(e) => setF({ ferie: e.target.checked })} className="accent-emerald-500" /> Jour férié</label>
          <div className="sm:col-span-2 lg:col-span-4 flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
            <button onClick={add} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</button>
          </div>
        </div>
      )}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : rows.length === 0 ? <p className="text-sm text-zinc-500">Aucun jour pointé.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-2.5 font-medium">Salarié</th><th className="px-4 py-2.5 font-medium">Jour</th><th className="px-4 py-2.5 text-right font-medium">H. jour</th><th className="px-4 py-2.5 text-right font-medium">H. nuit</th><th className="px-4 py-2.5 font-medium">Férié</th><th className="px-4 py-2.5"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-200">{t.nom} {t.prenoms}</td>
                  <td className="px-4 py-2.5 font-mono text-zinc-400">{t.jour}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{t.heuresJour}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{t.heuresNuit || '—'}</td>
                  <td className="px-4 py-2.5">{t.ferie ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">Férié</span> : <span className="text-zinc-600">—</span>}</td>
                  <td className="px-4 py-2.5 text-right"><button onClick={() => del(t.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// --- Solde de tout compte (STC) --------------------------------------------
function StcPanel({ dossierId, dossierName, employees, currency }: { dossierId: string; dossierName: string; employees: PayrollEmployee[]; currency: string }) {
  const m = (n: number) => fmtMoney(n, currency);
  const today = new Date().toISOString().slice(0, 10);
  const empty = { employeeId: '', ruptureType: 'licenciement' as RuptureType, ruptureDate: today, joursCongesNonPris: 0, preavisEffectue: false, salaireMoisDu: 0, cddTotalGross: 0 };
  const [f, setForm] = useState<any>(empty);
  const setF = (p: any) => setForm((x: any) => ({ ...x, ...p }));
  const [res, setRes] = useState<StcResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const compute = async () => {
    if (!f.employeeId) { setErr('Choisissez un salarié.'); return; }
    setBusy(true); setErr(null); setRes(null);
    try {
      const input: any = { employeeId: f.employeeId, ruptureType: f.ruptureType, ruptureDate: f.ruptureDate, joursCongesNonPris: Number(f.joursCongesNonPris) || 0, preavisEffectue: !!f.preavisEffectue, salaireMoisDu: Number(f.salaireMoisDu) || 0 };
      if (f.ruptureType === 'fin_cdd') input.cddTotalGross = Number(f.cddTotalGross) || 0;
      setRes(await api.computeStc(dossierId, input));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const print = () => {
    if (!res) return;
    const e = res.employee;
    const rows = res.lines.map((l) => `<tr><td>${l.label}${l.note ? ` <span style="color:#666;font-size:11px">(${l.note})</span>` : ''}</td><td class="n">${m(l.amount)}</td></tr>`).join('');
    const body = `
      <table style="margin-bottom:12px"><tbody>
        <tr><td><b>Employeur :</b> ${dossierName.replace(/[&<>]/g, '')}</td><td class="n">Solde de tout compte</td></tr>
        <tr><td><b>Salarié :</b> ${(e.nom + ' ' + e.prenoms).replace(/[&<>]/g, '')} (${e.matricule})</td><td class="n">${e.categorie}</td></tr>
        <tr><td><b>Motif :</b> ${RUPTURE_LABELS[f.ruptureType as RuptureType]}</td><td class="n">Rupture le ${f.ruptureDate}</td></tr>
        <tr><td><b>Ancienneté :</b> ${res.tenureYears} ans</td><td class="n">Salaire de réf. ${m(res.referenceSalary)}</td></tr>
      </tbody></table>
      <table><thead><tr><th>Élément</th><th class="n">Montant</th></tr></thead><tbody>
        ${rows}
        <tr class="tot"><td>TOTAL SOLDE DE TOUT COMPTE</td><td class="n">${m(res.total)}</td></tr>
      </tbody></table>
      <p style="margin-top:10px;font-size:11px">Barèmes : ${res.ruleSetLabel}. Édité le ${nowStamp()}. Montant sous réserve des barèmes légaux/conventionnels en vigueur.</p>`;
    printDocument(`STC ${e.nom} ${e.prenoms}`, `${dossierName} · solde de tout compte`, body);
  };

  return (
    <section className="space-y-4">
      <p className="text-xs text-zinc-500">Calcule les droits au départ d'un salarié (salaire dû, congés non pris, préavis, indemnité de licenciement / fin de CDD) selon le type de rupture. Le salaire de référence est la moyenne des 12 derniers bulletins, à défaut le salaire courant.</p>
      {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{err}</p>}

      <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2"><label className="mb-1 block text-xs text-zinc-500">Salarié</label>
          <select value={f.employeeId} onChange={(e) => setF({ employeeId: e.target.value })} className={inputCls}>
            <option value="">— choisir —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.matricule} — {e.nom} {e.prenoms}</option>)}
          </select></div>
        <div className="lg:col-span-2"><label className="mb-1 block text-xs text-zinc-500">Type de rupture</label>
          <select value={f.ruptureType} onChange={(e) => setF({ ruptureType: e.target.value })} className={inputCls}>
            {(Object.keys(RUPTURE_LABELS) as RuptureType[]).map((k) => <option key={k} value={k}>{RUPTURE_LABELS[k]}</option>)}
          </select></div>
        <div><label className="mb-1 block text-xs text-zinc-500">Date de rupture</label><input type="date" value={f.ruptureDate} onChange={(e) => setF({ ruptureDate: e.target.value })} className={inputCls} /></div>
        <div><label className="mb-1 block text-xs text-zinc-500">Congés non pris (jours)</label><input type="number" value={f.joursCongesNonPris} onChange={(e) => setF({ joursCongesNonPris: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
        <div><label className="mb-1 block text-xs text-zinc-500">Salaire du mois restant dû</label><input type="number" value={f.salaireMoisDu} onChange={(e) => setF({ salaireMoisDu: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
        {f.ruptureType === 'fin_cdd'
          ? <div><label className="mb-1 block text-xs text-zinc-500">Brut total du CDD</label><input type="number" value={f.cddTotalGross} onChange={(e) => setF({ cddTotalGross: Number(e.target.value) })} className={cn(inputCls, 'font-mono')} /></div>
          : <label className="flex items-end gap-2 pb-2 text-sm text-zinc-300"><input type="checkbox" checked={f.preavisEffectue} onChange={(e) => setF({ preavisEffectue: e.target.checked })} className="accent-emerald-500" /> Préavis effectué</label>}
        <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
          <button onClick={compute} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Calculer le solde</button>
        </div>
      </div>

      {res && (
        <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-zinc-400">Ancienneté <strong className="text-zinc-200">{res.tenureYears} ans</strong> · salaire de référence <strong className="text-zinc-200">{m(res.referenceSalary)}</strong></div>
            <button onClick={print} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> Imprimer</button>
          </div>
          <div className="overflow-hidden rounded-xl border border-white/10">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr><th className="px-4 py-2.5 font-medium">Élément</th><th className="px-4 py-2.5 text-right font-medium">Montant</th></tr></thead>
              <tbody className="divide-y divide-white/5">
                {res.lines.length === 0 ? <tr><td colSpan={2} className="px-4 py-3 text-zinc-500">Aucun droit ouvert pour ce type de rupture.</td></tr> : res.lines.map((l) => (
                  <tr key={l.key}><td className="px-4 py-2.5 text-zinc-300">{l.label}{l.note && <span className="ml-2 text-xs text-zinc-500">{l.note}</span>}</td><td className="px-4 py-2.5 text-right font-mono text-zinc-200">{m(l.amount)}</td></tr>
                ))}
              </tbody>
              <tfoot className="border-t border-white/10 bg-white/5"><tr><td className="px-4 py-3 font-semibold text-zinc-100">Total solde de tout compte</td><td className="px-4 py-3 text-right font-mono font-semibold text-emerald-300">{m(res.total)}</td></tr></tfoot>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

// --- Déclarations annuelles (DISA CNPS, récap impôts DGI) -------------------
function DeclarationsPanel({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const m = (n: number) => fmtMoney(n, currency);
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [data, setData] = useState<PayrollYear | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => { setLoading(true); try { setData(await api.payrollYear(dossierId, year)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId, year]);

  const esc = (s: string) => (s || '').replace(/[&<>]/g, '');
  const employerHead = (title: string) => {
    const e = data!.employer;
    return `<table style="margin-bottom:12px"><tbody>
      <tr><td><b>Employeur :</b> ${esc(e.raisonSociale)}</td><td class="n">${title}</td></tr>
      <tr><td>${e.taxId ? `NCC/IFU : ${esc(e.taxId)}` : ''}${e.rccm ? ` · RCCM : ${esc(e.rccm)}` : ''}</td><td class="n">Année ${year}</td></tr>
    </tbody></table>`;
  };

  const printDISA = () => {
    if (!data) return;
    const rows = data.annual.map((a) => `<tr><td>${a.matricule}</td><td>${esc(a.nom + ' ' + a.prenoms)}</td><td class="n">${a.mois}</td><td class="n">${m(a.brut)}</td><td class="n">${m(a.cnpsSalarial)}</td><td class="n">${m(a.cnpsPatronal)}</td><td class="n">${m(a.cnpsSalarial + a.cnpsPatronal)}</td></tr>`).join('');
    const t = data.totals;
    const body = `${employerHead('DISA — CNPS (déclaration individuelle des salaires annuels)')}
      <table><thead><tr><th>Mat.</th><th>Salarié</th><th class="n">Mois</th><th class="n">Brut annuel</th><th class="n">CNPS salarial</th><th class="n">CNPS patronal</th><th class="n">Total CNPS</th></tr></thead><tbody>
        ${rows}<tr class="tot"><td colspan="3">Totaux</td><td class="n">${m(t.brut)}</td><td class="n">${m(t.cnpsSalarial)}</td><td class="n">${m(t.cnpsPatronal)}</td><td class="n">${m(t.cnpsSalarial + t.cnpsPatronal)}</td></tr>
      </tbody></table><p style="margin-top:8px;font-size:11px">Document de synthèse annuelle CNPS. Barèmes à attester ; à rapprocher des bordereaux mensuels.</p>`;
    printDocument(`DISA CNPS ${year} — ${dossierName}`, `${dossierName} · CNPS · ${year}`, body);
  };
  const printImpots = () => {
    if (!data) return;
    const rows = data.annual.map((a) => `<tr><td>${a.matricule}</td><td>${esc(a.nom + ' ' + a.prenoms)}</td><td class="n">${m(a.brutImposable)}</td><td class="n">${m(a.its)}</td><td class="n">${m(a.cn)}</td><td class="n">${m(a.igr)}</td><td class="n">${m(a.cmu)}</td><td class="n">${m(a.its + a.cn + a.igr + a.cmu)}</td></tr>`).join('');
    const t = data.totals;
    const body = `${employerHead('Récapitulatif annuel des impôts sur salaires — DGI')}
      <table><thead><tr><th>Mat.</th><th>Salarié</th><th class="n">Brut imposable</th><th class="n">ITS</th><th class="n">CN</th><th class="n">IGR</th><th class="n">CMU</th><th class="n">Total</th></tr></thead><tbody>
        ${rows}<tr class="tot"><td colspan="2">Totaux</td><td class="n">${m(t.brutImposable)}</td><td class="n">${m(t.its)}</td><td class="n">${m(t.cn)}</td><td class="n">${m(t.igr)}</td><td class="n">${m(t.cmu)}</td><td class="n">${m(t.its + t.cn + t.igr + t.cmu)}</td></tr>
      </tbody></table><p style="margin-top:8px;font-size:11px">Cumul annuel des impôts sur salaires retenus (IUS/ITS, CN, IGR, CMU) à rapprocher des déclarations mensuelles DGI.</p>`;
    printDocument(`Récap impôts salaires ${year} — ${dossierName}`, `${dossierName} · DGI · ${year}`, body);
  };

  const totalCnps = data ? data.totals.cnpsSalarial + data.totals.cnpsPatronal : 0;
  const totalImpots = data ? data.totals.its + data.totals.cn + data.totals.igr + data.totals.cmu : 0;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-zinc-400">Déclarations annuelles cumulées à partir des bulletins comptabilisés.</div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-500">Année</label>
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className={cn(inputCls, 'w-24 font-mono')} />
        </div>
      </div>

      {data && (data.employer.taxId || data.employer.rccm) && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-300">
          <div className="font-medium text-zinc-100">{data.employer.raisonSociale}</div>
          <div className="mt-0.5 text-xs text-zinc-500">{data.employer.taxId ? `NCC/IFU ${data.employer.taxId}` : ''}{data.employer.rccm ? ` · RCCM ${data.employer.rccm}` : ''}</div>
        </div>
      )}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : !data || data.annual.length === 0 ? (
        <p className="text-sm text-zinc-500">Aucun bulletin pour {year}. Lancez la paie des mois concernés pour alimenter les déclarations annuelles.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card label="Masse salariale (brut)" value={m(data.totals.brut)} />
            <Card label="Total CNPS (sal.+pat.)" value={m(totalCnps)} />
            <Card label="Total impôts sur salaires" value={m(totalImpots)} />
            <Card label="Net versé" value={m(data.totals.net)} />
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={printDISA} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> DISA annuelle (CNPS)</button>
            <button onClick={printImpots} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> Récap annuel impôts (DGI)</button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                <th className="px-4 py-2.5 font-medium">Salarié</th><th className="px-4 py-2.5 text-right font-medium">Mois</th><th className="px-4 py-2.5 text-right font-medium">Brut</th><th className="px-4 py-2.5 text-right font-medium">CNPS</th><th className="px-4 py-2.5 text-right font-medium">Impôts</th><th className="px-4 py-2.5 text-right font-medium">Net</th>
              </tr></thead>
              <tbody className="divide-y divide-white/5">
                {data.annual.map((a) => (
                  <tr key={a.employeeId} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 text-zinc-200">{a.nom} {a.prenoms} <span className="text-xs text-zinc-500">{a.matricule}</span></td>
                    <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{a.mois}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(a.brut)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(a.cnpsSalarial + a.cnpsPatronal)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(a.its + a.cn + a.igr + a.cmu)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{m(a.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}
