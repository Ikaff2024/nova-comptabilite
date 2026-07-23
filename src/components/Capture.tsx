import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ScanLine, Loader2, Sparkles, AlertTriangle, RotateCcw, UploadCloud, CheckCircle2, Clock, FileText, X } from 'lucide-react';
import { api, type FiscalYear, type Journal, type CaptureProposal } from '../lib/api';
import EntryForm from './EntryForm';

// Capture IA par LOT : on dépose plusieurs pièces d'un coup, elles sont
// analysées en tâche de fond (séquentiellement, pour rester sous les limites de
// l'IA), puis on enchaîne les validations. Chaque proposition reste vérifiée et
// validée MANUELLEMENT (rien n'est comptabilisé automatiquement).

const MAX_BATCH = 25; // garde-fou : chaque pièce = un appel IA facturé.

type Status = 'queued' | 'analyzing' | 'ready' | 'error' | 'posted';
interface ScanItem {
  id: string; name: string; mimeType: string; preview: string | null; isPdf: boolean;
  status: Status; proposal?: CaptureProposal; provider?: string; docUrl?: string; error?: string;
}

const STATUS_META: Record<Status, { label: string; cls: string; icon: any }> = {
  queued: { label: 'En attente', cls: 'text-zinc-400', icon: Clock },
  analyzing: { label: 'Analyse…', cls: 'text-sky-400', icon: Loader2 },
  ready: { label: 'À valider', cls: 'text-emerald-400', icon: Sparkles },
  error: { label: 'Échec', cls: 'text-rose-400', icon: AlertTriangle },
  posted: { label: 'Validée', cls: 'text-emerald-500', icon: CheckCircle2 },
};

let seq = 0;
const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result as string);
  r.onerror = () => reject(new Error('Lecture du fichier impossible.'));
  r.readAsDataURL(file);
});

export default function Capture({
  dossierId, fiscalYears, journals, currency, onPosted,
}: {
  dossierId: string; fiscalYears: FiscalYear[]; journals: Journal[]; currency: string; onPosted: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<ScanItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // File d'attente de travail (refs : découplée de l'état d'affichage).
  const pending = useRef<{ id: string; file: File }[]>([]);
  const running = useRef(false);

  const patch = (id: string, p: Partial<ScanItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));

  // Analyse séquentielle : dépile `pending`, appelle l'IA, met à jour le statut.
  const drain = async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (pending.current.length) {
        const { id, file } = pending.current.shift()!;
        patch(id, { status: 'analyzing' });
        try {
          const dataUrl = await readDataUrl(file);
          const base64 = dataUrl.split(',')[1];
          const mimeType = file.type || 'image/jpeg';
          const res = await api.capture(dossierId, mimeType, base64);
          let docUrl: string | undefined;
          try { docUrl = (await api.uploadDocument(dossierId, { mimeType, dataBase64: base64, filename: file.name })).url; }
          catch { /* la capture reste utilisable même si la conservation échoue */ }
          patch(id, { status: 'ready', proposal: res.proposal, provider: res.provider, docUrl });
        } catch (e: any) {
          patch(id, { status: 'error', error: e.message });
        }
      }
    } finally { running.current = false; }
  };

  const addFiles = async (files: File[]) => {
    setNotice(null);
    const accepted = files.filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
    let toAdd = accepted;
    // Le nombre en cours + nouveaux ne doit pas dépasser le garde-fou.
    const activeCount = items.filter((it) => it.status !== 'posted').length;
    if (activeCount + toAdd.length > MAX_BATCH) {
      toAdd = toAdd.slice(0, Math.max(0, MAX_BATCH - activeCount));
      setNotice(`Lot limité à ${MAX_BATCH} pièces à la fois. ${accepted.length - toAdd.length} pièce(s) non ajoutée(s) — validez le lot en cours puis reprenez.`);
    }
    if (toAdd.length === 0) return;

    const newItems: ScanItem[] = toAdd.map((f) => ({
      id: `s${++seq}`, name: f.name || 'pièce', mimeType: f.type || 'image/jpeg',
      preview: null, isPdf: f.type === 'application/pdf', status: 'queued',
    }));
    setItems((prev) => [...prev, ...newItems]);
    // Aperçu image (asynchrone, best-effort) + mise en file d'analyse.
    newItems.forEach((it, i) => {
      const file = toAdd[i];
      pending.current.push({ id: it.id, file });
      if (!it.isPdf) readDataUrl(file).then((url) => patch(it.id, { preview: url })).catch(() => {});
    });
    drain();
  };

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs: File[] = e.target.files ? Array.from(e.target.files) : [];
    if (fs.length) addFiles(fs);
    if (inputRef.current) inputRef.current.value = '';
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const fs: File[] = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    if (fs.length) addFiles(fs);
  };

  const removeItem = (id: string) => {
    pending.current = pending.current.filter((p) => p.id !== id);
    setItems((prev) => prev.filter((it) => it.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const resetAll = () => {
    pending.current = [];
    setItems([]); setSelectedId(null); setNotice(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  // Sélection automatique : si l'élément courant n'est plus « à valider »
  // (validé, retiré…), on avance vers la première pièce prête.
  useEffect(() => {
    const cur = items.find((it) => it.id === selectedId);
    if (cur && cur.status === 'ready') return;
    const nextReady = items.find((it) => it.status === 'ready');
    setSelectedId(nextReady ? nextReady.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const selected = items.find((it) => it.id === selectedId) ?? null;
  const counts = {
    ready: items.filter((it) => it.status === 'ready').length,
    analyzing: items.filter((it) => it.status === 'analyzing' || it.status === 'queued').length,
    posted: items.filter((it) => it.status === 'posted').length,
    error: items.filter((it) => it.status === 'error').length,
  };

  const confidencePct = selected?.proposal ? Math.round(selected.proposal.confidence * 100) : 0;
  const confColor = confidencePct >= 75 ? 'text-emerald-400' : confidencePct >= 50 ? 'text-amber-400' : 'text-rose-400';

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      {/* Colonne file d'attente */}
      <div className="space-y-3">
        <div
          onClick={() => inputRef.current?.click()}
          onDrop={onDrop} onDragOver={(e) => e.preventDefault()}
          className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/15 bg-white/5 p-6 text-center transition-colors hover:border-emerald-500/40 hover:bg-white/[0.07]"
        >
          <div className="rounded-full bg-emerald-500/10 p-3 text-emerald-400"><UploadCloud className="h-6 w-6" /></div>
          <p className="mt-3 font-medium text-zinc-200">Déposez vos pièces</p>
          <p className="mt-1 text-xs text-zinc-500">Plusieurs à la fois — JPG, PNG ou PDF (jusqu'à {MAX_BATCH})</p>
        </div>
        <input ref={inputRef} type="file" accept="image/*,application/pdf" multiple onChange={onInput} className="hidden" />

        {notice && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{notice}</p>}

        {items.length > 0 && (
          <>
            <div className="flex items-center justify-between px-1 text-xs text-zinc-500">
              <span>{counts.ready} à valider · {counts.analyzing} en cours · {counts.posted} validée(s){counts.error ? ` · ${counts.error} échec` : ''}</span>
              <button onClick={resetAll} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200"><RotateCcw className="h-3.5 w-3.5" /> Vider</button>
            </div>
            <ul className="space-y-1.5">
              {items.map((it) => {
                const M = STATUS_META[it.status];
                const clickable = it.status === 'ready' || it.status === 'posted' || it.status === 'error';
                return (
                  <li key={it.id}>
                    <button
                      onClick={() => clickable && it.status !== 'posted' && setSelectedId(it.id)}
                      disabled={!clickable}
                      className={`flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${
                        selectedId === it.id ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10 bg-white/5 hover:bg-white/[0.08]'
                      } ${it.status === 'posted' ? 'opacity-60' : ''}`}
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/30 text-zinc-500">
                        {it.preview ? <img src={it.preview} alt="" className="h-full w-full object-cover" /> : <FileText className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-zinc-200">{it.name}</div>
                        <div className={`flex items-center gap-1 text-xs ${M.cls}`}>
                          <M.icon className={`h-3 w-3 ${it.status === 'analyzing' ? 'animate-spin' : ''}`} /> {M.label}
                          {it.status === 'ready' && it.proposal ? ` · ${Math.round(it.proposal.confidence * 100)}%` : ''}
                        </div>
                      </div>
                      {it.status !== 'analyzing' && (
                        <span onClick={(e) => { e.stopPropagation(); removeItem(it.id); }} className="shrink-0 rounded p-1 text-zinc-600 hover:text-rose-400" title="Retirer"><X className="h-3.5 w-3.5" /></span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* Colonne proposition / validation */}
      <div>
        {!selected && counts.analyzing > 0 && (
          <div className="flex h-72 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-center">
            <Loader2 className="h-7 w-7 animate-spin text-emerald-400" />
            <p className="mt-4 font-medium text-zinc-200">Analyse des pièces…</p>
            <p className="mt-1 text-sm text-zinc-500">Les propositions apparaîtront ici dès qu'elles sont prêtes.</p>
          </div>
        )}

        {!selected && counts.analyzing === 0 && items.length > 0 && (
          <div className="flex h-72 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-center text-zinc-400">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="mt-3 font-medium">Lot terminé</p>
            <p className="mt-1 max-w-xs text-sm text-zinc-500">{counts.posted} pièce(s) validée(s){counts.error ? ` · ${counts.error} en échec à revoir` : ''}. Déposez d'autres pièces quand vous voulez.</p>
          </div>
        )}

        {!selected && items.length === 0 && (
          <div className="flex h-72 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-center text-zinc-500">
            <ScanLine className="h-8 w-8" />
            <p className="mt-3 max-w-xs text-sm">Déposez une ou plusieurs pièces : chaque proposition d'écriture apparaîtra ici, à vérifier et valider.</p>
          </div>
        )}

        {selected && selected.status === 'error' && (
          <div className="flex items-start gap-3 rounded-2xl border border-rose-500/20 bg-rose-500/10 p-5 text-rose-300">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">Échec de l'analyse — {selected.name}</p>
              <p className="mt-1 text-sm">{selected.error}</p>
              <button onClick={() => removeItem(selected.id)} className="mt-3 rounded-lg border border-rose-500/30 px-3 py-1.5 text-sm hover:bg-rose-500/10">Retirer du lot</button>
            </div>
          </div>
        )}

        {selected && selected.status === 'ready' && selected.proposal && (
          <motion.div key={selected.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            {selected.preview && !selected.isPdf && (
              <img src={selected.preview} alt="pièce" className="max-h-48 w-full rounded-xl border border-white/10 bg-black/30 object-contain" />
            )}
            <EntryForm
              dossierId={dossierId} fiscalYears={fiscalYears} journals={journals} currency={currency}
              documentUrl={selected.docUrl ?? undefined}
              onPosted={() => { onPosted(); patch(selected.id, { status: 'posted' }); }}
              initial={{ description: selected.proposal.description, entryDate: selected.proposal.entryDate, journalCode: selected.proposal.journalCode, lines: selected.proposal.lines, counterpartyName: selected.proposal.counterpartyName }}
              banner={
                <div className="space-y-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-emerald-300"><Sparkles className="h-4 w-4" /> {selected.name} — à vérifier puis valider</span>
                    <span className={confColor}>confiance {confidencePct}%</span>
                  </div>
                  <div className="text-xs text-zinc-500">moteur : {selected.provider}{selected.proposal.counterpartyName ? ` · tiers : ${selected.proposal.counterpartyName}` : ''}{counts.ready > 1 ? ` · ${counts.ready - 1} autre(s) en attente de validation` : ''}</div>
                  {selected.proposal.warnings?.map((w, i) => (
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
