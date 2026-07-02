import React, { useEffect, useState } from 'react';
import { Loader2, History, ShieldCheck, RotateCcw } from 'lucide-react';
import { api, type AuditEntry } from '../lib/api';

const ACTIONS: Record<string, { label: string; color: string }> = {
  'entry.posted': { label: 'Écriture comptabilisée', color: 'text-emerald-400 bg-emerald-500/10' },
  'entry.reversed': { label: 'Écriture contre-passée', color: 'text-amber-400 bg-amber-500/10' },
  'exercise.closed': { label: 'Exercice clôturé', color: 'text-violet-400 bg-violet-500/10' },
  'invoice.issued': { label: 'Facture émise', color: 'text-sky-400 bg-sky-500/10' },
  'invoice.certified': { label: 'Facture certifiée (FNE)', color: 'text-sky-400 bg-sky-500/10' },
};

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Saisie', ocr: 'Capture IA', mobile_money: 'Mobile Money', bank_import: 'Import bancaire',
  recurring: 'Récurrente', api: 'API', opening_balance: 'À-nouveaux',
};

function summarize(a: AuditEntry): string {
  const d = a.detail ?? {};
  switch (a.action) {
    case 'entry.posted': return `${d.piece_ref ?? ''} · ${SOURCE_LABELS[d.source] ?? d.source ?? ''} · ${d.description ?? ''}`;
    case 'entry.reversed': return `Extourne générée`;
    case 'exercise.closed': return `Résultat ${Number(d.resultat ?? 0).toLocaleString('fr-FR')} reporté`;
    case 'invoice.issued': return `${d.number ?? ''} · ${d.client ?? ''} · ${Number(d.total_ttc ?? 0).toLocaleString('fr-FR')}`;
    case 'invoice.certified': return `${d.number ?? ''} · réf. ${d.reference ?? ''} (${d.provider ?? ''})`;
    default: return JSON.stringify(d);
  }
}

export default function AuditTrail({ dossierId }: { dossierId: string }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async () => { setLoading(true); try { setRows(await api.audit(dossierId, 300)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-zinc-300"><History className="h-4 w-4 text-emerald-400" /> Piste d'audit — traçabilité des actions</div>
        <button onClick={load} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10"><RotateCcw className="h-4 w-4" /> Actualiser</button>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-zinc-500"><ShieldCheck className="h-3.5 w-3.5" /> Registre inaltérable : chaque enregistrement est en lecture seule (aucune modification ni suppression possible).</p>

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        : rows.length === 0 ? <p className="text-zinc-400">Aucune action tracée pour l'instant.</p>
        : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
              <tr><th className="px-4 py-2.5 font-medium">Horodatage</th><th className="px-4 py-2.5 font-medium">Utilisateur</th><th className="px-4 py-2.5 font-medium">Action</th><th className="px-4 py-2.5 font-medium">Détail</th></tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((a) => {
                const meta = ACTIONS[a.action] ?? { label: a.action, color: 'text-zinc-400 bg-white/10' };
                return (
                  <tr key={a.id} className="hover:bg-white/5">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-zinc-400">{a.created_at.replace('T', ' ')}</td>
                    <td className="px-4 py-2 text-zinc-300">{a.user_name || a.user_email || '—'}</td>
                    <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.color}`}>{meta.label}</span></td>
                    <td className="px-4 py-2 text-zinc-400">{summarize(a)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
