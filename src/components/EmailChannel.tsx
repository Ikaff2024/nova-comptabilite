import React, { useEffect, useState } from 'react';
import { Loader2, Send, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';

// Diagnostic du canal email. Toutes les fonctions qui écrivent à quelqu'un
// (invitations, bulletins aux salariés, dossier de financement, veille) passent
// par ce canal : pouvoir le tester en un clic évite de deviner.

export default function EmailChannel() {
  const [st, setSt] = useState<{ enabled: boolean; from: string; testSender: boolean } | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.emailStatus().then(setSt).catch(() => setSt(null)); }, []);

  const test = async () => {
    setBusy(true); setOk(null); setError(null);
    try {
      const r = await api.emailTest(to.trim() || undefined);
      setOk(`Email envoyé à ${r.to} depuis « ${r.from} ». Vérifiez la réception (et les indésirables).`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (!st) return null;
  const input = 'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50';

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Send className="h-4 w-4 text-emerald-400" /> Canal email</div>
      <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
        {!st.enabled ? (
          <p className="text-sm text-amber-300">Aucune clé d'envoi configurée côté serveur : les invitations, bulletins et digests ne partiront pas.</p>
        ) : (
          <>
            <p className="text-sm text-zinc-300">Expéditeur utilisé : <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">{st.from}</code></p>
            {st.testSender && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Vous êtes encore sur l'adresse de <strong>test</strong> du fournisseur : les emails ne partent qu'au titulaire du compte d'envoi.
                  Vérifiez votre domaine chez le fournisseur, puis définissez <code>EMAIL_FROM</code> sur une adresse de ce domaine.
                </span>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[16rem] flex-1">
                <label className="mb-1 block text-xs text-zinc-500">Envoyer un test à <span className="text-zinc-600">(vide = votre adresse)</span></label>
                <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="vous@exemple.ci" className={input} />
              </div>
              <button onClick={test} disabled={busy}
                className="flex h-[38px] items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 text-sm font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer un test
              </button>
            </div>
            {ok && <p className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{ok}</p>}
            {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
          </>
        )}
      </div>
    </section>
  );
}
