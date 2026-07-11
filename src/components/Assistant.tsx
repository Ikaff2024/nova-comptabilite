import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, Send, Wrench, User, Lock, PencilLine, Mic, Volume2, VolumeX } from 'lucide-react';
import { api, AGENT_WRITE_TOOLS, AGENT_MODE_LABELS, type AgentMessage, type AgentStatus, type AgentMode } from '../lib/api';
import { cn } from '../lib/utils';

type Turn = AgentMessage & { tools?: string[] };

// --- Vocal : dictée (STT) + lecture (TTS) via l'API navigateur, sans dépendance ---
const SpeechRec: any = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
const STT_OK = !!SpeechRec;
const TTS_OK = typeof window !== 'undefined' && 'speechSynthesis' in window;
// Rend le texte plus naturel à lire (retire markdown, transforme les tableaux en énoncés).
const forSpeech = (s: string) => s
  .replace(/\*\*/g, '').replace(/^#{1,4}\s+/gm, '').replace(/^\s*[-•]\s+/gm, '')
  .replace(/\|/g, ', ').replace(/[_`>]/g, '').replace(/\n{2,}/g, '. ').replace(/[ \t]{2,}/g, ' ').trim();

// --- Rendu markdown léger (gras, titres, listes, tableaux) — sans dépendance ---
function inlineMd(s: string): React.ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <React.Fragment key={i}>{p}</React.Fragment>);
}

function RichText({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  const isTable = (l: string) => l.trim().startsWith('|');
  const isBullet = (l: string) => /^\s*[-•]\s+/.test(l);
  const isHead = (l: string) => /^#{1,4}\s/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (isTable(line)) {
      const tbl: string[] = [];
      while (i < lines.length && isTable(lines[i])) { tbl.push(lines[i]); i++; }
      const rows = tbl.map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const hasHeader = rows[1] && rows[1].every((c) => /^:?-{2,}:?$/.test(c));
      const header = hasHeader ? rows[0] : null;
      const body = rows.slice(hasHeader ? 2 : 0);
      blocks.push(
        <div key={blocks.length} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            {header && <thead><tr>{header.map((c, j) => <th key={j} className="border border-white/10 px-2 py-1 text-left font-semibold text-zinc-200">{inlineMd(c)}</th>)}</tr></thead>}
            <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-white/10 px-2 py-1 text-zinc-300">{inlineMd(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (isBullet(line)) {
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i])) { items.push(lines[i].replace(/^\s*[-•]\s+/, '')); i++; }
      blocks.push(<ul key={blocks.length} className="my-1 list-disc space-y-0.5 pl-5">{items.map((it, ii) => <li key={ii}>{inlineMd(it)}</li>)}</ul>);
      continue;
    }
    if (isHead(line)) { blocks.push(<div key={blocks.length} className="mb-0.5 mt-2 font-semibold text-zinc-100">{inlineMd(line.replace(/^#{1,4}\s/, ''))}</div>); i++; continue; }
    if (line.trim() === '') { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isTable(lines[i]) && !isBullet(lines[i]) && !isHead(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(<p key={blocks.length}>{para.map((p, pi) => <React.Fragment key={pi}>{inlineMd(p)}{pi < para.length - 1 ? <br /> : null}</React.Fragment>)}</p>);
  }
  return <div className="space-y-1">{blocks}</div>;
}

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
  lettrer_automatiquement: 'Lettrage automatique', preparer_relance_client: 'Relance client',
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

  // Vocal
  const [listening, setListening] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const recRef = useRef<any>(null);

  useEffect(() => { api.agentStatus(dossierId).then(setStatus).catch(() => setStatus({ enabled: false, mode: 'readonly', canToggle: false })); }, [dossierId]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [turns, loading]);
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* ignore */ } if (TTS_OK) window.speechSynthesis.cancel(); }, []);

  const speak = (text: string) => {
    if (!TTS_OK) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(forSpeech(text));
    u.lang = 'fr-FR'; u.rate = 1.03;
    window.speechSynthesis.speak(u);
  };
  const toggleSpeak = () => setSpeakOn((s) => { if (s && TTS_OK) window.speechSynthesis.cancel(); return !s; });

  const toggleMic = () => {
    if (!STT_OK) return;
    if (listening) { try { recRef.current?.stop(); } catch { /* ignore */ } return; }
    const rec = new SpeechRec();
    rec.lang = 'fr-FR'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    rec.onresult = (e: any) => setInput(Array.from(e.results).map((r: any) => r[0].transcript).join(''));
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setInput(''); setError(null);
    try { rec.start(); setListening(true); } catch { setListening(false); }
  };

  const changeMode = async (next: AgentMode) => {
    if (!status?.canToggle || next === mode) return;
    try { const r = await api.setAgentMode(dossierId, next); setStatus((s) => (s ? { ...s, mode: r.mode } : s)); }
    catch (e: any) { setError(e.message); }
  };

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || loading) return;
    setError(null);
    try { recRef.current?.stop(); } catch { /* ignore */ }
    if (TTS_OK) window.speechSynthesis.cancel();
    const history: AgentMessage[] = [...turns.map((t) => ({ role: t.role, content: t.content })), { role: 'user', content: q }];
    setTurns((ts) => [...ts, { role: 'user', content: q }]);
    setInput(''); setLoading(true);
    try {
      const r = await api.agentChat(dossierId, history);
      setTurns((ts) => [...ts, { role: 'assistant', content: r.reply, tools: r.toolCalls.map((c) => c.name) }]);
      if (speakOn) speak(r.reply);
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
          {TTS_OK && (
            <button onClick={toggleSpeak} title={speakOn ? 'Couper la lecture vocale' : 'Lire les réponses à voix haute'}
              className={cn('flex h-7 w-7 items-center justify-center rounded-lg border', speakOn ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200')}>
              {speakOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          )}
          {status?.canToggle ? (
            <select value={mode} onChange={(e) => changeMode(e.target.value as AgentMode)} title="Niveau de pouvoir de l'assistant (admin)"
              className={cn('rounded-lg border px-2.5 py-1 text-xs outline-none', mode === 'readonly' ? 'border-white/10 bg-white/5 text-zinc-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-200')}>
              <option value="readonly">Lecture seule</option>
              <option value="assist">Assisté (brouillons)</option>
              <option value="assist_plus">Assisté + actions</option>
            </select>
          ) : (
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium', mode === 'readonly' ? 'bg-white/10 text-zinc-400' : 'bg-amber-500/15 text-amber-300')}>
              {mode === 'readonly' ? <Lock className="h-3.5 w-3.5" /> : <PencilLine className="h-3.5 w-3.5" />} {AGENT_MODE_LABELS[mode]}
            </span>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400">Posez une question sur votre comptabilité. Quelques idées :</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(mode === 'readonly' ? SUGGESTIONS
                : mode === 'assist' ? [...SUGGESTIONS, 'Prépare un brouillon de facture pour le client Awa : 2 jours de conseil à 150 000.']
                : [...SUGGESTIONS, 'Prépare un brouillon de facture pour le client Awa : 2 jours de conseil à 150 000.', 'Lettre automatiquement les règlements des clients.']).map((s) => (
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
              <div className={cn('rounded-2xl px-3.5 py-2.5 text-sm', t.role === 'user' ? 'whitespace-pre-wrap bg-emerald-500 text-zinc-950' : 'bg-zinc-900/70 text-zinc-200')}>{t.role === 'assistant' ? <RichText text={t.content} /> : t.content}</div>
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
          placeholder={listening ? 'Parlez… je vous écoute' : 'Posez votre question…'}
          className="flex-1 rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-2.5 text-sm outline-none focus:border-emerald-500/50 disabled:opacity-50" />
        {STT_OK && (
          <button type="button" onClick={toggleMic} disabled={loading} title={listening ? 'Arrêter la dictée' : 'Dicter votre question'}
            className={cn('flex h-10 w-10 items-center justify-center rounded-xl border transition-colors disabled:opacity-40', listening ? 'animate-pulse border-rose-500/50 bg-rose-500/20 text-rose-300' : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10')}>
            <Mic className="h-4 w-4" />
          </button>
        )}
        <button type="submit" disabled={!input.trim() || loading} className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
      <p className="px-4 pb-3 text-center text-[11px] text-zinc-600">{mode === 'readonly' ? 'Lecture seule : l\'assistant lit vos données mais ne saisit rien. Vérifiez toujours avant décision.' : mode === 'assist' ? 'Mode assisté : l\'assistant peut préparer des brouillons — rien n\'est comptabilisé sans votre validation dans les onglets dédiés.' : 'Assisté + actions : brouillons et actions réversibles (lettrage, relances) — jamais d\'écriture au grand livre sans votre validation.'}</p>
    </div>
  );
}
