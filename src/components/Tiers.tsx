import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Link2, Unlink, CalendarClock, FileSpreadsheet, Printer, CheckCircle2, BookUser, Scale, Library, Plus, Trash2, Wand2, BellRing, Send, FolderOpen, Mail, Hash, Building2, FileText } from 'lucide-react';
import { api, fmtMoney, downloadAuthed, type TiersAccount, type OpenItem, type LetteredItem, type AgedRow, type Counterparty, type AuxBalanceRow, type AuxLedgerRow, type OverdueClient } from '../lib/api';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';

type View = 'fiche' | 'plan' | 'balance' | 'grandlivre' | 'lettrage' | 'aged' | 'relances';

export default function Tiers({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [view, setView] = useState<View>('fiche');
  const tabs: [View, string, any][] = [
    ['fiche', 'Dossiers tiers', FolderOpen], ['plan', 'Plan tiers', BookUser], ['balance', 'Balance', Scale], ['grandlivre', 'Grand livre', Library],
    ['lettrage', 'Lettrage', Link2], ['aged', 'Balance âgée', CalendarClock], ['relances', 'Relances', BellRing],
  ];
  return (
    <div className="space-y-5">
      <div className="inline-flex flex-wrap rounded-lg border border-white/10 bg-white/5 p-0.5 text-sm">
        {tabs.map(([id, label, Icon]) => (
          <button key={id} onClick={() => setView(id)}
            className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors', view === id ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
      {view === 'fiche' && <FicheTiers dossierId={dossierId} dossierName={dossierName} currency={currency} />}
      {view === 'plan' && <PlanTiers dossierId={dossierId} />}
      {view === 'balance' && <BalanceTiers dossierId={dossierId} dossierName={dossierName} currency={currency} />}
      {view === 'grandlivre' && <GrandLivreTiers dossierId={dossierId} dossierName={dossierName} currency={currency} />}
      {view === 'lettrage' && <Lettrage dossierId={dossierId} currency={currency} />}
      {view === 'aged' && <Aged dossierId={dossierId} dossierName={dossierName} currency={currency} />}
      {view === 'relances' && <Relances dossierId={dossierId} dossierName={dossierName} currency={currency} />}
    </div>
  );
}

function Relances({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [rows, setRows] = useState<OverdueClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => { setLoading(true); try { setRows(await api.overdueClients(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);
  const m = (n: number) => fmtMoney(n, currency);

  const relancer = async (r: OverdueClient) => {
    setBusy(r.counterpartyId); setMsg(null);
    try {
      const L = await api.relanceLetter(dossierId, r.counterpartyId);
      const rows = L.open.map((o) => `<tr><td>${o.date}</td><td>${o.piece_ref ?? ''}</td><td>${(o.label ?? '').replace(/[&<>]/g, '')}</td><td class="n">${o.age} j</td><td class="n">${m(o.amount)}</td></tr>`).join('');
      const niveau = L.suggestedLevel === 1 ? '1re relance' : L.suggestedLevel === 2 ? '2e relance' : L.suggestedLevel >= 3 ? 'Mise en demeure' : `Relance ${L.suggestedLevel}`;
      const body = `
        <p>À l'attention de <b>${(L.name ?? '').replace(/[&<>]/g, '')}</b>${L.auxCode ? ` (${L.auxCode})` : ''}</p>
        <p>Objet : <b>${niveau}</b> — sommes échues au ${L.asOf}</p>
        <p>Sauf erreur ou règlement de votre part, notre comptabilité fait apparaître les factures suivantes restées impayées :</p>
        <table><thead><tr><th>Date</th><th>Pièce</th><th>Libellé</th><th class="n">Ancienneté</th><th class="n">Montant</th></tr></thead>
        <tbody>${rows}<tr class="tot"><td colspan="4">Total dû</td><td class="n">${m(L.total)}</td></tr></tbody></table>
        <p>Nous vous remercions de bien vouloir procéder au règlement dans les meilleurs délais. Pour toute question, n'hésitez pas à nous contacter.</p>
        <p style="margin-top:24px">${dossierName}</p>`;
      printDocument(`${niveau} — ${L.name}`, `${dossierName} · édité le ${nowStamp()}`, body);
      await api.recordRelance(dossierId, r.counterpartyId, { level: L.suggestedLevel, amount: L.total });
      setMsg(`Relance niveau ${L.suggestedLevel} enregistrée pour ${L.name}.`);
      await load();
    } catch (e: any) { setMsg(e.message); } finally { setBusy(null); }
  };

  const levelLabel = (n: number) => n === 0 ? '—' : n === 1 ? '1re' : n === 2 ? '2e' : n >= 3 ? 'MED' : `${n}`;
  const total = rows.reduce((s, r) => s + r.balance, 0);
  const overdue90 = rows.reduce((s, r) => s + Math.max(r.b90_plus, 0), 0);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Analyse des créances…</div>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4"><div className="text-sm text-zinc-400">Clients à relancer</div><div className="mt-1 font-mono text-2xl font-bold text-zinc-100">{rows.length}</div></div>
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4"><div className="text-sm text-zinc-400">Créances ouvertes</div><div className="mt-1 font-mono text-2xl font-bold text-zinc-100">{m(total)}</div></div>
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"><div className="text-sm text-zinc-400">Dont +90 jours</div><div className="mt-1 font-mono text-2xl font-bold text-amber-400">{m(overdue90)}</div></div>
      </div>
      {msg && <p className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {msg}</p>}

      {rows.length === 0 ? <p className="text-sm text-zinc-500">Aucune créance client échue. 🎉</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-3 font-medium">Client</th><th className="px-4 py-3 text-right font-medium">Solde dû</th>
              <th className="px-4 py-3 text-right font-medium">+90 j</th><th className="px-4 py-3 text-right font-medium">Ancienneté</th>
              <th className="px-4 py-3 text-center font-medium">Dernière relance</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.counterpartyId} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-zinc-200">{r.name}<span className="ml-2 font-mono text-xs text-zinc-500">{r.auxCode}</span></td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-100">{m(r.balance)}</td>
                  <td className={cn('px-4 py-2.5 text-right font-mono', r.b90_plus > 0 ? 'text-amber-400' : 'text-zinc-500')}>{r.b90_plus > 0 ? m(r.b90_plus) : '—'}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{r.oldestAge} j</td>
                  <td className="px-4 py-2.5 text-center">{r.lastLevel > 0 ? <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-zinc-300">{levelLabel(r.lastLevel)} · {r.lastSentAt}</span> : <span className="text-xs text-zinc-600">jamais</span>}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => relancer(r)} disabled={busy === r.counterpartyId} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40">{busy === r.counterpartyId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Relancer</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-zinc-500">« Relancer » génère la lettre (PDF à imprimer / enregistrer) et enregistre le niveau de relance. Le niveau s'incrémente à chaque relance (1re → 2e → mise en demeure).</p>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = { client: 'Client', fournisseur: 'Fournisseur', salarie: 'Salarié', etat: 'État', autre: 'Autre' };

// Fiche consolidée d'un tiers (le « dossier » client/fournisseur) : identité,
// soldes, et grand livre auxiliaire avec solde progressif — le tout en une vue.
function FicheTiers({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [tiers, setTiers] = useState<Counterparty[]>([]);
  const [type, setType] = useState('');
  const [cid, setCid] = useState('');
  const [rows, setRows] = useState<AuxLedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const m = (n: number) => fmtMoney(n, currency);

  useEffect(() => { (async () => { const t = await api.counterparties(dossierId); setTiers(t); })(); }, [dossierId]);
  useEffect(() => { if (!cid) { setRows([]); return; } (async () => { setLoading(true); try { setRows(await api.auxLedger(dossierId, cid)); } finally { setLoading(false); } })(); }, [cid, dossierId]);

  const list = type ? tiers.filter((t) => t.type === type) : tiers;
  const tp = tiers.find((t) => t.id === cid);

  let solde = 0;
  const withSolde = rows.map((r) => { solde += r.debit - r.credit; return { ...r, solde }; });
  const totDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totCredit = rows.reduce((s, r) => s + r.credit, 0);
  const balance = totDebit - totCredit;
  const isSupplier = tp?.type === 'fournisseur';
  // Un solde débiteur = le client doit ; créditeur = on doit au fournisseur.
  const soldeLabel = balance === 0 ? 'Soldé' : isSupplier ? (balance < 0 ? 'À payer' : 'Avance/avoir') : (balance > 0 ? 'À recevoir' : 'Avance/avoir');

  const exportPdf = () => {
    if (!tp) return;
    const body = `
      <table style="margin-bottom:12px"><tbody>
        <tr><td><b>DOSSIER ${TYPE_LABEL[tp.type]?.toUpperCase() ?? ''} — ${(tp.name ?? '').replace(/[&<>]/g, '')}</b></td><td class="n">${tp.aux_code ?? ''}</td></tr>
        ${tp.tax_id ? `<tr><td>Id. fiscal : ${tp.tax_id}</td><td></td></tr>` : ''}
        ${tp.email ? `<tr><td>Email : ${tp.email}</td><td></td></tr>` : ''}
        <tr><td>Solde : <b>${m(balance)}</b> (${soldeLabel})</td><td class="n">au ${nowStamp()}</td></tr>
      </tbody></table>
      <table><thead><tr><th>Date</th><th>Jrnl</th><th>Cpte</th><th>Libellé</th><th class="n">Débit</th><th class="n">Crédit</th><th class="n">Solde</th></tr></thead><tbody>
      ${withSolde.map((r) => `<tr><td>${r.entry_date}</td><td>${r.journal_code}</td><td>${r.account_code}</td><td>${(r.label ?? '').replace(/[&<>]/g, '')}</td><td class="n">${r.debit ? m(r.debit) : ''}</td><td class="n">${r.credit ? m(r.credit) : ''}</td><td class="n">${m(r.solde)}</td></tr>`).join('')}
      </tbody></table>`;
    printDocument(`Dossier tiers — ${tp.name}`, `${dossierName} · ${tp.aux_code ?? ''} · au ${nowStamp()}`, body);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select value={type} onChange={(e) => { setType(e.target.value); setCid(''); }} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
          <option value="">Tous les tiers</option><option value="client">Clients</option><option value="fournisseur">Fournisseurs</option><option value="salarie">Salariés</option>
        </select>
        <select value={cid} onChange={(e) => setCid(e.target.value)} className="min-w-[16rem] flex-1 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
          <option value="">— Choisir un tiers —</option>
          {list.map((t) => <option key={t.id} value={t.id}>{t.aux_code} · {t.name}</option>)}
        </select>
        {tp && <button onClick={() => downloadAuthed(`/api/dossiers/${dossierId}/tiers/${tp.id}/statement`, `releve-${tp.aux_code || tp.name}.pdf`)} disabled={!withSolde.length} className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"><FileText className="h-4 w-4" /> Relevé de compte</button>}
        {tp && <button onClick={exportPdf} disabled={!withSolde.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><Printer className="h-4 w-4" /> PDF</button>}
      </div>

      {!tp ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-zinc-500">Sélectionnez un client ou un fournisseur pour ouvrir son dossier (identité, soldes et mouvements).</div>
      ) : (
        <>
          {/* Identité + KPIs */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15"><Building2 className="h-5 w-5 text-emerald-400" /></div>
                  <div>
                    <div className="font-display text-lg font-semibold text-zinc-100">{tp.name}</div>
                    <div className="text-xs text-zinc-500">{TYPE_LABEL[tp.type] ?? tp.type}{tp.collective ? ` · compte collectif ${tp.collective}` : ''}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-400">
                  <span className="inline-flex items-center gap-1"><Hash className="h-3.5 w-3.5" /> {tp.aux_code}</span>
                  {tp.tax_id && <span className="inline-flex items-center gap-1"><BookUser className="h-3.5 w-3.5" /> {tp.tax_id}</span>}
                  {tp.email && <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" /> {tp.email}</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase text-zinc-500">Solde</div>
                <div className={cn('font-mono text-2xl font-bold', balance === 0 ? 'text-zinc-300' : isSupplier ? 'text-rose-400' : 'text-emerald-400')}>{m(Math.abs(balance))}</div>
                <div className="text-xs text-zinc-500">{soldeLabel}</div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/10 pt-4 text-sm">
              <div><div className="text-xs text-zinc-500">Total débit</div><div className="font-mono text-zinc-200">{m(totDebit)}</div></div>
              <div><div className="text-xs text-zinc-500">Total crédit</div><div className="font-mono text-zinc-200">{m(totCredit)}</div></div>
              <div><div className="text-xs text-zinc-500">Mouvements</div><div className="font-mono text-zinc-200">{rows.length}</div></div>
            </div>
          </div>

          {/* Grand livre du tiers */}
          {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : withSolde.length === 0 ? <p className="text-sm text-zinc-500">Aucun mouvement pour ce tiers.</p> : (
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="border-b border-white/10 px-4 py-2.5 text-xs uppercase text-zinc-400">Mouvements (grand livre auxiliaire)</div>
              <table className="w-full text-left text-sm">
                <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
                  <th className="px-4 py-2.5 font-medium">Date</th><th className="px-4 py-2.5 font-medium">Jrnl</th><th className="px-4 py-2.5 font-medium">Compte</th><th className="px-4 py-2.5 font-medium">Libellé</th>
                  <th className="px-4 py-2.5 text-right font-medium">Débit</th><th className="px-4 py-2.5 text-right font-medium">Crédit</th><th className="px-4 py-2.5 text-right font-medium">Solde</th>
                </tr></thead>
                <tbody className="divide-y divide-white/5 font-mono">
                  {withSolde.map((r, i) => (
                    <tr key={i} className="hover:bg-white/5">
                      <td className="px-4 py-1.5 text-zinc-400">{r.entry_date}</td>
                      <td className="px-4 py-1.5 text-zinc-500">{r.journal_code}</td>
                      <td className="px-4 py-1.5 text-zinc-500">{r.account_code}</td>
                      <td className="px-4 py-1.5 font-sans text-zinc-300">{r.label}</td>
                      <td className="px-4 py-1.5 text-right text-zinc-300">{r.debit ? m(r.debit) : ''}</td>
                      <td className="px-4 py-1.5 text-right text-zinc-300">{r.credit ? m(r.credit) : ''}</td>
                      <td className={cn('px-4 py-1.5 text-right', r.solde >= 0 ? 'text-zinc-200' : 'text-rose-400')}>{m(r.solde)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PlanTiers({ dossierId }: { dossierId: string }) {
  const [rows, setRows] = useState<Counterparty[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ type: 'client', name: '', auxCode: '', taxId: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');

  const load = async () => { setLoading(true); try { setRows(await api.counterparties(dossierId)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [dossierId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!form.name.trim()) return;
    setBusy(true); setError(null);
    try { await api.createCounterparty(dossierId, { type: form.type, name: form.name.trim(), auxCode: form.auxCode.trim() || undefined, taxId: form.taxId.trim() || undefined, email: form.email.trim() || undefined }); setForm({ type: form.type, name: '', auxCode: '', taxId: '', email: '' }); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const saveEmail = async (r: Counterparty) => { setEditId(null); if ((editEmail.trim() || null) === (r.email ?? null)) return; try { await api.updateCounterparty(dossierId, r.id, { email: editEmail.trim() }); await load(); } catch (e: any) { setError(e.message); } };
  const remove = async (id: string) => { await api.deleteCounterparty(dossierId, id); await load(); };

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div><label className="mb-1 block text-xs text-zinc-500">Type</label>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
            <option value="client">Client</option><option value="fournisseur">Fournisseur</option><option value="salarie">Salarié</option><option value="autre">Autre</option>
          </select></div>
        <div className="flex-1 min-w-[10rem]"><label className="mb-1 block text-xs text-zinc-500">Nom</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Raison sociale du tiers" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
        <div className="w-28"><label className="mb-1 block text-xs text-zinc-500">Code aux.</label>
          <input value={form.auxCode} onChange={(e) => setForm({ ...form, auxCode: e.target.value })} placeholder="auto" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
        <div className="w-32"><label className="mb-1 block text-xs text-zinc-500">Id. fiscal</label>
          <input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} placeholder="IFU/NCC" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
        <div className="w-48"><label className="mb-1 block text-xs text-zinc-500">Email (relances)</label>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="contact@client.ci" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
        <button type="submit" disabled={busy} className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter</button>
      </form>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : rows.length === 0 ? <p className="text-sm text-zinc-500">Aucun tiers. Ils se créent automatiquement à la saisie, ou ajoutez-les ici.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-3 font-medium">Code aux.</th><th className="px-4 py-3 font-medium">Type</th><th className="px-4 py-3 font-medium">Nom</th><th className="px-4 py-3 font-medium">Collectif</th><th className="px-4 py-3 font-medium">Id. fiscal</th><th className="px-4 py-3 font-medium">Email</th><th className="px-4 py-3"></th>
            </tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 font-mono text-zinc-200">{r.aux_code}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{TYPE_LABEL[r.type] ?? r.type}</td>
                  <td className="px-4 py-2.5 text-zinc-300">{r.name}</td>
                  <td className="px-4 py-2.5 font-mono text-zinc-500">{r.collective ?? '—'}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{r.tax_id ?? '—'}</td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {editId === r.id
                      ? <input value={editEmail} autoFocus onChange={(e) => setEditEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveEmail(r)} onBlur={() => saveEmail(r)} placeholder="contact@client.ci" className="w-44 rounded border border-emerald-500/40 bg-zinc-900/60 px-2 py-1 text-sm outline-none" />
                      : <span onClick={() => { setEditId(r.id); setEditEmail(r.email ?? ''); }} className="cursor-text">{r.email || <span className="text-zinc-600">+ email</span>}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right"><button onClick={() => remove(r.id)} className="text-zinc-600 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BalanceTiers({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [rows, setRows] = useState<AuxBalanceRow[]>([]);
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => { (async () => { setLoading(true); try { setRows(await api.auxBalance(dossierId, type || undefined)); } finally { setLoading(false); } })(); }, [dossierId, type]);

  const withMoves = rows.filter((r) => r.debit || r.credit);
  const totD = withMoves.reduce((s, r) => s + r.debit, 0), totC = withMoves.reduce((s, r) => s + r.credit, 0);

  const exportCsv = () => {
    const out: (string | number)[][] = [['Code aux.', 'Tiers', 'Type', 'Collectif', 'Débit', 'Crédit', 'Solde']];
    for (const r of withMoves) out.push([r.aux_code ?? '', r.name, r.type, r.collective, r.debit, r.credit, r.balance]);
    out.push(['', 'TOTAUX', '', '', totD, totC, totD - totC]);
    downloadCsv(`balance-tiers_${dossierName}`.replace(/\s+/g, '-'), out);
  };
  const exportPdf = () => {
    const head = `<tr><th>Code</th><th>Tiers</th><th>Coll.</th><th class="n">Débit</th><th class="n">Crédit</th><th class="n">Solde</th></tr>`;
    const body = withMoves.map((r) => `<tr><td>${r.aux_code ?? ''}</td><td>${(r.name ?? '').replace(/[&<>]/g, '')}</td><td>${r.collective}</td><td class="n">${r.debit ? fmtMoney(r.debit, currency) : ''}</td><td class="n">${r.credit ? fmtMoney(r.credit, currency) : ''}</td><td class="n">${fmtMoney(r.balance, currency)}</td></tr>`).join('');
    printDocument(`Balance des tiers — ${dossierName}`, `au ${nowStamp()} · devise ${currency}`, `<table><thead>${head}</thead><tbody>${body}<tr class="tot"><td colspan="3">Totaux</td><td class="n">${fmtMoney(totD, currency)}</td><td class="n">${fmtMoney(totC, currency)}</td><td class="n">${fmtMoney(totD - totC, currency)}</td></tr></tbody></table>`);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
          <option value="">Tous les tiers</option><option value="client">Clients</option><option value="fournisseur">Fournisseurs</option>
        </select>
        <div className="flex gap-2">
          <button onClick={exportCsv} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><FileSpreadsheet className="h-4 w-4" /> Excel/CSV</button>
          <button onClick={exportPdf} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> PDF</button>
        </div>
      </div>
      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div> : withMoves.length === 0 ? <p className="text-sm text-zinc-500">Aucun mouvement de tiers.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-3 font-medium">Code</th><th className="px-4 py-3 font-medium">Tiers</th><th className="px-4 py-3 font-medium">Coll.</th>
              <th className="px-4 py-3 text-right font-medium">Débit</th><th className="px-4 py-3 text-right font-medium">Crédit</th><th className="px-4 py-3 text-right font-medium">Solde</th>
            </tr></thead>
            <tbody className="divide-y divide-white/5 font-mono">
              {withMoves.map((r) => (
                <tr key={r.id} className="hover:bg-white/5">
                  <td className="px-4 py-2 text-zinc-300">{r.aux_code}</td>
                  <td className="px-4 py-2 font-sans text-zinc-300">{r.name}</td>
                  <td className="px-4 py-2 text-zinc-500">{r.collective}</td>
                  <td className="px-4 py-2 text-right text-zinc-300">{r.debit ? fmtMoney(r.debit, currency) : '—'}</td>
                  <td className="px-4 py-2 text-right text-zinc-300">{r.credit ? fmtMoney(r.credit, currency) : '—'}</td>
                  <td className={cn('px-4 py-2 text-right font-medium', r.balance >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtMoney(r.balance, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
              <td className="px-4 py-3 font-sans font-semibold text-zinc-200" colSpan={3}>Totaux</td>
              <td className="px-4 py-3 text-right font-semibold text-zinc-100">{fmtMoney(totD, currency)}</td>
              <td className="px-4 py-3 text-right font-semibold text-zinc-100">{fmtMoney(totC, currency)}</td>
              <td className="px-4 py-3 text-right font-semibold text-zinc-100">{fmtMoney(totD - totC, currency)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function GrandLivreTiers({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [tiers, setTiers] = useState<Counterparty[]>([]);
  const [cid, setCid] = useState('');
  const [rows, setRows] = useState<AuxLedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => { (async () => { const t = await api.counterparties(dossierId); setTiers(t); if (!cid && t[0]) setCid(t[0].id); })(); }, [dossierId]);
  useEffect(() => { if (!cid) return; (async () => { setLoading(true); try { setRows(await api.auxLedger(dossierId, cid)); } finally { setLoading(false); } })(); }, [cid]);

  let solde = 0;
  const withSolde = rows.map((r) => { solde += r.debit - r.credit; return { ...r, solde }; });
  const tp = tiers.find((t) => t.id === cid);
  const m = (n: number) => (n ? fmtMoney(n, currency) : '');

  const exportPdf = () => {
    const body = `<table><thead><tr><th>Date</th><th>Jrnl</th><th>Cpte</th><th>Libellé</th><th class="n">Débit</th><th class="n">Crédit</th><th class="n">Solde</th></tr></thead><tbody>
      ${withSolde.map((r) => `<tr><td>${r.entry_date}</td><td>${r.journal_code}</td><td>${r.account_code}</td><td>${(r.label ?? '').replace(/[&<>]/g, '')}</td><td class="n">${m(r.debit)}</td><td class="n">${m(r.credit)}</td><td class="n">${fmtMoney(r.solde, currency)}</td></tr>`).join('')}</tbody></table>`;
    printDocument(`Grand livre tiers — ${tp?.name ?? ''}`, `${dossierName} · ${tp?.aux_code ?? ''} · au ${nowStamp()}`, body);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <select value={cid} onChange={(e) => setCid(e.target.value)} className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
          {tiers.map((t) => <option key={t.id} value={t.id}>{t.aux_code} · {t.name}</option>)}
        </select>
        <button onClick={exportPdf} disabled={!withSolde.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><Printer className="h-4 w-4" /> PDF</button>
      </div>
      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : withSolde.length === 0 ? <p className="text-sm text-zinc-500">Aucun mouvement pour ce tiers.</p> : (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
              <th className="px-4 py-2.5 font-medium">Date</th><th className="px-4 py-2.5 font-medium">Jrnl</th><th className="px-4 py-2.5 font-medium">Compte</th><th className="px-4 py-2.5 font-medium">Libellé</th>
              <th className="px-4 py-2.5 text-right font-medium">Débit</th><th className="px-4 py-2.5 text-right font-medium">Crédit</th><th className="px-4 py-2.5 text-right font-medium">Solde</th>
            </tr></thead>
            <tbody className="divide-y divide-white/5 font-mono">
              {withSolde.map((r, i) => (
                <tr key={i} className="hover:bg-white/5">
                  <td className="px-4 py-1.5 text-zinc-400">{r.entry_date}</td>
                  <td className="px-4 py-1.5 text-zinc-500">{r.journal_code}</td>
                  <td className="px-4 py-1.5 text-zinc-500">{r.account_code}</td>
                  <td className="px-4 py-1.5 font-sans text-zinc-300">{r.label}</td>
                  <td className="px-4 py-1.5 text-right text-zinc-300">{m(r.debit)}</td>
                  <td className="px-4 py-1.5 text-right text-zinc-300">{m(r.credit)}</td>
                  <td className={cn('px-4 py-1.5 text-right', r.solde >= 0 ? 'text-zinc-200' : 'text-rose-400')}>{fmtMoney(r.solde, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Lettrage({ dossierId, currency }: { dossierId: string; currency: string }) {
  const [accounts, setAccounts] = useState<TiersAccount[]>([]);
  const [account, setAccount] = useState('');
  const [data, setData] = useState<{ open: OpenItem[]; lettered: LetteredItem[] } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const loadAccounts = async () => {
    const a = await api.tiersAccounts(dossierId); setAccounts(a);
    if (!account && a[0]) setAccount(a[0].account_code);
  };
  useEffect(() => { loadAccounts(); }, [dossierId]);

  const autoLetter = async () => {
    setError(null); setOk(null); setAutoBusy(true);
    try {
      const r = await api.autoLettrage(dossierId, account || undefined);
      setOk(r.groups > 0 ? `${r.groups} lettrage(s) automatique(s) · ${r.linesLettered} pièce(s)` : 'Aucun rapprochement automatique trouvé');
      setTimeout(() => setOk(null), 3500);
      await loadView(); await loadAccounts();
    } catch (e: any) { setError(e.message); } finally { setAutoBusy(false); }
  };

  const loadView = async () => {
    if (!account) return;
    setLoading(true); setSel(new Set());
    try { setData(await api.lettrageView(dossierId, account)); } finally { setLoading(false); }
  };
  useEffect(() => { loadView(); }, [account]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const selDebit = useMemo(() => (data?.open ?? []).filter((o) => sel.has(o.entry_line_id)).reduce((s, o) => s + o.debit, 0), [sel, data]);
  const selCredit = useMemo(() => (data?.open ?? []).filter((o) => sel.has(o.entry_line_id)).reduce((s, o) => s + o.credit, 0), [sel, data]);
  const balanced = sel.size >= 2 && Math.abs(selDebit - selCredit) < 0.001;

  const letter = async () => {
    setError(null); setOk(null);
    try {
      const r = await api.createLettrage(dossierId, account, [...sel]);
      setOk(`Lettrage ${r.code} créé`); setTimeout(() => setOk(null), 2500);
      await loadView(); await loadAccounts();
    } catch (e: any) { setError(e.message); }
  };
  const unletter = async (id: string) => { await api.deleteLettrage(dossierId, id); await loadView(); await loadAccounts(); };

  const groups = useMemo(() => {
    const m = new Map<string, { code: string; items: LetteredItem[] }>();
    for (const l of data?.lettered ?? []) { if (!m.has(l.id)) m.set(l.id, { code: l.code, items: [] }); m.get(l.id)!.items.push(l); }
    return [...m.entries()].map(([id, v]) => ({ id, ...v }));
  }, [data]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-zinc-400">Compte de tiers</label>
        <select value={account} onChange={(e) => setAccount(e.target.value)}
          className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50">
          {accounts.map((a) => <option key={a.account_code} value={a.account_code}>{a.account_code} · {a.label} ({a.open_count})</option>)}
        </select>
        <button onClick={autoLetter} disabled={autoBusy} title="Rapproche automatiquement les paires et règlements échelonnés par tiers"
          className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40">
          {autoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Lettrage automatique
        </button>
        {ok && <span className="flex items-center gap-1.5 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {ok}</span>}
      </div>

      {loading ? <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div> : !data ? null : (
        <>
          {/* Pièces non lettrées */}
          <div className="rounded-2xl border border-white/10 bg-white/5">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
              <span className="text-sm font-medium text-zinc-200">Pièces non lettrées</span>
              <div className="flex items-center gap-4 text-sm">
                <span className="font-mono text-zinc-400">Sél. D {fmtMoney(selDebit, currency)} · C {fmtMoney(selCredit, currency)} {sel.size >= 1 && (balanced ? <span className="text-emerald-400">✓</span> : <span className="text-amber-400">Δ {fmtMoney(Math.abs(selDebit - selCredit), currency)}</span>)}</span>
                <button onClick={letter} disabled={!balanced}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"><Link2 className="h-4 w-4" /> Lettrer</button>
              </div>
            </div>
            {data.open.length === 0 ? <p className="px-4 py-4 text-sm text-zinc-500">Tout est lettré ✅</p> : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-zinc-500"><tr>
                  <th className="px-4 py-2"></th><th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Pièce</th>
                  <th className="px-4 py-2 font-medium">Libellé</th><th className="px-4 py-2 text-right font-medium">Débit</th><th className="px-4 py-2 text-right font-medium">Crédit</th>
                </tr></thead>
                <tbody className="divide-y divide-white/5 font-mono">
                  {data.open.map((o) => (
                    <tr key={o.entry_line_id} className={cn('hover:bg-white/5', sel.has(o.entry_line_id) && 'bg-emerald-500/5')}>
                      <td className="px-4 py-2"><input type="checkbox" checked={sel.has(o.entry_line_id)} onChange={() => toggle(o.entry_line_id)} className="accent-emerald-500" /></td>
                      <td className="px-4 py-2 text-zinc-400">{o.entry_date}</td>
                      <td className="px-4 py-2 text-zinc-500">{o.piece_ref ?? '—'}</td>
                      <td className="px-4 py-2 font-sans text-zinc-300">{o.label}</td>
                      <td className="px-4 py-2 text-right text-zinc-300">{o.debit ? fmtMoney(o.debit, currency) : ''}</td>
                      <td className="px-4 py-2 text-right text-zinc-300">{o.credit ? fmtMoney(o.credit, currency) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

          {/* Lettrages existants */}
          {groups.length > 0 && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="mb-2 text-sm font-medium text-zinc-200">Lettrages</div>
              <div className="space-y-2">
                {groups.map((g) => (
                  <div key={g.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-sm">
                    <div className="flex items-center gap-3">
                      <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-emerald-400">{g.code}</span>
                      <span className="text-zinc-400">{g.items.length} pièce(s) · {g.items.map((i) => i.entry_date).join(', ')}</span>
                    </div>
                    <button onClick={() => unletter(g.id)} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-rose-400"><Unlink className="h-3.5 w-3.5" /> délettrer</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Aged({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [rows, setRows] = useState<AgedRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { (async () => { setLoading(true); try { setRows(await api.agedBalance(dossierId)); } finally { setLoading(false); } })(); }, [dossierId]);

  const cols = ['b0_30', 'b31_60', 'b61_90', 'b90_plus'] as const;
  const heads = ['0-30 j', '31-60 j', '61-90 j', '+90 j'];
  const tot = (k: keyof AgedRow) => rows.reduce((s, r) => s + (r[k] as number), 0);

  const exportCsv = () => {
    const out: (string | number)[][] = [['Compte', 'Intitulé', ...heads, 'Solde']];
    for (const r of rows) out.push([r.account_code, r.label, r.b0_30, r.b31_60, r.b61_90, r.b90_plus, r.balance]);
    out.push(['', 'TOTAUX', tot('b0_30'), tot('b31_60'), tot('b61_90'), tot('b90_plus'), tot('balance')]);
    downloadCsv(`balance-agee_${dossierName}`.replace(/\s+/g, '-'), out);
  };
  const exportPdf = () => {
    const head = `<tr><th>Compte</th><th>Intitulé</th>${heads.map((h) => `<th class="n">${h}</th>`).join('')}<th class="n">Solde</th></tr>`;
    const body = rows.map((r) => `<tr><td>${r.account_code}</td><td>${(r.label ?? '').replace(/[&<>]/g, '')}</td>${cols.map((k) => `<td class="n">${r[k] ? fmtMoney(r[k], currency) : ''}</td>`).join('')}<td class="n">${fmtMoney(r.balance, currency)}</td></tr>`).join('');
    const t = `<tr class="tot"><td colspan="2">Totaux</td>${cols.map((k) => `<td class="n">${fmtMoney(tot(k), currency)}</td>`).join('')}<td class="n">${fmtMoney(tot('balance'), currency)}</td></tr>`;
    printDocument(`Balance âgée — ${dossierName}`, `au ${nowStamp()} · devise ${currency}`, `<table><thead>${head}</thead><tbody>${body}${t}</tbody></table>`);
  };

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul…</div>;
  if (rows.length === 0) return <p className="text-zinc-400">Aucun encours de tiers (tout est lettré ou soldé).</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-400">Encours des tiers par ancienneté (non lettrés)</p>
        <div className="flex gap-2">
          <button onClick={exportCsv} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><FileSpreadsheet className="h-4 w-4" /> Excel/CSV</button>
          <button onClick={exportPdf} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> PDF</button>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400"><tr>
            <th className="px-4 py-3 font-medium">Compte</th><th className="px-4 py-3 font-medium">Intitulé</th>
            {heads.map((h) => <th key={h} className="px-4 py-3 text-right font-medium">{h}</th>)}
            <th className="px-4 py-3 text-right font-medium">Solde</th>
          </tr></thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {rows.map((r) => (
              <tr key={r.account_code} className="hover:bg-white/5">
                <td className="px-4 py-2 text-zinc-300">{r.account_code}</td>
                <td className="px-4 py-2 font-sans text-zinc-400">{r.label}</td>
                {cols.map((k) => <td key={k} className={cn('px-4 py-2 text-right', k === 'b90_plus' && r[k] ? 'text-rose-400' : 'text-zinc-300')}>{r[k] ? fmtMoney(r[k], currency) : '—'}</td>)}
                <td className="px-4 py-2 text-right font-medium text-zinc-100">{fmtMoney(r.balance, currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-white/10 bg-white/5 font-mono"><tr>
            <td className="px-4 py-3 font-sans font-semibold text-zinc-200" colSpan={2}>Totaux</td>
            {cols.map((k) => <td key={k} className="px-4 py-3 text-right font-semibold text-zinc-100">{fmtMoney(tot(k), currency)}</td>)}
            <td className="px-4 py-3 text-right font-semibold text-zinc-100">{fmtMoney(tot('balance'), currency)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>
  );
}
