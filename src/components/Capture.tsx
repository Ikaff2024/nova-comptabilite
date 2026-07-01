import React, { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ScanLine, Loader2, Sparkles, AlertTriangle, RotateCcw, UploadCloud } from 'lucide-react';
import { api, type FiscalYear, type Journal, type CaptureProposal } from '../lib/api';
import EntryForm from './EntryForm';

export default function Capture({
  dossierId, fiscalYears, journals, currency, onPosted,
}: {
  dossierId: string; fiscalYears: FiscalYear[]; journals: Journal[]; currency: string; onPosted: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<CaptureProposal | null>(null);
  const [provider, setProvider] = useState<string>('');

  const reset = () => { setPreview(null); setProposal(null); setError(null); if (inputRef.current) inputRef.current.value = ''; };

  const handleFile = (file: File) => {
    setError(null); setProposal(null);
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      setPreview(dataUrl);
      const base64 = dataUrl.split(',')[1];
      setLoading(true);
      try {
        const res = await api.capture(dossierId, file.type || 'image/jpeg', base64);
        setProposal(res.proposal); setProvider(res.provider);
      } catch (e: any) { setError(e.message); }
      finally { setLoading(false); }
    };
    reader.readAsDataURL(file);
  };

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) handleFile(f); };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); };

  const confidencePct = proposal ? Math.round(proposal.confidence * 100) : 0;
  const confColor = confidencePct >= 75 ? 'text-emerald-400' : confidencePct >= 50 ? 'text-amber-400' : 'text-rose-400';

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      {/* Colonne pièce */}
      <div className="space-y-4">
        {!preview ? (
          <div
            onClick={() => inputRef.current?.click()}
            onDrop={onDrop} onDragOver={(e) => e.preventDefault()}
            className="flex h-72 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/15 bg-white/5 p-6 text-center transition-colors hover:border-emerald-500/40 hover:bg-white/[0.07]"
          >
            <div className="rounded-full bg-emerald-500/10 p-3 text-emerald-400"><UploadCloud className="h-7 w-7" /></div>
            <p className="mt-4 font-medium text-zinc-200">Déposez un reçu ou une facture</p>
            <p className="mt-1 text-sm text-zinc-500">JPG, PNG ou PDF — ou cliquez pour choisir</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            {preview.startsWith('data:image') ? (
              <img src={preview} alt="pièce" className="max-h-72 w-full object-contain bg-black/30" />
            ) : (
              <div className="flex h-72 items-center justify-center text-zinc-400">Document PDF chargé</div>
            )}
          </div>
        )}

        <input ref={inputRef} type="file" accept="image/*,application/pdf" onChange={onInput} className="hidden" />

        {preview && (
          <button onClick={reset} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200">
            <RotateCcw className="h-4 w-4" /> Analyser une autre pièce
          </button>
        )}
      </div>

      {/* Colonne proposition */}
      <div>
        {loading && (
          <div className="flex h-72 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-center">
            <Loader2 className="h-7 w-7 animate-spin text-emerald-400" />
            <p className="mt-4 font-medium text-zinc-200">Analyse de la pièce…</p>
            <p className="mt-1 text-sm text-zinc-500">L'IA extrait l'écriture SYSCOHADA.</p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 rounded-2xl border border-rose-500/20 bg-rose-500/10 p-5 text-rose-300">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div><p className="font-medium">Échec de l'analyse</p><p className="mt-1 text-sm">{error}</p></div>
          </div>
        )}

        {!loading && !error && !proposal && (
          <div className="flex h-72 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-center text-zinc-500">
            <ScanLine className="h-8 w-8" />
            <p className="mt-3 max-w-xs text-sm">La proposition d'écriture apparaîtra ici, prête à vérifier et valider.</p>
          </div>
        )}

        {proposal && !loading && (
          <motion.div key={preview} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <EntryForm
              dossierId={dossierId} fiscalYears={fiscalYears} journals={journals} currency={currency}
              onPosted={() => { onPosted(); reset(); }}
              initial={{ description: proposal.description, entryDate: proposal.entryDate, journalCode: proposal.journalCode, lines: proposal.lines, counterpartyName: proposal.counterpartyName }}
              banner={
                <div className="space-y-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-emerald-300"><Sparkles className="h-4 w-4" /> Proposition IA — à vérifier puis valider</span>
                    <span className={confColor}>confiance {confidencePct}%</span>
                  </div>
                  <div className="text-xs text-zinc-500">moteur : {provider}{proposal.counterpartyName ? ` · tiers : ${proposal.counterpartyName}` : ''}</div>
                  {proposal.warnings?.map((w, i) => (
                    <p key={i} className="flex items-start gap-1.5 text-xs text-amber-400"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}</p>
                  ))}
                </div>
              }
            />
          </motion.div>
        )}
      </div>
    </div>
  );
}
