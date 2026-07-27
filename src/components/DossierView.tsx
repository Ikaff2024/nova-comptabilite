import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Scale, PencilLine, BookOpen, Loader2, Settings2, Search, ScanLine, ShieldCheck, Smartphone, FileText, Library, FileSpreadsheet, Printer, Users, Landmark, BookMarked, ReceiptText, Receipt, Upload, Building2, History, LayoutDashboard, Repeat, Plus, Power, Trash2, PieChart, Target, ClipboardCheck, TrendingUp, Gauge, ShoppingCart, UserRound, Sparkles, Wallet, Package, ChevronDown, Lock, ScrollText } from 'lucide-react';
import { api, fmtMoney, downloadAuthed, currentFiscalYear, type Dossier, type FiscalYear, type Journal, type BalanceRow, type Account } from '../lib/api';
import { downloadCsv, printDocument, nowStamp } from '../lib/export';
import { cn } from '../lib/utils';
import EntryForm, { type EntryFormInitial } from './EntryForm';
import Capture from './Capture';
import RulesTab from './RulesTab';
import MobileMoney from './MobileMoney';
import FinancialStatements from './FinancialStatements';
import GeneralLedger from './GeneralLedger';
import Tiers from './Tiers';
import BankReconciliation from './BankReconciliation';
import Journaux from './Journaux';
import Facturation from './Facturation';
import Achats from './Achats';
import Catalogue from './Catalogue';
import Clotures from './Clotures';
import Assistant from './Assistant';
import Paie from './Paie';
import ClientAccess from './ClientAccess';
import Fiscalite from './Fiscalite';
import ImportBalance from './ImportBalance';
import ImportLedger from './ImportLedger';
import Immobilisations from './Immobilisations';
import AuditTrail from './AuditTrail';
import LexaDecisions from './LexaDecisions';
import DossierDashboard from './DossierDashboard';
import AnalyseFinanciere from './AnalyseFinanciere';
import Recurring from './Recurring';
import RecurringInvoices from './RecurringInvoices';
import Analytique from './Analytique';
import Budget from './Budget';
import Revision from './Revision';
import FicheEntreprise from './FicheEntreprise';
import Previsionnel from './Previsionnel';
import Scoring from './Scoring';

type Tab = 'synthese' | 'assistant' | 'analyse' | 'facturation' | 'achats' | 'catalogue' | 'paie' | 'capture' | 'mobilemoney' | 'banque' | 'previsionnel' | 'scoring' | 'balance' | 'grandlivre' | 'journaux' | 'tiers' | 'immos' | 'etats' | 'fiscalite' | 'analytique' | 'budget' | 'revision' | 'clotures' | 'saisie' | 'recurrences' | 'abonnements' | 'plan' | 'regles' | 'import' | 'audit' | 'decisions' | 'portail' | 'identite';

export default function DossierView({ dossier, onBack, hideBack }: { dossier: Dossier; onBack: () => void; hideBack?: boolean }) {
  const [tab, setTab] = useState<Tab>('synthese');
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [ready, setReady] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [name, setName] = useState(dossier.raison_sociale);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(dossier.raison_sociale);
  const [savingName, setSavingName] = useState(false);
  // Correction d'une écriture : après extourne, on pré-remplit la saisie.
  const [editSeed, setEditSeed] = useState<EntryFormInitial | null>(null);
  const [editSeedKey, setEditSeedKey] = useState(0);

  const saveName = async () => {
    const n = draftName.trim();
    if (n.length < 2 || n === name) { setEditingName(false); return; }
    setSavingName(true);
    try { await api.renameDossier(dossier.id, n); setName(n); dossier.raison_sociale = n; setEditingName(false); }
    catch { /* garde le nom courant */ } finally { setSavingName(false); }
  };

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
    { id: 'synthese', label: 'Synthèse', icon: LayoutDashboard },
    { id: 'assistant', label: 'Lexa', icon: Sparkles },
    { id: 'analyse', label: 'Analyse & révision', icon: Gauge },
    { id: 'facturation', label: 'Facturation', icon: ReceiptText },
    { id: 'achats', label: 'Achats', icon: ShoppingCart },
    { id: 'catalogue', label: 'Catalogue', icon: Package },
    { id: 'paie', label: 'Paie & RH', icon: Wallet },
    { id: 'capture', label: 'Capture IA', icon: ScanLine },
    { id: 'mobilemoney', label: 'Mobile Money', icon: Smartphone },
    { id: 'saisie', label: 'Saisie', icon: PencilLine },
    { id: 'recurrences', label: 'Récurrences', icon: Repeat },
    { id: 'abonnements', label: 'Abonnements', icon: Repeat },
    { id: 'balance', label: 'Balance', icon: Scale },
    { id: 'grandlivre', label: 'Grand livre', icon: Library },
    { id: 'journaux', label: 'Journaux', icon: BookMarked },
    { id: 'revision', label: 'Révision', icon: ClipboardCheck },
    { id: 'clotures', label: 'Clôtures', icon: Lock },
    { id: 'tiers', label: 'Tiers', icon: Users },
    { id: 'immos', label: 'Immobilisations', icon: Building2 },
    { id: 'banque', label: 'Banque', icon: Landmark },
    { id: 'previsionnel', label: 'Prévisionnel', icon: TrendingUp },
    { id: 'scoring', label: 'Score & financement', icon: Gauge },
    { id: 'etats', label: 'États financiers', icon: FileText },
    { id: 'analytique', label: 'Analytique', icon: PieChart },
    { id: 'budget', label: 'Budget', icon: Target },
    { id: 'fiscalite', label: 'Fiscalité', icon: Receipt },
    { id: 'regles', label: 'Règles', icon: ShieldCheck },
    { id: 'plan', label: 'Plan comptable', icon: BookOpen },
    { id: 'import', label: 'Import / reprise', icon: Upload },
    { id: 'audit', label: 'Audit', icon: History },
    { id: 'decisions', label: 'Décisions Lexa', icon: ScrollText },
    { id: 'portail', label: 'Portail client', icon: UserRound },
    { id: 'identite', label: 'Fiche entreprise', icon: Building2 },
  ];

  // Regroupement des modules par nature. Pilotage et Saisie restent en menu
  // latéral vertical ; les catégories suivantes (comptabilité, tiers, états,
  // paramètres) passent dans une barre horizontale à menus déroulants.
  const meta = Object.fromEntries(tabs.map((t) => [t.id, t])) as Record<Tab, { id: Tab; label: string; icon: any }>;
  const groups: { label: string; items: Tab[]; icon: any }[] = [
    { label: 'Pilotage', icon: Gauge, items: ['synthese', 'assistant', 'analyse', 'previsionnel', 'scoring'] },
    { label: 'Saisie', icon: PencilLine, items: ['capture', 'facturation', 'achats', 'catalogue', 'mobilemoney', 'saisie', 'recurrences', 'abonnements'] },
    { label: 'Paie & RH', icon: Wallet, items: ['paie'] },
    { label: 'Analyse & budget', icon: PieChart, items: ['analytique', 'budget'] },
    { label: 'Comptabilité', icon: Library, items: ['balance', 'grandlivre', 'journaux', 'revision', 'clotures', 'plan'] },
    { label: 'Tiers & trésorerie', icon: Landmark, items: ['tiers', 'banque', 'immos'] },
    { label: 'États & déclarations', icon: FileText, items: ['etats', 'fiscalite'] },
    { label: 'Paramètres & accès', icon: Settings2, items: ['identite', 'regles', 'import', 'audit', 'decisions', 'portail'] },
  ];
  const sideGroups = groups.slice(0, 2);   // Pilotage, Saisie (vertical)
  const barGroups = groups.slice(2);       // Comptabilité, Tiers, États, Paramètres (barre horizontale)

  // Menu déroulant ouvert dans la barre horizontale (fermeture au clic extérieur).
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => { if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  return (
    <div className="space-y-8">
      <div>
        {!hideBack && (
          <button onClick={onBack} className="mb-3 flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200">
            <ArrowLeft className="h-4 w-4" /> Portefeuille
          </button>
        )}
        {editingName ? (
          <div className="flex flex-wrap items-center gap-2">
            <input autoFocus value={draftName} onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
              className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 font-display text-2xl font-bold tracking-tight outline-none focus:border-emerald-500/50" />
            <button onClick={saveName} disabled={savingName} className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer</button>
            <button onClick={() => setEditingName(false)} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Annuler</button>
          </div>
        ) : (
          <div className="group flex items-center gap-2">
            <h1 className="font-display text-3xl font-bold tracking-tight">{name}</h1>
            <button onClick={() => { setDraftName(name); setEditingName(true); }} title="Renommer le dossier" className="rounded-lg p-1.5 text-zinc-500 opacity-0 transition hover:bg-white/5 hover:text-emerald-400 group-hover:opacity-100"><PencilLine className="h-4 w-4" /></button>
          </div>
        )}
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
        <div className="flex flex-col gap-6 lg:flex-row">
          <nav className="space-y-5 lg:sticky lg:top-4 lg:w-56 lg:shrink-0 lg:self-start">
            {sideGroups.map((g) => (
              <div key={g.label}>
                <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{g.label}</div>
                <div className="space-y-0.5">
                  {g.items.map((id) => {
                    const t = meta[id];
                    return (
                      <button key={id} onClick={() => setTab(id)}
                        className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
                          tab === id ? 'bg-emerald-500/15 text-emerald-200' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200')}>
                        <t.icon className="h-4 w-4 shrink-0" /> {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="min-w-0 flex-1">
            {/* Barre horizontale : catégories comptabilité et suivantes, en menus déroulants. */}
            <div ref={barRef} className="mb-4 flex flex-wrap gap-2">
              {barGroups.map((g) => {
                const active = g.items.includes(tab);
                const open = openMenu === g.label;
                // Catégorie à un seul module : bouton direct (pas de déroulant).
                if (g.items.length === 1) {
                  const id = g.items[0];
                  return (
                    <button key={g.label} onClick={() => { setTab(id); setOpenMenu(null); }}
                      className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                        active ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10')}>
                      <g.icon className="h-4 w-4 shrink-0" /> {g.label}
                    </button>
                  );
                }
                return (
                  <div key={g.label} className="relative">
                    <button onClick={() => setOpenMenu(open ? null : g.label)}
                      className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                        active ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                          : open ? 'border-white/15 bg-white/10 text-zinc-100' : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10')}>
                      <g.icon className="h-4 w-4 shrink-0" />
                      {active ? meta[tab].label : g.label}
                      <ChevronDown className={cn('h-4 w-4 opacity-60 transition-transform', open && 'rotate-180')} />
                    </button>
                    {open && (
                      <div className="absolute left-0 top-full z-20 mt-1.5 min-w-[15rem] overflow-hidden rounded-xl border border-white/10 bg-zinc-900/95 p-1 shadow-xl shadow-black/40 backdrop-blur-xl">
                        <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{g.label}</div>
                        {g.items.map((id) => {
                          const t = meta[id];
                          return (
                            <button key={id} onClick={() => { setTab(id); setOpenMenu(null); }}
                              className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors',
                                tab === id ? 'bg-emerald-500/15 text-emerald-200' : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100')}>
                              <t.icon className="h-4 w-4 shrink-0" /> {t.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

          <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="min-w-0">
            {tab === 'synthese' && <DossierDashboard dossierId={dossier.id} currency={dossier.base_currency} fiscalYears={fiscalYears} onNavigate={(t) => setTab(t as Tab)} />}
            {tab === 'facturation' && <Facturation dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'achats' && <Achats dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'catalogue' && <Catalogue dossierId={dossier.id} currency={dossier.base_currency} />}
            {tab === 'paie' && <Paie dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'assistant' && <Assistant dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'analyse' && <AnalyseFinanciere dossierId={dossier.id} currency={dossier.base_currency} />}
            {tab === 'capture' && (
              <Capture dossierId={dossier.id} fiscalYears={fiscalYears} journals={journals}
                currency={dossier.base_currency} onPosted={() => { /* la balance se recharge à l'ouverture de l'onglet */ }} />
            )}
            {tab === 'saisie' && (
              <div key={editSeedKey}>
                <EntryForm dossierId={dossier.id} fiscalYears={fiscalYears} journals={journals}
                  initial={editSeed ?? undefined}
                  banner={editSeed ? "Écriture d'origine extournée. Corrigez ci-dessous puis validez : une nouvelle écriture sera comptabilisée." : undefined}
                  currency={dossier.base_currency} onPosted={() => { setEditSeed(null); /* la balance se recharge à l'ouverture de l'onglet */ }} />
              </div>
            )}
            {tab === 'mobilemoney' && (
              <MobileMoney dossierId={dossier.id} fiscalYears={fiscalYears}
                currency={dossier.base_currency} onImported={() => { /* balance se recharge à l'ouverture */ }} />
            )}
            {tab === 'balance' && <BalanceTab dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} />}
            {tab === 'grandlivre' && <GeneralLedger dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} />}
            {tab === 'journaux' && <Journaux dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency}
              onCorrect={(seed) => { setEditSeed(seed); setEditSeedKey((k) => k + 1); setTab('saisie'); }} />}
            {tab === 'tiers' && <Tiers dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} />}
            {tab === 'immos' && <Immobilisations dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'banque' && <BankReconciliation dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'etats' && <FinancialStatements dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} />}
            {tab === 'analytique' && <Analytique dossierId={dossier.id} currency={dossier.base_currency} fiscalYears={fiscalYears} />}
            {tab === 'budget' && <Budget dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} fiscalYears={fiscalYears} />}
            {tab === 'revision' && <Revision dossierId={dossier.id} currency={dossier.base_currency} fiscalYears={fiscalYears} />}
            {tab === 'clotures' && <Clotures dossierId={dossier.id} />}
            {tab === 'previsionnel' && <Previsionnel dossierId={dossier.id} currency={dossier.base_currency} />}
            {tab === 'scoring' && <Scoring dossierId={dossier.id} currency={dossier.base_currency} fiscalYears={fiscalYears} />}
            {tab === 'fiscalite' && <Fiscalite dossierId={dossier.id} dossierName={dossier.raison_sociale} currency={dossier.base_currency} />}
            {tab === 'regles' && <RulesTab dossierId={dossier.id} />}
            {tab === 'identite' && <FicheEntreprise dossierId={dossier.id} dossierName={name} onRenamed={(n) => { setName(n); dossier.raison_sociale = n; }} onDeleted={onBack} />}
            {tab === 'plan' && <PlanTab dossierId={dossier.id} />}
            {tab === 'import' && <div className="space-y-6"><ImportBalance dossierId={dossier.id} dossierName={dossier.raison_sociale} fiscalYears={fiscalYears} currency={dossier.base_currency} /><ImportLedger dossierId={dossier.id} fiscalYears={fiscalYears} /></div>}
            {tab === 'recurrences' && <Recurring dossierId={dossier.id} currency={dossier.base_currency} journals={journals} />}
            {tab === 'abonnements' && <RecurringInvoices dossierId={dossier.id} currency={dossier.base_currency} />}
            {tab === 'audit' && <AuditTrail dossierId={dossier.id} />}
            {tab === 'decisions' && <LexaDecisions dossierId={dossier.id} />}
            {tab === 'portail' && <ClientAccess dossierId={dossier.id} />}
          </motion.div>
          </div>
        </div>
      )}
    </div>
  );
}

// La balance est TOUJOURS celle d'un exercice : sans filtre, les à-nouveaux d'un
// exercice s'ajoutent aux mouvements de l'exercice précédent (double emploi) et
// les soldes de bilan sont faux. On sélectionne donc un exercice, par défaut le
// courant, comme le grand livre et les états financiers.
function BalanceTab({ dossierId, dossierName, fiscalYears, currency }: { dossierId: string; dossierName: string; fiscalYears: FiscalYear[]; currency: string }) {
  const [fy, setFy] = useState(currentFiscalYear(fiscalYears)?.id ?? '');
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<6 | 8>(6);
  // Bornage libre à l'intérieur de l'exercice : balance d'un mois, d'un
  // trimestre, ou arrêtée à une date.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => { setFy((f) => f || currentFiscalYear(fiscalYears)?.id || ''); }, [fiscalYears]);
  useEffect(() => { setFrom(''); setTo(''); }, [fy]);
  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try { setRows(await api.trialBalance(dossierId, fy || undefined, { from: from || undefined, to: to || undefined })); }
      finally { setLoading(false); }
    }, 200);
    return () => clearTimeout(t);
  }, [dossierId, fy, from, to]);

  const fyLabel = fiscalYears.find((f) => f.id === fy)?.label ?? '';
  const periode = from || to ? `${from || 'début'} → ${to || 'fin'}` : '';
  const champsPeriode = (
    <div className="flex items-center gap-1.5 text-xs text-zinc-500">
      <span>du</span>
      <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
        className="rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />
      <span>au</span>
      <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
        className="rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />
      {(from || to) && (
        <button onClick={() => { setFrom(''); setTo(''); }} title="Tout l'exercice"
          className="rounded-md px-1.5 py-1 text-zinc-500 hover:text-zinc-300">✕</button>
      )}
    </div>
  );
  const fySelect = fiscalYears.length > 0 && (
    <select value={fy} onChange={(e) => setFy(e.target.value)}
      className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-sm outline-none focus:border-emerald-500/50">
      {fiscalYears.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
    </select>
  );

  // La barre d'outils reste TOUJOURS montée : la démonter pendant le calcul
  // faisait perdre le focus et effaçait une date en cours de saisie, chaque
  // frappe relançant la requête. Seule la zone de résultat bascule.
  //
  // Repère de reprise : aucun à-nouveau alors que l'exercice précédent n'est pas
  // clôturé = les soldes de bilan ne sont pas repris (les comptes de bilan
  // repartent à zéro sur la période affichée).
  const fyIndex = fiscalYears.findIndex((f) => f.id === fy);
  const prevFy = fyIndex > 0 ? fiscalYears[fyIndex - 1] : undefined;
  const noOpening = rows.length > 0 && !!prevFy && prevFy.status !== 'closed'
    && rows.every((r) => r.open_debit === 0 && r.open_credit === 0);

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
    downloadCsv(`balance-${mode}col_${dossierName}_${fyLabel}${periode ? `_${from || ''}-${to || ''}` : ''}`.replace(/\s+/g, '-'), out);
  };
  const exportPdf = () => {
    const head = `<tr><th>Compte</th><th>Intitulé</th>${subHeaders.map((s) => `<th class="n">${s}</th>`).join('')}</tr>`;
    const body = rows.map((r) => `<tr><td>${r.account_code}</td><td>${(r.account_label ?? '').replace(/[&<>]/g, '')}</td>${vals(r).map((x) => `<td class="n">${x ? fmtMoney(x, currency) : ''}</td>`).join('')}</tr>`).join('');
    const tot = `<tr class="tot"><td colspan="2">Totaux</td>${totals.map((t) => `<td class="n">${fmtMoney(t, currency)}</td>`).join('')}</tr>`;
    printDocument(`Balance à ${mode} colonnes — ${dossierName}`, `${fyLabel ? `${fyLabel} · ` : ''}${periode ? `période ${periode} · ` : ''}devise ${currency} · édité le ${nowStamp()}`, `<table><thead>${head}</thead><tbody>${body}${tot}</tbody></table>`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-zinc-400">Balance générale des comptes</p>
          {fySelect}
          {champsPeriode}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} disabled={!rows.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><FileSpreadsheet className="h-4 w-4" /> Excel/CSV</button>
          <button onClick={exportPdf} disabled={!rows.length} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40"><Printer className="h-4 w-4" /> PDF</button>
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

      {noOpening && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
          Aucun à-nouveau sur cet exercice : les soldes de bilan de l'exercice précédent ne sont pas repris.
          Clôturez « {prevFy?.label} » (onglet Clôtures) pour générer les à-nouveaux.
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Calcul de la balance…</div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-zinc-400">
          Aucun mouvement comptabilisé sur {periode ? `la période ${periode}` : fyLabel ? `l'exercice « ${fyLabel} »` : 'cet exercice'}.
        </p>
      ) : (
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
      )}
    </div>
  );
}

function PlanTab({ dossierId }: { dossierId: string }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const load = async () => { setLoading(true); try { setRows(await api.accounts(dossierId, q || undefined, showAll)); } finally { setLoading(false); } };
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [dossierId, q, showAll]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.createAccount(dossierId, { accountCode: code.trim(), label: label.trim() }); setCode(''); setLabel(''); setCreating(false); await load(); }
    catch (e: any) { setError(e.message); }
  };
  const saveLabel = async (a: Account) => { setError(null); try { await api.updateAccount(dossierId, a.id, { label: editLabel.trim() }); setEditId(null); await load(); } catch (e: any) { setError(e.message); } };
  const toggleActive = async (a: Account) => { setError(null); try { await api.updateAccount(dossierId, a.id, { isActive: !(a.is_active ?? true) }); await load(); } catch (e: any) { setError(e.message); } };
  const remove = async (a: Account) => { if (!confirm(`Supprimer le compte ${a.account_code} ?`)) return; setError(null); try { await api.deleteAccount(dossierId, a.id); await load(); } catch (e: any) { setError(e.message); } };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un compte (code ou libellé)…"
            className="w-full rounded-lg border border-white/10 bg-zinc-900/50 py-2 pl-9 pr-4 text-sm outline-none focus:border-emerald-500/50" />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-zinc-400"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-emerald-500" /> inclure inactifs</label>
        <button onClick={() => downloadAuthed(`/api/dossiers/${dossierId}/accounts/export?format=csv`, 'plan-comptable.csv')} title="Exporter le plan comptable (codes complétés à 8 chiffres)" className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10"><FileSpreadsheet className="h-4 w-4" /> Exporter (CSV)</button>
        <button onClick={() => downloadAuthed(`/api/dossiers/${dossierId}/accounts/export?format=pdf`, 'plan-comptable.pdf')} title="Plan comptable en PDF" className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10"><Printer className="h-4 w-4" /> PDF</button>
        <button onClick={() => setCreating((v) => !v)} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"><Plus className="h-4 w-4" /> Nouveau compte</button>
      </div>

      {creating && (
        <form onSubmit={create} className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div><label className="mb-1 block text-xs text-zinc-500">Code (jusqu'à 8 chiffres)</label><input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" maxLength={8} placeholder="60110000" className="w-36 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500/50" /></div>
            <div className="flex-1 min-w-[12rem]"><label className="mb-1 block text-xs text-zinc-500">Intitulé</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Achat de tissu wax — fournisseur X" className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50" /></div>
            <button type="submit" className="flex h-[38px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-400">Créer</button>
          </div>
          <p className="text-xs text-zinc-500">Le compte doit se rattacher au plan SYSCOHADA : créez un sous-compte détaillé en prolongeant un compte officiel (ex. <span className="font-mono text-zinc-400">6011</span> ou <span className="font-mono text-zinc-400">60110000</span> sous <span className="font-mono text-zinc-400">601</span>). Les codes non conformes sont refusés.</p>
        </form>
      )}
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/5 text-xs uppercase text-zinc-400">
            <tr><th className="px-5 py-3 font-medium">Code</th><th className="px-5 py-3 font-medium">Intitulé</th><th className="px-5 py-3 font-medium">Classe</th><th className="px-5 py-3"></th></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? <tr><td colSpan={4} className="px-5 py-4 text-zinc-400">Recherche…</td></tr> : rows.map((a) => (
              <tr key={a.id} className={cn('hover:bg-white/5', a.is_active === false && 'opacity-50')}>
                <td className="px-5 py-2.5 font-mono text-zinc-300">{a.account_code}</td>
                <td className="px-5 py-2.5 text-zinc-300">
                  {editId === a.id
                    ? <input value={editLabel} autoFocus onChange={(e) => setEditLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveLabel(a)} onBlur={() => saveLabel(a)} className="w-full rounded border border-emerald-500/40 bg-zinc-900/60 px-2 py-1 text-sm outline-none" />
                    : <span onClick={() => { setEditId(a.id); setEditLabel(a.label); }} className="cursor-text">{a.label}{a.is_active === false && <span className="ml-2 text-xs text-zinc-500">(inactif)</span>}</span>}
                </td>
                <td className="px-5 py-2.5 text-zinc-500">{a.class_no}</td>
                <td className="px-5 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => toggleActive(a)} title={a.is_active === false ? 'Réactiver' : 'Désactiver'} className="text-zinc-500 hover:text-amber-400"><Power className="h-4 w-4" /></button>
                    <button onClick={() => remove(a)} title="Supprimer (si non mouvementé)" className="text-zinc-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && <p className="text-xs text-zinc-500">{rows.length} compte(s){!q && ' (100 premiers — affinez la recherche)'} · cliquez un intitulé pour le renommer.</p>}
    </div>
  );
}
