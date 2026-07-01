import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Scale, PencilLine, BookOpen, Loader2, Settings2, Search, ScanLine, ShieldCheck, Smartphone, FileText, Library, FileSpreadsheet, Printer, Users, Landmark } from 'lucide-react';
import { api, fmtMoney, type Dossier, type FiscalYear, type Journal, type BalanceRow, type Account } from '../lib/api';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';
import EntryForm from './EntryForm';
import Capture from './Capture';
import RulesTab from './RulesTab';
import MobileMoney from './MobileMoney';
import FinancialStatements from './FinancialStatements';
import GeneralLedger from './GeneralLedger';
import Tiers from './Tiers';
import BankReconciliation from './BankReconciliation';

type Tab = 'capture' | 'mobilemoney' | 'banque' | 'balance' | 'grandlivre' | 'tiers' | 'etats' | 'saisie' | 'plan' | 'regles';

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
    { id: 'grandlivre', label: 'Grand livre', icon: Library },
    { id: 'tiers', label: 'Tiers', icon: Users },
    { id: 'banque', label: 'Banque', icon: Landmark },
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
            {tab === 'balance' && <BalanceTab dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'grandlivre' && <GeneralLedger dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} />}
            {tab === 'tiers' && <Tiers dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'banque' && <BankReconciliation dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'etats' && <FinancialStatements dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} />}
            {tab === 'regles' && <RulesTab dossierId={dossier.id} />}
            {tab === 'plan' && <PlanTab dossierId={dossier.id} />}
          </motion.div>
        </>
      )}
    </div>
  );
}

function BalanceTab({ dossierId, dossierName, currency }: { dossierId: string; dossierName: string; currency: string }) {
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<6 | 8>(6);
  useEffect(() => { (async () => { setLoading(true); try { setRows(await api.trialBalance(dossierId)); } finally { setLoading(false); } })(); }, [dossierId]);

  if (loading) return <div className="flex items-center gap-2 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul de la balance…</div>;
  if (rows.length === 0) return <p className="text-zinc-400">Aucun mouvement comptabilisé pour l'instant.</p>;

  const md = (n: number) => (n ? fmtMoney(n, currency) : '—');
  // valeurs numériques par ligne selon le format
  const vals = (r: BalanceRow): number[] => {
    const soldeD = Math.max(r.balance, 0), soldeC = Math.max(-r.balance, 0);
    if (mode === 6) return [r.total_debit, r.total_credit, soldeD, soldeC];
    const openD = Math.max(r.open_debit - r.open_credit, 0), openC = Math.max(r.open_credit - r.open_debit, 0);
    return [openD, openC, r.period_debit, r.period_credit, soldeD, soldeC];
  };
  const groups = mode === 6
    ? [{ label: 'Mouvements', sub: ['Débit', 'Crédit'] }, { label: 'Soldes', sub: ['Débiteur', 'Créditeur'] }]
    : [{ label: 'À-nouveaux', sub: ['Débit', 'Crédit'] }, { label: 'Mouvements période', sub: ['Débit', 'Crédit'] }, { label: 'Soldes', sub: ['Débiteur', 'Créditeur'] }];
  const nVals = mode === 6 ? 4 : 6;
  const totals = Array.from({ length: nVals }, (_, i) => rows.reduce((s, r) => s + vals(r)[i], 0));
  const subHeaders = groups.flatMap((g) => g.sub.map((s) => `${g.label} ${s}`));

  const exportCsv = () => {
    const out: (string | number)[][] = [['Compte', 'Intitulé', ...subHeaders]];
    for (const r of rows) out.push([r.account_code, r.account_label, ...vals(r)]);
    out.push(['', 'TOTAUX', ...totals]);
    downloadCsv(`balance-${mode}col_${dossierName}`.replace(/\s+/g, '-'), out);
  };
  const exportPdf = () => {
    const head = `<tr><th>Compte</th><th>Intitulé</th>${subHeaders.map((s) => `<th class="n">${s}</th>`).join('')}</tr>`;
    const body = rows.map((r) => `<tr><td>${r.account_code}</td><td>${(r.account_label ?? '').replace(/[&<>]/g, '')}</td>${vals(r).map((x) => `<td class="n">${x ? fmtMoney(x, currency) : ''}</td>`).join('')}</tr>`).join('');
    const tot = `<tr class="tot"><td colspan="2">Totaux</td>${totals.map((t) => `<td class="n">${fmtMoney(t, currency)}</td>`).join('')}</tr>`;
    printDocument(`Balance à ${mode} colonnes — ${dossierName}`, `devise ${currency} · édité le ${nowStamp()}`, `<table><thead>${head}</thead><tbody>${body}${tot}</tbody></table>`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">Balance générale des comptes</p>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><FileSpreadsheet className="h-4 w-4" /> Excel/CSV</button>
          <button onClick={exportPdf} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> PDF</button>
          <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-sm">
            {[6, 8].map((n) => (
              <button key={n} onClick={() => setMode(n as 6 | 8)}
                className={cn('rounded-md px-3 py-1 font-medium transition-colors', mode === n ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
                {n} col.
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/5 text-xs text-zinc-400">
            <tr>
              <th className="px-4 py-2 font-medium" rowSpan={2}>Compte</th>
              <th className="px-4 py-2 font-medium" rowSpan={2}>Intitulé</th>
              {groups.map((g) => (
                <th key={g.label} className="border-l border-white/10 px-4 py-2 text-center font-medium uppercase" colSpan={2}>{g.label}</th>
              ))}
            </tr>
            <tr>
              {groups.flatMap((g) => g.sub.map((s, i) => (
                <th key={g.label + s} className={cn('px-4 py-2 text-right font-medium', i === 0 && 'border-l border-white/10')}>{s}</th>
              )))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {rows.map((r) => {
              const v = vals(r);
              return (
                <tr key={r.account_code} className="hover:bg-white/5">
                  <td className="px-4 py-2 text-zinc-300">{r.account_code}</td>
                  <td className="px-4 py-2 font-sans text-zinc-400">{r.account_label}</td>
                  {v.map((x, i) => (
                    <td key={i} className={cn('px-4 py-2 text-right text-zinc-300', i % 2 === 0 && 'border-l border-white/10')}>{md(x)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-white/10 bg-white/5 font-mono">
            <tr>
              <td className="px-4 py-3 font-sans font-semibold text-zinc-200" colSpan={2}>Totaux</td>
              {totals.map((t, i) => (
                <td key={i} className={cn('px-4 py-3 text-right font-semibold text-zinc-100', i % 2 === 0 && 'border-l border-white/10')}>{fmtMoney(t, currency)}</td>
              ))}
            </tr>
            <tr>
              <td className="px-4 pb-3 font-sans text-xs text-zinc-500" colSpan={2}>Équilibre</td>
              {groups.map((g, gi) => {
                const d = totals[gi * 2], cc = totals[gi * 2 + 1];
                return (
                  <td key={g.label} colSpan={2} className={cn('px-4 pb-3 text-right text-xs border-l border-white/10', Math.abs(d - cc) < 0.001 ? 'text-emerald-400' : 'text-rose-400')}>
                    {Math.abs(d - cc) < 0.001 ? '✓ équilibré' : fmtMoney(d - cc, currency)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
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
