import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Scale, PencilLine, BookOpen, Loader2, Settings2, Search, ScanLine, ShieldCheck, Smartphone, FileText } from 'lucide-react';
import { api, fmtMoney, type Dossier, type FiscalYear, type Journal, type BalanceRow, type Account } from '../lib/api';
import { cn } from '../lib/utils';
import EntryForm from './EntryForm';
import Capture from './Capture';
import RulesTab from './RulesTab';
import MobileMoney from './MobileMoney';
import FinancialStatements from './FinancialStatements';

type Tab = 'capture' | 'mobilemoney' | 'balance' | 'etats' | 'saisie' | 'plan' | 'regles';

export default function DossierView({ dossier, onBack }: { dossier: Dossier; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('capture');
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [ready, setReady] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  const loadStructures = async () => {
    const [fys, js] = await Promise.all([api.fiscalYears(dossier.id), api.journals(dossier.id)]);
    setFiscalYears(fys); setJournals(js); setReady(true);
  };
  useEffect(() => { loadStructures(); }, [dossier.id]);

  const setup = async () => {
    setSettingUp(true);
    try { const r = await api.setupDossier(dossier.id); setFiscalYears(r.fiscalYears); setJournals(r.journals); }
    finally { setSettingUp(false); }
  };

  const needsSetup = ready && (fiscalYears.length === 0 || journals.length === 0);

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'capture', label: 'Capture IA', icon: ScanLine },
    { id: 'mobilemoney', label: 'Mobile Money', icon: Smartphone },
    { id: 'saisie', label: 'Saisie', icon: PencilLine },
    { id: 'balance', label: 'Balance', icon: Scale },
    { id: 'etats', label: 'États financiers', icon: FileText },
    { id: 'regles', label: 'Règles', icon: ShieldCheck },
    { id: 'plan', label: 'Plan comptable', icon: BookOpen },
  ];

  return (
    <div className="space-y-8">
      <div>
        <button onClick={onBack} className="mb-3 flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200">
          <ArrowLeft className="h-4 w-4" /> Portefeuille
        </button>
        <h1 className="font-display text-3xl font-bold tracking-tight">{dossier.raison_sociale}</h1>
        <p className="mt-1 text-zinc-400">{dossier.base_currency} · {dossier.accounting_system === 'smt' ? 'Système Minimal de Trésorerie' : 'Système normal'}</p>
      </div>

      {!ready ? (
        <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : needsSetup ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 p-10 text-center">
          <div className="rounded-full bg-emerald-500/10 p-4 text-emerald-400"><Settings2 className="h-7 w-7" /></div>
          <h2 className="mt-4 font-display text-xl font-semibold">Initialiser le dossier</h2>
          <p className="mt-2 max-w-sm text-zinc-400">Crée l'exercice courant et les journaux standards (AC, VE, BQ, CA, OD) pour commencer la saisie.</p>
          <button onClick={setup} disabled={settingUp} className="mt-6 flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {settingUp && <Loader2 className="h-4 w-4 animate-spin" />} Initialiser
          </button>
        </div>
      ) : (
        <>
          <div className="flex gap-2 border-b border-white/10">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn('flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                  tab === t.id ? 'border-emerald-400 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200')}>
                <t.icon className="h-4 w-4" /> {t.label}
              </button>
            ))}
          </div>

          <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {tab === 'capture' && (
              <Capture dossierId={dossier.id} fiscalYears={fiscalYears} journals={journals}
                currency={dossier.base_currency} onPosted={() => { /* la balance se recharge à l'ouverture de l'onglet */ }} />
            )}
            {tab === 'saisie' && (
              <EntryForm dossierId={dossier.id} fiscalYears={fiscalYears} journals={journals}
                currency={dossier.base_currency} onPosted={() => { /* la balance se recharge à l'ouverture de l'onglet */ }} />
            )}
            {tab === 'mobilemoney' && (
              <MobileMoney dossierId={dossier.id} fiscalYears={fiscalYears}
                currency={dossier.base_currency} onImported={() => { /* balance se recharge à l'ouverture */ }} />
            )}
            {tab === 'balance' && <BalanceTab dossierId={dossier.id} currency={dossier.base_currency} />}
            {tab === 'etats' && <FinancialStatements dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} />}
            {tab === 'regles' && <RulesTab dossierId={dossier.id} />}
            {tab === 'plan' && <PlanTab dossierId={dossier.id} />}
          </motion.div>
        </>
      )}
    </div>
  );
}

function BalanceTab({ dossierId, currency }: { dossierId: string; currency: string }) {
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { (async () => { setLoading(true); try { setRows(await api.trialBalance(dossierId)); } finally { setLoading(false); } })(); }, [dossierId]);

  const totDebit = rows.reduce((s, r) => s + r.total_debit, 0);
  const totCredit = rows.reduce((s, r) => s + r.total_credit, 0);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul de la balance…</div>;
  if (rows.length === 0) return <p className="text-zinc-400">Aucun mouvement comptabilisé pour l'instant.</p>;

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
          <tr>
            <th className="px-5 py-3 font-medium">Compte</th>
            <th className="px-5 py-3 font-medium">Intitulé</th>
            <th className="px-5 py-3 text-right font-medium">Débit</th>
            <th className="px-5 py-3 text-right font-medium">Crédit</th>
            <th className="px-5 py-3 text-right font-medium">Solde</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5 font-mono">
          {rows.map((r) => (
            <tr key={r.account_code} className="hover:bg-white/5">
              <td className="px-5 py-2.5 text-zinc-300">{r.account_code}</td>
              <td className="px-5 py-2.5 font-sans text-zinc-400">{r.account_label}</td>
              <td className="px-5 py-2.5 text-right text-zinc-300">{r.total_debit ? fmtMoney(r.total_debit, currency) : '—'}</td>
              <td className="px-5 py-2.5 text-right text-zinc-300">{r.total_credit ? fmtMoney(r.total_credit, currency) : '—'}</td>
              <td className={cn('px-5 py-2.5 text-right font-medium', r.balance >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtMoney(r.balance, currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-white/10 bg-white/5 font-mono">
          <tr>
            <td className="px-5 py-3 font-sans font-semibold text-zinc-200" colSpan={2}>Totaux</td>
            <td className="px-5 py-3 text-right font-semibold text-zinc-100">{fmtMoney(totDebit, currency)}</td>
            <td className="px-5 py-3 text-right font-semibold text-zinc-100">{fmtMoney(totCredit, currency)}</td>
            <td className={cn('px-5 py-3 text-right font-semibold', totDebit === totCredit ? 'text-emerald-400' : 'text-rose-400')}>
              {totDebit === totCredit ? '✓ équilibrée' : fmtMoney(totDebit - totCredit, currency)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function PlanTab({ dossierId }: { dossierId: string }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const t = setTimeout(async () => { setLoading(true); try { setRows(await api.accounts(dossierId, q || undefined)); } finally { setLoading(false); } }, 250);
    return () => clearTimeout(t);
  }, [dossierId, q]);

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un compte (code ou libellé)…"
          className="w-full rounded-lg border border-white/10 bg-zinc-900/50 py-2 pl-9 pr-4 text-sm outline-none focus:border-emerald-500/50" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
            <tr>
              <th className="px-5 py-3 font-medium">Code</th>
              <th className="px-5 py-3 font-medium">Intitulé</th>
              <th className="px-5 py-3 font-medium">Classe</th>
              <th className="px-5 py-3 font-medium">Type</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr><td colSpan={4} className="px-5 py-4 text-zinc-400">Recherche…</td></tr>
            ) : rows.map((a) => (
              <tr key={a.id} className="hover:bg-white/5">
                <td className="px-5 py-2.5 font-mono text-zinc-300">{a.account_code}</td>
                <td className="px-5 py-2.5 text-zinc-300">{a.label}</td>
                <td className="px-5 py-2.5 text-zinc-500">{a.class_no}</td>
                <td className="px-5 py-2.5 text-zinc-500">{a.account_type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && <p className="text-xs text-zinc-500">{rows.length} compte(s) affiché(s){!q && ' (100 premiers — affinez la recherche)'}.</p>}
    </div>
  );
}
