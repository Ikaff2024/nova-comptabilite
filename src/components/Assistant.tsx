import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, Send, Wrench, User, Lock, PencilLine } from 'lucide-react';
import { api, AGENT_WRITE_TOOLS, type AgentMessage, type AgentStatus, type AgentMode } from '../lib/api';
import { cn } from '../lib/utils';

type Turn = AgentMessage & { tools?: string[] };

const SUGGESTIONS = [
  'Quelle boutique est la plus rentable ce mois-ci ?',
  'Qui me doit de l\'argent depuis plus de 90 jours ?',
  'Où en est ma situation de trésorerie ?',
  'Résume-moi mon compte de résultat.',
];

const TOOL_LABELS: Record<string, string> = {
  situation_generale: 'Tableau de bord', balance_generale: 'Balance', grand_livre: 'Grand livre',
  etats_financiers: 'États financiers', resultat_analytique: 'Analytique', detail_analytique: 'Détail analytique',
  creances_clients: 'Créances clients', dettes_fournisseurs: 'Dettes fournisseurs',
  previsionnel_tresorerie: 'Prévisionnel', tva: 'TVA', factures_ventes: 'Ventes', factures_achats: 'Achats',
  preparer_facture_vente: 'Brouillon facture vente', preparer_facture_achat: 'Brouillon facture achat',
};

export default function Assistant({ dossierId, dossierName }: { dossierId: string; dossierName: string; currency: string }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const enabled = status?.enabled ?? null;
  const mode: AgentMode = status?.mode ?? 'readonly';

  useEffect(() => { api.agentStatus(dossierId).then(setStatus).catch(() => setStatus({ enabled: false, mode: 'readonly', canToggle: false })); }, [dossierId]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [turns, loading]);

  const toggleMode = async () => {
    if (!status?.canToggle) return;
    const next: AgentMode = mode === 'assist' ? 'readonly' : 'assist';
    try { const r = await api.setAgentMode(dossierId, next); setStatus((s) => (s ? { ...s, mode: r.mode } : s)); }
    catch (e: any) { setError(e.message); }
  };

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || loading) return;
    setError(null);
    const history: AgentMessage[] = [...turns.map((t) => ({ role: t.role, content: t.content })), { role: 'user', content: q }];
    setTurns((ts) => [...ts, { role: 'user', content: q }]);
    setInput(''); setLoading(true);
    try {
      const r = await api.agentChat(dossierId, history);
      setTurns((ts) => [...ts, { role: 'assistant', content: r.reply, tools: r.toolCalls.map((c) => c.name) }]);
    } catch (e: any) {
      setError(e.message);
      setTurns((ts) => [...ts, { role: 'assistant', content: 'Désolé, je n\'ai pas pu répondre. ' + (e.message ?? '') }]);
    } finally { setLoading(false); }
  };

  if (enabled === false) {
    return (
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-6 text-sm text-amber-200">
        <div className="mb-2 flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4" /> Assistant IA non activé</div>
        L'assistant nécessite une clé <span className="font-mono">ANTHROPIC_API_KEY</span> côté serveur. Ajoutez-la dans les variables d'environnement pour l'activer.
      </div>
    );
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-2xl border border-white/10 bg-white/5">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15"><Sparkles className="h-4.5 w-4.5 text-emerald-400" /></div>
        <div>
          <div className="text-sm font-semibold text-zinc-100">Assistant comptable</div>
          <div className="text-xs text-zinc-500">Pilotez {dossierName} en langage naturel</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium', mode === 'assist' ? 'bg-amber-500/15 text-amber-300' : 'bg-white/10 text-zinc-400')}>
            {mode === 'assist' ? <PencilLine className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {mode === 'assist' ? 'Assisté (brouillons)' : 'Lecture seule'}
          </span>
          {status?.canToggle && (
            <button onClick={toggleMode} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/10">
              {mode === 'assist' ? 'Repasser en lecture seule' : 'Activer le mode assisté'}
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400">Posez une question sur votre comptabilité. Quelques idées :</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(mode === 'assist' ? [...SUGGESTIONS, 'Prépare un brouillon de facture pour le client Awa : 2 jours de conseil à 150 000.'] : SUGGESTIONS).map((s) => (
                <button key={s} onClick={() => ask(s)} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-left text-sm text-zinc-300 hover:border-emerald-500/40 hover:bg-emerald-500/[0.06]">{s}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={cn('flex gap-3', t.role === 'user' ? 'justify-end' : 'justify-start')}>
            {t.role === 'assistant' && <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15"><Sparkles className="h-4 w-4 text-emerald-400" /></div>}
            <div className={cn('max-w-[80%] space-y-1.5')}>
              {t.tools && t.tools.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {[...new Set(t.tools)].map((name: string) => {
                    const isWrite = AGENT_WRITE_TOOLS.has(name);
                    return (
                      <span key={name} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]', isWrite ? 'bg-amber-500/15 text-amber-300' : 'bg-white/5 text-zinc-400')}>
                        {isWrite ? <PencilLine className="h-3 w-3" /> : <Wrench className="h-3 w-3" />} {TOOL_LABELS[name] ?? name}
                      </span>
                    );
                  })}
                </div>
              )}
              <div className={cn('whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm', t.role === 'user' ? 'bg-emerald-500 text-zinc-950' : 'bg-zinc-900/70 text-zinc-200')}>{t.content}</div>
            </div>
            {t.role === 'user' && <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10"><User className="h-4 w-4 text-zinc-300" /></div>}
          </div>
        ))}
        {loading && (
          <div className="flex gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15"><Sparkles className="h-4 w-4 text-emerald-400" /></div>
            <div className="flex items-center gap-2 rounded-2xl bg-zinc-900/70 px-3.5 py-2.5 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Analyse en cours…</div>
          </div>
        )}
      </div>

      {error && <p className="mx-4 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400">{error}</p>}

      <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="flex items-center gap-2 border-t border-white/10 p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} disabled={enabled === null || loading}
          placeholder="Posez votre question…"
          className="flex-1 rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-2.5 text-sm outline-none focus:border-emerald-500/50 disabled:opacity-50" />
        <button type="submit" disabled={!input.trim() || loading} className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
      <p className="px-4 pb-3 text-center text-[11px] text-zinc-600">{mode === 'assist' ? 'Mode assisté : l\'assistant peut préparer des brouillons — rien n\'est comptabilisé sans votre validation dans les onglets dédiés.' : 'Lecture seule : l\'assistant lit vos données mais ne saisit rien. Vérifiez toujours avant décision.'}</p>
    </div>
  );
}
