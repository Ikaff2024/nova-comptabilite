import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, LayoutDashboard, FileText, Upload, Loader2, Paperclip, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { api, type Dossier, type FiscalYear, type DossierDocument } from '../lib/api';
import { cn } from '../lib/utils';
import DossierDashboard from './DossierDashboard';
import FinancialStatements from './FinancialStatements';

type Tab = 'synthese' | 'etats' | 'pieces';

// Espace client : accès restreint à SON dossier (consultation + dépôt de pièces).
// Les actions d'écriture comptable ne sont pas exposées ; le back les refuse de
// toute façon pour un rôle 'client' (garde-fou de capacités).
export default function ClientPortal({ dossier, onBack }: { dossier: Dossier; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('synthese');
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);

  useEffect(() => { api.fiscalYears(dossier.id).then(setFiscalYears).catch(() => {}); }, [dossier.id]);

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'synthese', label: 'Synthèse', icon: LayoutDashboard },
    { id: 'etats', label: 'États financiers', icon: FileText },
    { id: 'pieces', label: 'Mes pièces', icon: Paperclip },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button onClick={onBack} className="mb-2 flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200"><ArrowLeft className="h-4 w-4" /> Mes dossiers</button>
          <h1 className="font-display text-2xl font-bold text-white">{dossier.raison_sociale}</h1>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300"><ShieldCheck className="h-4 w-4" /> Espace client</span>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-white/10">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn('flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === t.id ? 'border-emerald-400 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200')}>
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      <div>
        {tab === 'synthese' && <DossierDashboard dossierId={dossier.id} currency={dossier.base_currency} />}
        {tab === 'etats' && <FinancialStatements dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} />}
        {tab === 'pieces' && <Pieces dossierId={dossier.id} />}
      </div>
    </div>
  );
}

function Pieces({ dossierId }: { dossierId: string }) {
  const [docs, setDocs] = useState<DossierDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => { setLoading(true); try { setDocs(await api.documents(dossierId)); } catch (e: any) { setError(e.message); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const onFile = async (f: File) => {
    setError(null); setOk(null); setUploading(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(new Error('Lecture du fichier impossible'));
        r.readAsDataURL(f);
      });
      await api.uploadDocument(dossierId, { mimeType: f.type || 'application/octet-stream', dataBase64, filename: f.name });
      setOk(`« ${f.name} » déposé. Votre comptable le traitera.`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-dashed border-white/15 bg-white/5 p-6 text-center">
        <Upload className="mx-auto h-8 w-8 text-emerald-400" />
        <p className="mt-3 text-sm text-zinc-300">Déposez vos factures, reçus et justificatifs</p>
        <p className="mt-1 text-xs text-zinc-500">Images ou PDF — 15 Mo max. Votre comptable les récupère automatiquement.</p>
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Déposer une pièce
        </button>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </div>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      {ok && <p className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {ok}</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
        : docs.length === 0 ? <p className="text-sm text-zinc-500">Aucune pièce déposée pour l'instant.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-3 font-medium">Pièce</th><th className="px-4 py-3 font-medium">Déposée le</th><th className="px-4 py-3 text-right font-medium">Taille</th><th className="px-4 py-3 font-medium">Statut</th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {docs.map((d) => (
                <tr key={d.id} className="hover:bg-white/5">
                  <td className="px-4 py-2.5"><a href={d.url} target="_blank" rel="noopener" className="inline-flex items-center gap-2 text-zinc-200 hover:text-emerald-400"><Paperclip className="h-4 w-4 text-zinc-500" /> {d.filename ?? 'pièce'}</a></td>
                  <td className="px-4 py-2.5 text-zinc-500">{d.createdAt}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{fmtSize(d.size)}</td>
                  <td className="px-4 py-2.5">{d.entryId ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">Comptabilisée</span> : <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-400">En attente</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
