import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Hexagon, ScanLine, Smartphone, FileText, ShieldCheck, Loader2, ArrowRight, Sparkles, X } from 'lucide-react';
import { api } from '../lib/api';
import { setWelcomed } from '../lib/session';

const SLIDES = [
  {
    icon: ScanLine, color: 'text-emerald-400 bg-emerald-500/10',
    title: 'Photographiez, Nova comptabilise',
    text: "Prenez en photo un reçu ou une facture. L'écriture SYSCOHADA est proposée automatiquement — compte, TVA, tiers. Vous n'avez plus qu'à vérifier.",
  },
  {
    icon: Smartphone, color: 'text-sky-400 bg-sky-500/10',
    title: 'Votre Mobile Money, réconcilié',
    text: 'Importez un relevé Wave, Orange Money ou MTN : chaque mouvement devient une écriture pré-catégorisée, sans double saisie.',
  },
  {
    icon: FileText, color: 'text-violet-400 bg-violet-500/10',
    title: 'Vos états en un clic',
    text: 'Balance, compte de résultat, soldes intermédiaires de gestion, bilan — générés en temps réel et exportables en PDF.',
  },
  {
    icon: ShieldCheck, color: 'text-amber-400 bg-amber-500/10',
    title: 'Vous gardez le contrôle',
    text: "L'IA propose, mais rien n'est enregistré sans votre validation. Vous restez le comptable — Nova supprime juste la saisie fastidieuse.",
  },
];

export default function WelcomeGuide({ onClose, onDemo }: { onClose: () => void; onDemo: (dossierId: string) => void }) {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = step === SLIDES.length - 1;

  const dismiss = () => { setWelcomed(); onClose(); };

  const tryDemo = async () => {
    setLoading(true); setError(null);
    try { const { dossierId } = await api.seedDemo(); setWelcomed(); onDemo(dossierId); }
    catch (e: any) { setError(e.message); setLoading(false); }
  };

  const s = SLIDES[step];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <motion.div initial={{ opacity: 0, scale: 0.96, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 p-8 text-zinc-50">
        <button onClick={dismiss} className="absolute right-4 top-4 text-zinc-500 hover:text-zinc-300"><X className="h-5 w-5" /></button>

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20">
            <Hexagon className="h-6 w-6 text-zinc-950" fill="currentColor" />
          </div>
          <div>
            <div className="font-display text-lg font-bold">Bienvenue sur Nova</div>
            <div className="text-xs text-zinc-400">La comptabilité OHADA, en douceur</div>
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.25 }}
            className="mt-8 min-h-[150px]">
            <div className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl ${s.color}`}><s.icon className="h-7 w-7" /></div>
            <h2 className="mt-5 font-display text-2xl font-bold tracking-tight">{s.title}</h2>
            <p className="mt-2 text-zinc-400">{s.text}</p>
          </motion.div>
        </AnimatePresence>

        {/* points */}
        <div className="mt-6 flex items-center gap-2">
          {SLIDES.map((_, i) => (
            <button key={i} onClick={() => setStep(i)}
              className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-emerald-400' : 'w-1.5 bg-white/20'}`} />
          ))}
        </div>

        {error && <p className="mt-4 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

        <div className="mt-6 text-center">
          <a href="/guide.html" target="_blank" rel="noopener" className="text-sm text-emerald-400 underline-offset-2 hover:underline">Ouvrir le guide complet, module par module →</a>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button onClick={dismiss} className="text-sm text-zinc-400 hover:text-zinc-200">Je démarre moi-même</button>
          {last ? (
            <button onClick={tryDemo} disabled={loading}
              className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Essayer avec un dossier de démo
            </button>
          ) : (
            <button onClick={() => setStep((s2) => s2 + 1)}
              className="flex items-center gap-2 rounded-lg bg-white/10 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/20">
              Suivant <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
