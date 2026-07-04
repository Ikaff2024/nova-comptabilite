import React, { useEffect, useState } from 'react';
import { Loader2, FileSpreadsheet, Printer, Lock, CheckCircle2, AlertTriangle, Paperclip, FileDown } from 'lucide-react';
import { api, fmtMoney, fetchDocumentUrl, downloadAuthed, type Journal, type FiscalYear, type JournalLine } from '../lib/api';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

interface Entry { entry_id: string; piece_ref: string | null; entry_date: string; entry_description: string; journal_code: string; document_url: string | null; lines: JournalLine[]; debit: number; credit: number; }

function group(lines: JournalLine[]): Entry[] {
  const out: Entry[] = []; let cur: Entry | null = null;
  for (const l of lines) {
    if (!cur || cur.entry_id !== l.entry_id) { cur = { entry_id: l.entry_id, piece_ref: l.piece_ref, entry_date: l.entry_date, entry_description: l.entry_description, journal_code: l.journal_code, document_url: l.document_url, lines: [], debit: 0, credit: 0 }; out.push(cur); }
    cur.lines.push(l); cur.debit += l.debit; cur.credit += l.credit;
  }
  return out;
}

async function openDocument(url: string) {
  try { const o = await fetchDocumentUrl(url); window.open(o, '_blank', 'noopener'); }
  catch { alert('Pièce jointe inaccessible.'); }
}

export default function Journaux({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);
  const [journal, setJournal] = useState('');
  const [fy, setFy] = useState('');
  const [lines, setLines] = useState<JournalLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadStructures = async () => {
    const [js, fys] = await Promise.all([api.journals(dossierId), api.fiscalYears(dossierId)]);
    setJournals(js); setFiscalYears(fys);
    if (!fy && fys[0]) setFy(fys[0].id);
  };
  useEffect(() => { loadStructures(); }, [dossierId]);

  const load = async () => { setLoading(true); try { setLines(await api.journalEntries(dossierId, { journal: journal || undefined, fiscalYearId: fy || undefined })); } finally { setLoading(false); } };
  useEffect(() => { if (fy || journals.length) load(); }, [journal, fy]);

  const entries = group(lines);

  const close = async (fyId: string, label: string) => {
    if (!confirm(`Clôturer « ${label} » ? Les soldes de bilan seront reportés en à-nouveaux dans l'exercice suivant, et l'exercice sera verrouillé.`)) return;
    setClosing(true); setErr(null); setMsg(null);
    try {
      const r = await api.closeExercise(dossierId, fyId);
      setMsg(`Exercice clôturé. Résultat reporté : ${fmtMoney(r.resultat, currency)}. À-nouveaux générés dans le nouvel exercice.`);
      await loadStructures(); await load();
    } catch (e: any) { setErr(e.message); } finally { setClosing(false); }
  };

  const exportCsv = () => {
    const out: (string | number)[][] = [['Pièce', 'Date', 'Journal', 'Compte', 'Libellé', 'Débit', 'Crédit']];
    for (const e of entries) for (const l of e.lines) out.push([e.piece_ref ?? '', l.entry_date, l.journal_code, l.account_code, l.label, l.debit || '', l.credit || '']);
    downloadCsv(`journal_${journal || 'tous'}_${dossierName}`.replace(/\s+/g, '-'), out);
  };
  const exportPdf = () => {
    const body = entries.map((e) => `
      <table><thead>
        <tr class="grp"><td colspan="4">${e.piece_ref ?? ''} · ${e.entry_date} · ${(e.entry_description ?? '').replace(/[&<>]/g, '')}</td></tr>
        <tr><th>Compte</th><th>Libellé</th><th class="n">Débit</th><th class="n">Crédit</th></tr></thead><tbody>
        ${e.lines.map((l) => `<tr><td>${l.account_code}</td><td>${(l.label ?? '').replace(/[&<>]/g, '')}</td><td class="n">${l.debit ? fmtMoney(l.debit, currency) : ''}</td><td class="n">${l.credit ? fmtMoney(l.credit, currency) : ''}</td></tr>`).join('')}
        <tr class="tot"><td colspan="2">Total pièce</td><td class="n">${fmtMoney(e.debit, currency)}</td><td class="n">${fmtMoney(e.credit, currency)}</td></tr>
      </tbody></table><br/>`).join('');
    printDocument(`Journal ${journal || '(tous)'} — ${dossierName}`, `au ${nowStamp()} · devise ${currency}`, body);
  };

  return (
    <div className="space-y-5">
      {/* Clôture d'exercice */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-200"><Lock className="h-4 w-4 text-amber-400" /> Clôture d'exercice</div>
        <div className="flex flex-wrap gap-2">
          {fiscalYears.map((f) => (
            <div key={f.id} className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/5 px-3 py-1.5 text-sm">
              <span className="text-zinc-300">{f.label}</span>
              {f.status === 'closed'
                ? <span className="flex items-center gap-1 text-xs text-zinc-500"><Lock className="h-3 w-3" /> clôturé</span>
                : <button onClick={() => close(f.id, f.label)} disabled={closing} className="text-xs font-medium text-amber-400 hover:text-amber-300 disabled:opacity-50">clôturer →</button>}
            </div>
          ))}
        </div>
        {msg && <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}
        {err && <p className="mt-3 flex items-center gap-1.5 text-sm text-rose-400"><AlertTriangle className="h-4 w-4" /> {err}</p>}
      </div>

      {/* Consultation par journal */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <select value={journal} onChange={(e) => setJournal(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
            <option value="">Tous les journaux</option>
            {journals.map((j) => <option key={j.id} value={j.code}>{j.code} · {j.label}</option>)}
          </select>
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
            {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={exportCsv} disabled={!entries.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><FileSpreadsheet className="h-4 w-4" /> Excel/CSV</button>
          <button onClick={() => downloadAuthed(`/api/dossiers/${dossierId}/fec${fy ? `?fiscalYearId=${fy}` : ''}`, `FEC_${dossierName}.txt`.replace(/\s+/g, '-'))} title="Fichier des Écritures Comptables (format standard)" className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><FileDown className="h-4 w-4" /> FEC</button>
          <button onClick={exportPdf} disabled={!entries.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><Printer className="h-4 w-4" /> PDF</button>
        </div>
      </div>

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : entries.length === 0 ? <p className="text-zinc-400">Aucune écriture.</p> : (
        <div className="space-y-3">
          {entries.map((e) => (
            <div key={e.entry_id} className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2 text-sm">
                <span className="font-mono text-emerald-400">{e.piece_ref}<span className="ml-3 font-sans text-zinc-400">{e.entry_date} · {e.entry_description}</span></span>
                <span className="flex items-center gap-3">
                  {e.document_url && <button onClick={() => openDocument(e.document_url!)} title="Voir la pièce jointe" className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300"><Paperclip className="h-3.5 w-3.5" /> pièce</button>}
                  <span className="font-mono text-xs text-zinc-500">{e.journal_code}</span>
                </span>
              </div>
              <table className="w-full text-left text-sm">
                <tbody className="divide-y divide-white/5 font-mono">
                  {e.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-4 py-1.5 text-zinc-400">{l.account_code}</td>
                      <td className="px-4 py-1.5 font-sans text-zinc-300">{l.label}</td>
                      <td className="px-4 py-1.5 text-right text-zinc-300">{l.debit ? fmtMoney(l.debit, currency) : ''}</td>
                      <td className="px-4 py-1.5 text-right text-zinc-300">{l.credit ? fmtMoney(l.credit, currency) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
