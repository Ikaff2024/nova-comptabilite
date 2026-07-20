import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, type PayrollEmployee, type LeaveRequest, type LeaveBalance } from '../lib/api';
import { cn } from '../lib/utils';

// Congés : demande → validation → solde. Une demande EN ATTENTE n'impacte ni la
// paie ni l'absentéisme ; c'est l'approbation qui crée l'absence, laquelle
// alimente ensuite la déduction de paie et la provision congés.

const inputCls = 'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';

const LEAVE_TYPES: [string, string][] = [
  ['conges_payes', 'Congés payés'], ['maladie', 'Maladie'], ['sans_solde', 'Sans solde'], ['autre', 'Autre'],
];
const STATUT_STYLE: Record<string, string> = {
  en_attente: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  approuve: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  refuse: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  annule: 'border-white/10 bg-white/5 text-zinc-400',
};
const STATUT_LABEL: Record<string, string> = { en_attente: 'En attente', approuve: 'Approuvé', refuse: 'Refusé', annule: 'Annulé' };
const typeLabel = (t: string) => LEAVE_TYPES.find(([v]) => v === t)?.[1] ?? t;

export default function CongesPanel({ dossierId, employees }: { dossierId: string; employees: PayrollEmployee[] }) {
  const [demandes, setDemandes] = useState<LeaveRequest[]>([]);
  const [soldes, setSoldes] = useState<LeaveBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ employeeId: '', type: 'conges_payes', dateDebut: '', dateFin: '', jours: '', motif: '' });

  const load = async () => {
    setLoading(true);
    try { const d = await api.leave(dossierId); setDemandes(d.demandes); setSoldes(d.soldes); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [dossierId]);

  const submit = async () => {
    setBusy('new'); setError(null);
    try {
      await api.createLeave(dossierId, {
        employeeId: f.employeeId, type: f.type, dateDebut: f.dateDebut, dateFin: f.dateFin,
        jours: Number(f.jours) || 0, motif: f.motif || undefined,
      });
      setF({ employeeId: '', type: 'conges_payes', dateDebut: '', dateFin: '', jours: '', motif: '' });
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const decide = async (id: string, approve: boolean) => {
    const msg = approve
      ? 'Approuver cette demande ? Une absence sera créée et prise en compte dans la paie.'
      : 'Refuser cette demande ?';
    if (!confirm(msg)) return;
    setBusy(id); setError(null);
    try { await api.decideLeave(dossierId, id, approve); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const attente = demandes.filter((d) => d.statut === 'en_attente');

  return (
    <div className="space-y-5">
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-sm font-medium text-zinc-200">Nouvelle demande</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Salarié</label>
            <select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} className={inputCls}>
              <option value="">— choisir —</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.matricule} — {e.nom} {e.prenoms}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Type</label>
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} className={inputCls}>
              {LEAVE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Jours ouvrables</label>
            <input type="number" min="0.5" step="0.5" value={f.jours} onChange={(e) => setF({ ...f, jours: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Du</label>
            <input type="date" value={f.dateDebut} onChange={(e) => setF({ ...f, dateDebut: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Au</label>
            <input type="date" value={f.dateFin} onChange={(e) => setF({ ...f, dateFin: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Motif <span className="text-zinc-600">(optionnel)</span></label>
            <input value={f.motif} onChange={(e) => setF({ ...f, motif: e.target.value })} className={inputCls} />
          </div>
        </div>
        <button onClick={submit} disabled={busy === 'new' || !f.employeeId || !f.dateDebut || !f.dateFin || !Number(f.jours)}
          className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">
          {busy === 'new' && <Loader2 className="h-4 w-4 animate-spin" />} Déposer la demande
        </button>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
        <div className="border-b border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-200">
          Demandes
          {attente.length > 0 && <span className="ml-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">{attente.length} à traiter</span>}
        </div>
        {loading ? <div className="flex items-center gap-2 px-4 py-4 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
          : demandes.length === 0 ? <p className="px-4 py-4 text-sm text-zinc-500">Aucune demande enregistrée.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 text-xs uppercase text-zinc-500"><tr>
                <th className="px-4 py-2 font-medium">Salarié</th><th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Période</th><th className="px-4 py-2 text-right font-medium">Jours</th>
                <th className="px-4 py-2 font-medium">Statut</th><th className="px-4 py-2"></th>
              </tr></thead>
              <tbody className="divide-y divide-white/5">
                {demandes.map((d) => (
                  <tr key={d.id} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 text-zinc-200">{d.nom} {d.prenoms}<div className="text-xs text-zinc-500">{d.matricule}</div></td>
                    <td className="px-4 py-2.5 text-zinc-400">{typeLabel(d.type)}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{d.date_debut} → {d.date_fin}{d.motif && <div className="text-xs text-zinc-600">{d.motif}</div>}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-zinc-300">{d.jours}</td>
                    <td className="px-4 py-2.5"><span className={cn('rounded-full border px-2 py-0.5 text-xs', STATUT_STYLE[d.statut])}>{STATUT_LABEL[d.statut] ?? d.statut}</span></td>
                    <td className="px-4 py-2.5 text-right">
                      {d.statut === 'en_attente' && (
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => decide(d.id, true)} disabled={busy === d.id}
                            className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">Approuver</button>
                          <button onClick={() => decide(d.id, false)} disabled={busy === d.id}
                            className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-400 hover:text-rose-400 disabled:opacity-50">Refuser</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
        <div className="border-b border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-200">Soldes de congés</div>
        <p className="px-4 py-2 text-xs text-zinc-500">Droit acquis estimé à 2,2 jours ouvrables par mois de service, diminué des congés pris et des demandes en attente.</p>
        {soldes.length === 0 ? <p className="px-4 py-4 text-sm text-zinc-500">Aucun salarié actif.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 text-xs uppercase text-zinc-500"><tr>
              <th className="px-4 py-2 font-medium">Salarié</th><th className="px-4 py-2 text-right font-medium">Acquis</th>
              <th className="px-4 py-2 text-right font-medium">Pris</th><th className="px-4 py-2 text-right font-medium">En attente</th>
              <th className="px-4 py-2 text-right font-medium">Solde</th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {soldes.map((s) => (
                <tr key={s.employeeId} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-200">{s.nom}{s.poste && <div className="text-xs text-zinc-500">{s.poste}</div>}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{s.acquis} j</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{s.pris} j</td>
                  <td className="px-4 py-2.5 text-right font-mono text-amber-300">{s.enAttente || '—'}</td>
                  <td className={cn('px-4 py-2.5 text-right font-mono font-semibold', s.solde < 0 ? 'text-rose-400' : 'text-emerald-400')}>{s.solde} j</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
