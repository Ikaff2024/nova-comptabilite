import { getToken, clearToken } from './session';

// Client API typé. Passe par le proxy Vite (/api -> Express), donc chemins
// relatifs. L'identité voyage dans Authorization: Bearer <JWT>.

const BASE = (import.meta as any).env?.VITE_API_BASE ?? '';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // 401 sans challenge 2FA = session invalide -> on nettoie le jeton.
    if (res.status === 401 && body.code !== '2FA_REQUIRED' && body.code !== '2FA_INVALID') clearToken();
    // 502/503/504 : le serveur redémarre (mise à jour) ou est momentanément
    // injoignable. Ce n'est pas une erreur de saisie : on le dit clairement,
    // car la réponse du proxy n'est pas du JSON exploitable.
    if (res.status >= 502 && res.status <= 504) {
      throw new ApiError("Le serveur est momentanément indisponible (mise à jour en cours). Patientez quelques secondes et réessayez — rien n'a été perdu.", res.status, 'SERVER_UNAVAILABLE');
    }
    throw new ApiError(body.error ?? `Erreur ${res.status}`, res.status, body.code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Récupère une pièce (avec le jeton) et renvoie une URL objet affichable/téléchargeable.
export async function fetchDocumentUrl(path: string): Promise<string> {
  const token = getToken();
  const res = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error('Pièce inaccessible');
  return URL.createObjectURL(await res.blob());
}

// Télécharge un fichier servi par l'API (avec le jeton) sous un nom donné.
export async function downloadAuthed(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error('Téléchargement impossible');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface Cabinet { id: string; name: string; country: string; base_currency: string; account_type?: 'cabinet' | 'entreprise'; }
export type CoherenceNiveau = 'haute' | 'moyenne' | 'info' | 'ok';
export interface InterModuleCheck { module: string; regle: string; libelle: string; attendu: number; constate: number; ecart: number; niveau: CoherenceNiveau; explication: string; }
export interface InterModuleReport { dossierId: string; devise: string; exercice: string | null; annee: number; resume: { haute: number; moyenne: number; info: number; ok: number; total: number }; niveauGlobal: CoherenceNiveau; controles: InterModuleCheck[]; }
export interface FiscalConseil { niveau: 'haute'|'moyenne'|'info'; categorie: string; titre: string; detail: string; montant?: number }
export interface FiscalAdvice { devise: string; conseils: FiscalConseil[] }
export interface QualityAxis { key: string; label: string; score: number; weight: number; detail: string }
export interface QualityScore { score: number; rating: 'A'|'B'|'C'|'D'; axes: QualityAxis[]; forces: string[]; faiblesses: string[]; }
export interface SimulationResult { devise: string; equilibre: { debit: number; credit: number; ecart: number; equilibree: boolean }; deltaResultat: number; deltaTva: number; deltaTresorerie: number; deltaIsEstime: number; details: string[]; }
export interface Dossier {
  id: string; cabinet_id: string; raison_sociale: string; country: string;
  base_currency: string; accounting_system: string; is_active: boolean;
  role?: string | null; // rôle du demandeur : 'staff' | 'client' | 'lecture' | …
}
export interface DossierClient { userId: string; email: string; name: string | null; role: string; createdAt: string; }
export interface DossierDocument { id: string; filename: string | null; mimeType: string; size: number; entryId: string | null; createdAt: string; url: string; }
export interface Account {
  id: string; account_code: string; label: string; class_no: number;
  account_type: string; normal_side: string; is_collective: boolean; is_postable: boolean; is_active?: boolean;
}
export interface FiscalYear { id: string; label: string; start_date: string; end_date: string; status: string; }
// Exercice par défaut pour la saisie : celui qui contient AUJOURD'HUI ; à défaut
// le dernier exercice ouvert ; à défaut le plus récent. (Les exercices arrivent
// triés du plus ancien au plus récent : ne jamais prendre [0] aveuglément.)
export function currentFiscalYear(fys: FiscalYear[]): FiscalYear | undefined {
  if (!fys.length) return undefined;
  const today = new Date().toISOString().slice(0, 10);
  return fys.find((f) => f.start_date <= today && today <= f.end_date)
    ?? [...fys].reverse().find((f) => f.status !== 'closed')
    ?? fys[fys.length - 1];
}
export interface Journal { id: string; code: string; label: string; type: string; }
export interface DashboardData {
  dossierCount: number; totalEntries: number; entriesThisMonth: number;
  autoCodedPct: number; resultatCumule: number;
  perDossier: { id: string; raisonSociale: string; currency: string; entries: number; drafts: number; autoPct: number; resultat: number; lastDate: string | null; needsSetup: boolean }[];
  sourceBreakdown: { source: string; label: string; count: number }[];
  alerts: { type: string; dossierId: string; dossierName: string; message: string }[];
}
export interface DossierAlerts {
  dossierId: string; devise: string; genereLe: string;
  resume: { haute: number; moyenne: number; info: number; total: number };
  alertes: { niveau: 'haute' | 'moyenne' | 'info'; categorie: string; titre: string; detail?: string; montant?: number; echeance?: string; onglet?: string }[];
}
export interface FinancialRatios {
  devise: string; chiffreAffaires: number; soldes: Record<string, number>;
  ratios: { cle: string; libelle: string; valeur: number | null; unite: 'ratio' | 'pourcent' | 'jours' | 'montant'; formule: string; niveau?: 'bon' | 'moyen' | 'faible'; commentaire?: string }[];
}
export interface CoherenceReport {
  dossierId: string; devise: string; nbComptesAnalyses: number;
  resume: { haute: number; moyenne: number; info: number; total: number };
  anomalies: { niveau: 'haute' | 'moyenne' | 'info'; regle: string; compte: string; intitule: string; solde: number; sens: string; explication: string }[];
}
export interface UsageSummary {
  days: number;
  indisponible?: boolean;
  total: { costUsd: number; appels: number };
  parProvider: { provider: string; label: string; cost: number; appels: number }[];
  dossiers: { dossierId: string; raisonSociale: string; costUsd: number; appels: number; providers: Record<string, number> }[];
}
export interface FinancialStatements {
  incomeStatement: {
    produits: { group: string; label: string; amount: number }[];
    charges: { group: string; label: string; amount: number }[];
    totalProduits: number; totalCharges: number; resultatNet: number;
    sig: { label: string; amount: number; strong: boolean }[];
  };
  balanceSheet: {
    actif: { label: string; amount: number }[];
    passif: { label: string; amount: number }[];
    totalActif: number; totalPassif: number; equilibre: boolean;
  };
}
export interface QualityToolStat { name: string; n: number; ok: number; failRate: number; pass: number; warn: number; fail: number; isValidator: boolean }
export interface QualityDashboard {
  available: boolean;
  total?: number; avgConfidence?: number | null; lowConfidence?: number; since?: string | null; until?: string | null;
  aqm?: { pass: number; warn: number; fail: number };
  tools?: QualityToolStat[];
  lowConfidenceRecent?: { id: string; createdAt: string; question: string | null; confidence: number }[];
}
export interface DecisionToolRef { name: string; ok: boolean; verdict?: string }
export interface DecisionSummary { id: string; createdAt: string; question: string | null; mode: string | null; model: string | null; confidence: number | null; tools: DecisionToolRef[]; nbValidations: number }
export interface DecisionDetail extends DecisionSummary { answer: string | null; validations: { input: any; report: ValidationReport }[]; tokensIn: number | null; tokensOut: number | null }
export interface ValidationCheck { code: string; label: string; level: 'pass' | 'warning' | 'fail'; detail?: string }
export interface ValidationReport { verdict: 'PASS' | 'WARNING' | 'FAIL'; score: number; checks: ValidationCheck[]; summary: string }
export interface IsEstimate {
  fiscalYearId: string | null;
  chiffreAffaires: number; resultatComptable: number; beneficeImposable: number; beneficiaire: boolean;
  tauxIS: number; isTheorique: number;
  tauxIMF: number; imf: number; imfPlancher: number; imfPlafond: number;
  impotDu: number; baseRetenue: string; acompteProvisionnel: number; note: string;
}
export interface ComparativeFS {
  currentLabel: string | null; previousLabel: string | null;
  current: FinancialStatements; previous: FinancialStatements | null;
}
export interface MMProposal {
  externalRef: string; date: string; direction: 'in' | 'out'; amount: number;
  counterparty?: string; description: string; channel: string;
  counterAccount: string; counterLabel: string | null; alreadyImported: boolean;
}
export interface Mapping {
  id: string; keyword: string; account_code: string; hits: number;
  source: 'manual' | 'learned'; account_label: string | null;
}
export interface Counterparty { id: string; type: string; name: string; aux_code: string | null; tax_id: string | null; email?: string | null; collective: string | null; }
export interface AuxBalanceRow { id: string; aux_code: string | null; name: string; type: string; collective: string; debit: number; credit: number; balance: number; }
export interface AuxLedgerRow { entry_date: string; journal_code: string; piece_ref: string | null; account_code: string; label: string; debit: number; credit: number; }
export interface BankAccount { account_code: string; label: string; moves: number; unpointed: number; }
export interface ReconMove { entry_line_id: string; entry_date: string; journal_code: string; piece_ref: string | null; label: string; debit: number; credit: number; pointed: boolean; }
export interface ReconView { balance: number; pointedBalance: number; moves: ReconMove[]; }
export interface StatementRow { date: string; label: string; amount: number }
export interface StatementMatch {
  matched: { statement: StatementRow; entryLineId: string; ledgerDate: string; pieceRef: string | null; label: string; amount: number }[];
  unmatchedStatement: StatementRow[];
  unmatchedLedger: { entryLineId: string; date: string; pieceRef: string | null; label: string; net: number }[];
  counts: { statement: number; matched: number; alreadyReconciled: number; unmatchedStatement: number; unmatchedLedger: number };
  statementFlow: number;
}
export interface TiersAccount { account_code: string; label: string; open_count: number; }
export interface OpenItem { entry_line_id: string; entry_date: string; journal_code: string; piece_ref: string | null; label: string; debit: number; credit: number; }
export interface LetteredItem { id: string; code: string; entry_date: string; piece_ref: string | null; label: string; debit: number; credit: number; }
export interface AgedRow { account_code: string; label: string; balance: number; b0_30: number; b31_60: number; b61_90: number; b90_plus: number; }
export interface OverdueClient {
  counterpartyId: string; name: string; auxCode: string; balance: number;
  b0_30: number; b31_60: number; b61_90: number; b90_plus: number; oldestAge: number;
  lastLevel: number; lastSentAt: string | null;
}
export interface RelanceLetter {
  name: string; auxCode: string; asOf: string; total: number; suggestedLevel: number;
  open: { date: string; piece_ref: string | null; label: string; amount: number; age: number }[];
}
export interface VatDeclaration {
  from: string; to: string; collectee: number; deductible: number; netDue: number; creditReportable: number;
  breakdown: { account_code: string; label: string; debit: number; credit: number }[];
}
export interface ImportBalanceLine {
  accountCode: string; label: string | null; debit: number; credit: number;
  status: 'ok' | 'missing'; existingLabel?: string;
}
export interface ImportBalanceAnalysis {
  lines: ImportBalanceLine[];
  totalDebit: number; totalCredit: number; diff: number; balanced: boolean;
  okCount: number; missingCount: number; alreadyImported: boolean;
}
export interface TiersOpenItem {
  accountCode: string; tiersName: string; pieceRef?: string; invoiceDate?: string; dueDate?: string; debit: number; credit: number;
}
export interface RecurringLine { accountCode: string; debit?: number; credit?: number; label?: string; analyticAxis?: string }
export interface RecurringTemplate {
  id: string; label: string; journalCode: string; frequency: string; frequencyLabel: string;
  dayOfMonth: number; startDate: string; endDate: string | null; counterpartyName: string | null;
  lines: RecurringLine[]; amount: number; active: boolean; generated: number; due: number;
}
export interface DossierDashboard {
  fiscalYear: { id: string; label: string } | null;
  kpis: { resultat: number; chiffreAffaires: number; tresorerie: number; creances: number; dettesFrs: number; vncTotal: number };
  activity: { posted: number; drafts: number; thisMonth: number; autoPct: number };
  vat: { collectee: number; deductible: number; netDue: number; creditReportable: number; period: string };
  monthly: { month: string; produits: number; charges: number; resultat: number }[];
  topClients: { name: string; amount: number }[];
  topFournisseurs: { name: string; amount: number }[];
  aged: { overdue90: number };
  recent: { date: string; piece_ref: string; description: string; source: string; journal: string; amount: number }[];
  alerts: { level: 'info' | 'warn'; message: string; tab?: string }[];
}
export interface AuditEntry {
  id: number; created_at: string; user_name: string | null; user_email: string | null;
  action: string; entity: string | null; entity_id: string | null; detail: Record<string, any>;
}
export interface FixedAsset {
  id: string; label: string;
  assetAccountCode: string; amortAccountCode: string; expenseAccountCode: string;
  acquisitionDate: string; commissioningDate: string;
  amount: number; residualValue: number; durationYears: number; method: string; depreciationPeriod: 'annual' | 'monthly';
  counterpartyName: string | null; notes: string | null; status: string;
  cumulPosted: number; vnc: number; pending: number; fullyAmortized: boolean;
  disposalDate: string | null; salePrice: number | null; plusValue: number | null;
}
export interface AssetScheduleRow { periodDate: string; label: string; rate: number; dotation: number; cumul: number; vnc: number; posted: boolean; entryId: string | null; }
export interface FixedAssetDetail {
  id: string; label: string;
  assetAccountCode: string; amortAccountCode: string; expenseAccountCode: string;
  acquisitionDate: string; commissioningDate: string;
  amount: number; residualValue: number; durationYears: number; method: string; depreciationPeriod: 'annual' | 'monthly';
  notes: string | null; status: string; schedule: AssetScheduleRow[];
}
export interface Invoice {
  id: string; number: string | null; client_name: string; invoice_date: string; status: string; doc_type: string;
  total_ht: number; total_tva: number; total_ttc: number; fne_status: string; fne_reference: string | null; currency: string; source_document_id?: string | null;
}
export interface InvoiceLine { id?: string; line_no?: number; description: string; quantity: number; unit_price: number; vat_rate: number; account_code: string; analytic_axis?: string | null; amount_ht?: number; amount_tva?: number; }
export interface InvoiceDetail extends Invoice { counterparty_id: string | null; due_date: string | null; entry_id: string | null; fne_qr: string | null; notes: string | null; lines: InvoiceLine[]; }
export interface Purchase {
  id: string; supplier_name: string; supplier_ref: string | null; invoice_date: string; due_date: string | null;
  status: string; total_ht: number; total_tva: number; total_ttc: number; currency: string; entry_id: string | null; payment_entry_id: string | null;
}
export interface PurchaseLine { id?: string; line_no?: number; description: string; account_code: string; analytic_axis?: string | null; amount_ht: number; vat_rate: number; amount_tva?: number; }
export interface PurchaseDetail extends Purchase { counterparty_id: string | null; notes: string | null; lines: PurchaseLine[]; }
export interface PurchaseDuplicate { id: string; supplier_name: string; supplier_ref: string | null; invoice_date: string; total_ttc: number; status: string; reason: 'ref' | 'amount'; }
export interface PeriodClosure { year: number; month: number; label: string; closed_at: string; }
export interface ClosuresData { closures: PeriodClosure[]; closedThrough: { year: number; month: number; label: string } | null; }
export interface CatalogItem { id: string; kind: 'bien' | 'service'; reference: string | null; label: string; unit: string | null; unit_price: number; vat_rate: number; account_code: string; active: boolean; }
export interface CatalogItemInput { kind?: 'bien' | 'service'; reference?: string; label: string; unit?: string; unitPrice?: number; vatRate?: number; accountCode?: string; active?: boolean; }
export interface SupplierAging {
  counterpartyId: string; name: string; auxCode: string; balance: number;
  b0_30: number; b31_60: number; b61_90: number; b90_plus: number; oldestAge: number;
}
export interface JournalLine {
  entry_id: string; entry_date: string; journal_code: string; piece_ref: string | null;
  entry_description: string; source: string; document_url: string | null; account_code: string; label: string; debit: number; credit: number;
}
export interface LedgerRow {
  account_code: string; account_label: string;
  entry_date: string; journal_code: string; piece_ref: string | null;
  description: string; line_label: string | null; debit: number; credit: number;
}
export interface BalanceRow {
  account_code: string; account_label: string;
  open_debit: number; open_credit: number;
  period_debit: number; period_credit: number;
  total_debit: number; total_credit: number; balance: number;
}
export interface EntryLineInput {
  accountCode: string; debit?: number; credit?: number; label?: string; paymentChannel?: string; analyticAxis?: string;
}
export interface FinancingRequest {
  id: string; amount: number; score: number | null; rating: string | null; status: string; note: string | null;
  disbursedAmount: number; repaidAmount: number; outstanding: number; requestedAt: string; disbursedAt: string | null;
}
export interface CreditScore {
  score: number; rating: string;
  axes: { key: string; label: string; score: number; weight: number }[];
  strengths: string[]; weaknesses: string[];
  financing: { eligible: boolean; amount: number; note: string };
  metrics: { tresorerie: number; resultat: number; ca: number; caMensuel: number; creances: number; capitauxPropres: number; dettesFin: number; overdue90: number };
}
export interface EcheanceItem { tiers: string; piece: string | null; date: string; echeance: string | null; montant: number; jours: number | null; statut: string; echu: boolean; }
export interface Echeancier {
  creances: EcheanceItem[]; dettes: EcheanceItem[];
  resume: { total_a_encaisser: number; total_a_payer: number; creances_echues: number; dettes_echues: number; a_encaisser_30j: number; a_payer_30j: number; solde_net_30j: number };
}
export interface CashForecast {
  currentCash: number; projectedBalance: number; minBalance: number; minWeek: string; horizonWeeks: number; delayDays: number;
  weeks: { weekStart: string; inflows: number; outflows: number; net: number; balance: number }[];
  upcoming: { date: string; label: string; amount: number; kind: string }[];
  events: { date: string; label: string }[];
}
export interface RevisionAccount { account_code: string; label: string; classNo: number; cycle: string; balance: number; status: string; note: string | null; }
export interface RevisionReport { accounts: RevisionAccount[]; progress: { total: number; reviewed: number }; }
export interface EntryTemplate { id: string; name: string; journalCode: string | null; lines: { accountCode: string; label?: string; debit?: number; credit?: number }[]; }
export interface Obligation { id: string; label: string; periodicity: string; dueDay: number; dueMonth: number | null; active: boolean; nextDue: string | null; daysLeft: number | null; }
export interface BudgetRow { account_code: string; label: string; classNo: number; budget: number; realise: number; ecart: number; pct: number | null; }
export interface BudgetReport {
  rows: BudgetRow[];
  totals: { chargesBudget: number; chargesRealise: number; produitsBudget: number; produitsRealise: number; resultatBudget: number; resultatRealise: number };
}
export interface GeneratedLine { account_code: string; label: string; classNo: number; base: number; taux: number; montant: number; provenance: { base_realise: number; annee_base: string; taux_applique: number; confiance: string }; }
export interface GeneratedBudget { priorYear: string | null; assumptions: { growthProduits: number; inflationCharges: number }; lines: GeneratedLine[]; totals: { produits: number; charges: number; resultat: number }; questions: string[]; }
export interface ScenarioRow { key: string; label: string; hypotheses: string; growthProduits: number; inflationCharges: number; produits: number; charges: number; resultat: number; margeNette: number | null; }
export interface ScenariosReport { priorYear: string | null; base: { produits: number; charges: number }; scenarios: ScenarioRow[]; }
export interface ProvisionalReport {
  scenario: { key: string; label: string }; stress: number; priorYear: string | null;
  compteResultat: { produits: number; charges: number; resultat: number; margeNette: number | null };
  tresorerie: { position_actuelle: number; net_mensuel: number; mensuel: { mois: string; encaissements: number; decaissements: number; solde_fin: number }[]; tresorerie_mini: number };
  indicateurs: { marge_nette_pct: number | null; resultat_projete: number; bfr: number | null; tresorerie_mini: number; alerte_tresorerie: boolean };
  bilanSimplifie: { capitaux_propres_actuels: number; resultat_projete: number; capitaux_propres_projetes: number; bfr_actuel: number | null; tresorerie_actuelle: number; tresorerie_projetee_fin: number };
}
export interface ForecastRow extends BudgetRow { budgetProrata: number; ecartRythme: number; projete: number; ecartProjete: number; }
export interface RollingForecast {
  period: { label: string; start: string; end: string; monthsElapsed: number; fractionElapsed: number };
  rows: ForecastRow[];
  totals: BudgetReport['totals'] & { produitsProjete: number; chargesProjete: number; resultatProjete: number };
  hasBudget: boolean;
}
export interface AnalyticSection { id: string; code: string; label: string; }
export interface AnalyticReport {
  sections: { code: string; label: string; produits: number; charges: number; resultat: number }[];
  totals: { produits: number; charges: number; resultat: number };
}
export interface AnalyticDetail {
  code: string; label: string;
  lines: { date: string; journal: string; pieceRef: string | null; accountCode: string; accountLabel: string; classNo: number; label: string; debit: number; credit: number; montant: number }[];
  byAccount: { accountCode: string; accountLabel: string; classNo: number; montant: number; count: number }[];
  totals: { produits: number; charges: number; resultat: number };
}
export interface AnalyticMonthly {
  months: string[];
  sections: { code: string; label: string; monthly: number[]; total: number }[];
  monthTotals: number[];
}
export interface AgentMessage { role: 'user' | 'assistant'; content: string }
export type AgentMode = 'readonly' | 'assist' | 'assist_plus';
export interface AgentAqm { verdict: 'PASS' | 'WARNING' | 'FAIL'; score: number; checks: { label: string; level: string; detail?: string }[]; count: number }
export interface AgentResult { reply: string; toolCalls: { name: string; input: any }[]; model: string; mode: AgentMode; aqm?: AgentAqm }
export interface VoiceCatalogItem { id: string; name: string; desc: string }
export interface VoiceConfig { provider: string; voiceId: string | null; providers: string[]; catalog: Record<string, VoiceCatalogItem[]> }
export interface AgentStatus { enabled: boolean; mode: AgentMode; canToggle: boolean; tts?: boolean; voice?: VoiceConfig }

// Synthèse vocale serveur (fournisseur/voix du dossier). Renvoie un Blob audio,
// ou null si indisponible (204) — le front bascule alors sur la voix navigateur.
export async function lexaSpeak(dossierId: string, text: string): Promise<Blob | null> {
  const token = getToken();
  const res = await fetch(BASE + `/api/dossiers/${dossierId}/lexa/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ text }),
  });
  if (res.status === 204 || !res.ok) return null;
  return res.blob();
}
export interface PayrollEmployee {
  id: string; matricule: string; nom: string; prenoms: string; poste?: string;
  categorie: string; statutMatrimonial: string; nombreEnfants: number; nombrePartsIGR: number;
  dateEmbauche: string; dateNaissance?: string;
  salaireBase: number; sursalaire: number; indemniteTransport: number; indemniteLogement: number; autresPrimes: number;
  email?: string; telephone?: string; actif: boolean;
}
export interface Payslip {
  id: string; employeeId: string; matricule: string; nom: string; prenoms: string;
  brut: number; net: number; cout: number; comptabilise: boolean; entryId: string | null; calculation: any;
}
export interface PayrollRunResult { count: number; totalBrut: number; totalNet: number; totalCoutEmployeur: number }
export const AGENT_WRITE_TOOLS = new Set(['preparer_facture_vente', 'preparer_facture_achat', 'lettrer_automatiquement', 'preparer_relance_client']);
export const AGENT_MODE_LABELS: Record<AgentMode, string> = { readonly: 'Lecture seule', assist: 'Assisté (brouillons)', assist_plus: 'Assisté + actions' };
export interface ProposedLine {
  accountCode: string; accountLabel?: string; debit?: number; credit?: number; label?: string;
}
export interface CaptureProposal {
  description: string; entryDate?: string; journalCode?: string; counterpartyName?: string;
  currency: string; confidence: number; lines: ProposedLine[]; warnings?: string[];
}

export interface AuthUser { id: string; email: string; name: string | null; twoFactorEnabled?: boolean; platformAdmin?: boolean; }
export interface PlatformCabinet {
  cabinetId: string; name: string; country: string; createdAt: string;
  dossiers: number; membres: number; ecritures: number;
  cost30d: number; costTotal: number; lastActivity: string | null;
}
export interface PlatformOverview {
  cabinets: PlatformCabinet[];
  totals: { cabinets: number; dossiers: number; ecritures: number; cost30d: number; costTotal: number; actifs30j: number };
  generatedAt: string;
}
export interface CabinetMember { userId: string; email: string; name: string | null; role: string; createdAt: string; }
export interface PendingInvitation { id: string; email: string; role: string; created_at: string; expires_at: string; expired: boolean; }
export interface MemberAccess { restricted: boolean; dossiers: { id: string; raisonSociale: string; granted: boolean }[]; }
export interface NightlyItem { niveau: 'haute' | 'moyenne' | 'info'; categorie: string; titre: string; detail?: string; montant?: number; echeance?: string; onglet?: string; }
export interface NightlyResume { haute: number; moyenne: number; info: number; total: number; }
export interface NightlyState { enabled: boolean; dernier: { generated_at: string; resume: NightlyResume; items: NightlyItem[]; notified_to: string | null } | null; }
export interface FinancingBrief { montant?: number; objet?: string; dureeMois?: number; tauxAnnuel?: number; garanties?: string; engagements?: string; banque?: string; }
export interface FinancingReadinessItem { key: string; label: string; ok: boolean; blocking: boolean; detail: string; }
export interface FinancingCapacity { resultat: number; dotations: number; caf: number; montant: number; dureeMois: number; tauxAnnuel: number; mensualite: number; annuite: number; couverture: number | null; }
export interface FinancingReadiness { pourcentage: number; pret: boolean; bloquants: number; items: FinancingReadinessItem[]; capacite: FinancingCapacity; }
export interface LedgerAnalysis { entries: number; movements: number; totalDebit: number; totalCredit: number; balanced: boolean; unbalanced: { date: string; journal: string; piece: string; ecart: number }[]; missingAccounts: string[]; invalidDates: number; outOfRange: number; alreadyImported: boolean; }
export interface DossierProfile {
  raisonSociale: string; adresse: string | null; ville: string | null; telephone: string | null;
  taxId: string | null; rccm: string | null; numeroCnps: string | null;
  formeJuridique: string | null; regimeFiscal: string | null;
  bankName: string | null; rib: string | null; country: string; baseCurrency: string;
}
export interface InvitationInfo { email: string; role: string; cabinetName: string; expired: boolean; accepted: boolean; }

export const api = {
  register: (email: string, password: string, name: string) =>
    req<{ token: string; user: AuthUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string, code?: string) =>
    req<{ token: string; user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, code }) }),
  me: () => req<AuthUser>('/api/auth/me'),
  updateMyName: (name: string) => req<void>('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) }),
  setup2fa: () => req<{ secret: string; otpauth: string }>('/api/auth/2fa/setup', { method: 'POST', body: '{}' }),
  enable2fa: (code: string) => req<{ enabled: boolean }>('/api/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  disable2fa: () => req<{ enabled: boolean }>('/api/auth/2fa/disable', { method: 'POST', body: '{}' }),
  cabinetTriage: () => req<CabinetTriage>('/api/cabinet/triage'),
  runCabinetTriage: () => req<{ analyses: number; ignores: number }>('/api/cabinet/triage/run', { method: 'POST', body: '{}' }),
  nightly: (dossierId: string) => req<NightlyState>(`/api/dossiers/${dossierId}/nightly`),
  setNightly: (dossierId: string, enabled: boolean) => req<void>(`/api/dossiers/${dossierId}/nightly`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  runNightly: (dossierId: string, notify = false) =>
    req<{ resume: NightlyResume; items: NightlyItem[]; notified: string | null }>(`/api/dossiers/${dossierId}/nightly/run`, { method: 'POST', body: JSON.stringify({ notify }) }),
  fiscalAdvice: (dossierId: string, fiscalYearId?: string) => req<FiscalAdvice>(`/api/dossiers/${dossierId}/fiscal-advice${fiscalYearId ? '?fiscalYearId=' + fiscalYearId : ''}`),
  qualityScore: (dossierId: string, fiscalYearId?: string) => req<QualityScore>(`/api/dossiers/${dossierId}/quality-score${fiscalYearId ? '?fiscalYearId=' + fiscalYearId : ''}`),
  coherence: (dossierId: string, fiscalYearId?: string) => req<InterModuleReport>(`/api/dossiers/${dossierId}/coherence${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  simulateEntry: (dossierId: string, lines: { accountCode: string; debit?: number; credit?: number }[]) => req<SimulationResult>(`/api/dossiers/${dossierId}/simulate-entry`, { method: 'POST', body: JSON.stringify({ lines }) }),
  renameCabinet: (cabinetId: string, name: string) => req<void>(`/api/cabinets/${cabinetId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  setCabinetType: (cabinetId: string, accountType: 'cabinet' | 'entreprise') => req<void>(`/api/cabinets/${cabinetId}`, { method: 'PATCH', body: JSON.stringify({ accountType }) }),
  emailStatus: () => req<{ enabled: boolean; from: string; testSender: boolean }>('/api/email/status'),
  emailTest: (to?: string) => req<{ ok: boolean; id: string; to: string; from: string; testSender: boolean }>('/api/email/test', { method: 'POST', body: JSON.stringify({ to }) }),
  memberAccess: (cabinetId: string, userId: string) => req<MemberAccess>(`/api/cabinets/${cabinetId}/members/${userId}/access`),
  setMemberAccess: (cabinetId: string, userId: string, restricted: boolean, dossierIds: string[]) =>
    req<void>(`/api/cabinets/${cabinetId}/members/${userId}/access`, { method: 'PUT', body: JSON.stringify({ restricted, dossierIds }) }),
  inviteMember: (cabinetId: string, email: string, role: string) =>
    req<{ status: 'added' | 'invited'; email: string; role: string }>(`/api/cabinets/${cabinetId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  invitations: (cabinetId: string) => req<PendingInvitation[]>(`/api/cabinets/${cabinetId}/invitations`),
  revokeInvitation: (cabinetId: string, id: string) => req<void>(`/api/cabinets/${cabinetId}/invitations/${id}`, { method: 'DELETE' }),
  invitationInfo: (token: string) => req<InvitationInfo>(`/api/invitations/${token}`),
  acceptInvitation: (token: string, body: { password?: string; name?: string }) =>
    req<{ status: 'joined' | 'created'; token?: string; user?: AuthUser }>(`/api/invitations/${token}/accept`, { method: 'POST', body: JSON.stringify(body) }),
  members: (cabinetId: string) => req<CabinetMember[]>(`/api/cabinets/${cabinetId}/members`),
  addMember: (cabinetId: string, email: string, role: string) => req<{ id: string }>(`/api/cabinets/${cabinetId}/members`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  setMemberRole: (cabinetId: string, uid: string, role: string) => req<void>(`/api/cabinets/${cabinetId}/members/${uid}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (cabinetId: string, uid: string) => req<void>(`/api/cabinets/${cabinetId}/members/${uid}`, { method: 'DELETE' }),
  cabinets: () => req<Cabinet[]>('/api/cabinets'),
  dashboard: () => req<DashboardData>('/api/dashboard'),
  usage: (days = 30) => req<UsageSummary>(`/api/usage?days=${days}`),
  platformOverview: () => req<PlatformOverview>('/api/platform/overview'),
  seedDemo: () => req<{ dossierId: string }>('/api/demo/seed', { method: 'POST', body: '{}' }),
  onboard: (name: string, country: string, accountType: 'cabinet' | 'entreprise' = 'cabinet') =>
    req<{ cabinetId: string }>('/api/onboarding/cabinet', { method: 'POST', body: JSON.stringify({ name, country, accountType }) }),
  dossiers: () => req<Dossier[]>('/api/dossiers'),
  corruptedLabels: (dossierId: string) => req<{ account_code: string; label: string }[]>(`/api/dossiers/${dossierId}/corrupted-labels`),
  repairLabels: (dossierId: string, csv: string) =>
    req<{ repaired: { code: string; old: string; new: string }[] }>(`/api/dossiers/${dossierId}/repair-labels`, { method: 'POST', body: JSON.stringify({ csv }) }),
  financingBrief: (dossierId: string) => req<FinancingBrief>(`/api/dossiers/${dossierId}/financing-dossier/brief`),
  saveFinancingBrief: (dossierId: string, brief: FinancingBrief) =>
    req<FinancingBrief>(`/api/dossiers/${dossierId}/financing-dossier/brief`, { method: 'PUT', body: JSON.stringify(brief) }),
  financingReadiness: (dossierId: string, fiscalYearId?: string) =>
    req<FinancingReadiness>(`/api/dossiers/${dossierId}/financing-dossier/readiness${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  dossierProfile: (dossierId: string) => req<DossierProfile>(`/api/dossiers/${dossierId}/profile`),
  updateDossierProfile: (dossierId: string, body: Partial<DossierProfile>) =>
    req<{ ok: boolean; raison_sociale: string; profile: DossierProfile }>(`/api/dossiers/${dossierId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  analyzeLedgerImport: (dossierId: string, csv: string, fiscalYearId?: string) => req<LedgerAnalysis>(`/api/dossiers/${dossierId}/import-ledger/analyze`, { method: 'POST', body: JSON.stringify({ csv, fiscalYearId }) }),
  commitLedgerImport: (dossierId: string, csv: string, fiscalYearId: string, createMissing: boolean) => req<{ entriesCreated: number; movements: number; accountsCreated: number; totalDebit: number }>(`/api/dossiers/${dossierId}/import-ledger/commit`, { method: 'POST', body: JSON.stringify({ csv, fiscalYearId, createMissing }) }),
  renameDossier: (dossierId: string, raisonSociale: string) =>
    req<{ ok: boolean; raison_sociale: string }>(`/api/dossiers/${dossierId}`, { method: 'PATCH', body: JSON.stringify({ raisonSociale }) }),
  createDossier: (input: { cabinetId: string; raisonSociale: string; country: string; accountingSystem?: string; taxId?: string; rccm?: string }) =>
    req<{ id: string; accounts: number }>('/api/dossiers', { method: 'POST', body: JSON.stringify(input) }),
  accounts: (dossierId: string, q?: string, all?: boolean) =>
    req<Account[]>(`/api/dossiers/${dossierId}/accounts?${q ? `q=${encodeURIComponent(q)}&` : ''}${all ? 'all=1' : ''}`),
  createAccount: (dossierId: string, body: { accountCode: string; label: string; isCollective?: boolean }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/accounts`, { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (dossierId: string, accId: string, body: { label?: string; isActive?: boolean }) =>
    req<void>(`/api/dossiers/${dossierId}/accounts/${accId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAccount: (dossierId: string, accId: string) =>
    req<void>(`/api/dossiers/${dossierId}/accounts/${accId}`, { method: 'DELETE' }),
  fiscalYears: (dossierId: string) => req<FiscalYear[]>(`/api/dossiers/${dossierId}/fiscal-years`),
  journals: (dossierId: string) => req<Journal[]>(`/api/dossiers/${dossierId}/journals`),
  createJournal: (dossierId: string, body: { code: string; label: string; type: string }) =>
    req<{ journalId: string }>(`/api/dossiers/${dossierId}/journals`, { method: 'POST', body: JSON.stringify(body) }),
  setupDossier: (dossierId: string) =>
    req<{ fiscalYears: FiscalYear[]; journals: Journal[] }>(`/api/dossiers/${dossierId}/setup`, { method: 'POST', body: '{}' }),
  postEntry: (dossierId: string, body: {
    fiscalYearId: string; journalId: string; entryDate: string; description: string;
    source?: string; counterpartyName?: string; documentUrl?: string; lines: EntryLineInput[];
  }) => req<{ id: string }>(`/api/dossiers/${dossierId}/entries`, { method: 'POST', body: JSON.stringify(body) }),
  validateEntry: (dossierId: string, body: { entryDate?: string; fiscalYearId?: string; journalCode?: string; lines: EntryLineInput[] }) =>
    req<ValidationReport>(`/api/dossiers/${dossierId}/validate-entry`, { method: 'POST', body: JSON.stringify(body) }),
  validateInvoice: (dossierId: string, body: { type: 'vente' | 'achat'; date?: string; dueDate?: string; tiers?: string; lines: { description?: string; quantity?: number; unitPrice?: number; vatRate?: number; accountCode?: string }[] }) =>
    req<ValidationReport>(`/api/dossiers/${dossierId}/validate-invoice`, { method: 'POST', body: JSON.stringify(body) }),
  validateDeclaration: (dossierId: string, body: { type: 'tva' | 'cnps' | 'dgi'; from?: string; to?: string; year?: number; month?: number }) =>
    req<ValidationReport>(`/api/dossiers/${dossierId}/validate-declaration`, { method: 'POST', body: JSON.stringify(body) }),
  uploadDocument: (dossierId: string, body: { mimeType: string; dataBase64: string; filename?: string; entryId?: string }) =>
    req<{ id: string; url: string; storage: string; size: number }>(`/api/dossiers/${dossierId}/documents`, { method: 'POST', body: JSON.stringify(body) }),
  documents: (dossierId: string) => req<DossierDocument[]>(`/api/dossiers/${dossierId}/documents`),
  // --- Portail client ---
  myRole: (dossierId: string) => req<{ role: string | null }>(`/api/dossiers/${dossierId}/my-role`),
  dossierClients: (dossierId: string) => req<DossierClient[]>(`/api/dossiers/${dossierId}/clients`),
  grantClient: (dossierId: string, email: string) => req<{ userId: string }>(`/api/dossiers/${dossierId}/clients`, { method: 'POST', body: JSON.stringify({ email }) }),
  revokeClient: (dossierId: string, uid: string) => req<void>(`/api/dossiers/${dossierId}/clients/${uid}`, { method: 'DELETE' }),
  capture: (dossierId: string, mimeType: string, dataBase64: string) =>
    req<{ provider: string; proposal: CaptureProposal }>(`/api/dossiers/${dossierId}/capture`, {
      method: 'POST', body: JSON.stringify({ mimeType, dataBase64 }),
    }),
  reverse: (entryId: string) =>
    req<{ reversalId: string }>(`/api/entries/${entryId}/reverse`, { method: 'POST', body: '{}' }),
  mmParse: (dossierId: string, provider: string, content: string) =>
    req<{ count: number; proposals: MMProposal[] }>(`/api/dossiers/${dossierId}/mobile-money/parse`, {
      method: 'POST', body: JSON.stringify({ provider, content }),
    }),
  mmImport: (dossierId: string, body: { fiscalYearId: string; treasuryCode: string; entries: any[] }) =>
    req<{ imported: number; skipped: number; errors: { externalRef: string; message: string }[] }>(
      `/api/dossiers/${dossierId}/mobile-money/import`, { method: 'POST', body: JSON.stringify(body) }),
  mappings: (dossierId: string) => req<Mapping[]>(`/api/dossiers/${dossierId}/mappings`),
  createRule: (dossierId: string, keyword: string, accountCode: string) =>
    req<Mapping>(`/api/dossiers/${dossierId}/mappings`, { method: 'POST', body: JSON.stringify({ keyword, accountCode }) }),
  deleteMapping: (dossierId: string, id: string) =>
    req<void>(`/api/dossiers/${dossierId}/mappings/${id}`, { method: 'DELETE' }),
  trialBalance: (dossierId: string, fiscalYearId?: string) =>
    req<BalanceRow[]>(`/api/dossiers/${dossierId}/trial-balance${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  counterparties: (dossierId: string, type?: string) =>
    req<Counterparty[]>(`/api/dossiers/${dossierId}/counterparties${type ? `?type=${type}` : ''}`),
  tiersScheme: (dossierId: string) => req<{ scheme: 'numerique'|'alphanumerique' }>(`/api/dossiers/${dossierId}/tiers-scheme`),
  setTiersScheme: (dossierId: string, scheme: string) => req<void>(`/api/dossiers/${dossierId}/tiers-scheme`, { method: 'PUT', body: JSON.stringify({ scheme }) }),
  createCounterparty: (dossierId: string, body: { type: string; name: string; auxCode?: string; taxId?: string; email?: string }) =>
    req<Counterparty>(`/api/dossiers/${dossierId}/counterparties`, { method: 'POST', body: JSON.stringify(body) }),
  updateCounterparty: (dossierId: string, cid: string, body: { name?: string; auxCode?: string; taxId?: string; email?: string }) =>
    req<void>(`/api/dossiers/${dossierId}/counterparties/${cid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCounterparty: (dossierId: string, cid: string) =>
    req<void>(`/api/dossiers/${dossierId}/counterparties/${cid}`, { method: 'DELETE' }),
  auxBalance: (dossierId: string, type?: string) =>
    req<AuxBalanceRow[]>(`/api/dossiers/${dossierId}/aux-balance${type ? `?type=${type}` : ''}`),
  auxLedger: (dossierId: string, counterparty: string) =>
    req<AuxLedgerRow[]>(`/api/dossiers/${dossierId}/aux-ledger?counterparty=${counterparty}`),
  bankAccounts: (dossierId: string) => req<BankAccount[]>(`/api/dossiers/${dossierId}/bank-accounts`),
  reconciliation: (dossierId: string, account: string) =>
    req<ReconView>(`/api/dossiers/${dossierId}/reconciliation?account=${encodeURIComponent(account)}`),
  point: (dossierId: string, entryLineId: string, pointed: boolean) =>
    req<void>(`/api/dossiers/${dossierId}/reconciliation/point`, { method: 'POST', body: JSON.stringify({ entryLineId, pointed }) }),
  matchStatement: (dossierId: string, account: string, csv: string) =>
    req<StatementMatch>(`/api/dossiers/${dossierId}/reconciliation/match`, { method: 'POST', body: JSON.stringify({ account, csv }) }),
  applyPointings: (dossierId: string, entryLineIds: string[]) =>
    req<{ pointed: number }>(`/api/dossiers/${dossierId}/reconciliation/apply`, { method: 'POST', body: JSON.stringify({ entryLineIds }) }),
  createFromStatement: (dossierId: string, account: string, row: StatementRow, counterAccount: string, counterAxis?: string) =>
    req<{ entryId: string }>(`/api/dossiers/${dossierId}/reconciliation/create`, { method: 'POST', body: JSON.stringify({ account, row, counterAccount, counterAxis }) }),
  tiersAccounts: (dossierId: string) => req<TiersAccount[]>(`/api/dossiers/${dossierId}/tiers-accounts`),
  lettrageView: (dossierId: string, account: string) =>
    req<{ open: OpenItem[]; lettered: LetteredItem[] }>(`/api/dossiers/${dossierId}/lettrage?account=${encodeURIComponent(account)}`),
  createLettrage: (dossierId: string, accountCode: string, lineIds: string[]) =>
    req<{ id: string; code: string }>(`/api/dossiers/${dossierId}/lettrage`, { method: 'POST', body: JSON.stringify({ accountCode, lineIds }) }),
  deleteLettrage: (dossierId: string, id: string) =>
    req<void>(`/api/dossiers/${dossierId}/lettrage/${id}`, { method: 'DELETE' }),
  agedBalance: (dossierId: string, asOf?: string) =>
    req<AgedRow[]>(`/api/dossiers/${dossierId}/aged-balance${asOf ? `?asOf=${asOf}` : ''}`),
  autoLettrage: (dossierId: string, accountCode?: string) =>
    req<{ groups: number; linesLettered: number }>(`/api/dossiers/${dossierId}/lettrage-auto`, { method: 'POST', body: JSON.stringify({ accountCode }) }),
  overdueClients: (dossierId: string, asOf?: string) =>
    req<OverdueClient[]>(`/api/dossiers/${dossierId}/overdue${asOf ? `?asOf=${asOf}` : ''}`),
  relanceLetter: (dossierId: string, cid: string, asOf?: string) =>
    req<RelanceLetter>(`/api/dossiers/${dossierId}/relance/${cid}${asOf ? `?asOf=${asOf}` : ''}`),
  recordRelance: (dossierId: string, cid: string, body: { level: number; amount: number; asOf?: string; note?: string }) =>
    req<{ id: string; level: number }>(`/api/dossiers/${dossierId}/relance/${cid}`, { method: 'POST', body: JSON.stringify(body) }),
  vatDeclaration: (dossierId: string, from: string, to: string) =>
    req<VatDeclaration>(`/api/dossiers/${dossierId}/vat?from=${from}&to=${to}`),
  liquidateVat: (dossierId: string, body: { from: string; to: string; date: string }) =>
    req<{ entryId: string } & VatDeclaration>(`/api/dossiers/${dossierId}/vat/liquidate`, { method: 'POST', body: JSON.stringify(body) }),
  analyzeBalanceImport: (dossierId: string, body: { csv?: string; lines?: any[]; fiscalYearId?: string }) =>
    req<ImportBalanceAnalysis>(`/api/dossiers/${dossierId}/import-balance/analyze`, { method: 'POST', body: JSON.stringify(body) }),
  commitBalanceImport: (dossierId: string, body: { csv?: string; lines?: any[]; fiscalYearId: string; date: string; description?: string; createMissing?: boolean; tiersCsv?: string; tiersItems?: any[] }) =>
    req<{ entryId: string; accountsCreated: number; lines: number; totalDebit: number; tiersItems: number }>(`/api/dossiers/${dossierId}/import-balance/commit`, { method: 'POST', body: JSON.stringify(body) }),
  parseTiersReprise: (dossierId: string, tiersCsv: string) =>
    req<{ count: number; items: TiersOpenItem[] }>(`/api/dossiers/${dossierId}/import-balance/parse-tiers`, { method: 'POST', body: JSON.stringify({ tiersCsv }) }),
  dossierDashboard: (dossierId: string, fiscalYearId?: string) => req<DossierDashboard>(`/api/dossiers/${dossierId}/dashboard${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  dossierAlerts: (dossierId: string, fiscalYearId?: string) => req<DossierAlerts>(`/api/dossiers/${dossierId}/alerts${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  dossierRatios: (dossierId: string, fiscalYearId?: string) => req<FinancialRatios>(`/api/dossiers/${dossierId}/ratios${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  dossierControls: (dossierId: string, fiscalYearId?: string) => req<CoherenceReport>(`/api/dossiers/${dossierId}/controls${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  recurringTemplates: (dossierId: string) => req<RecurringTemplate[]>(`/api/dossiers/${dossierId}/recurring`),
  createRecurring: (dossierId: string, body: { label: string; journalId: string; frequency: string; dayOfMonth?: number; startDate: string; endDate?: string | null; counterpartyName?: string; lines: RecurringLine[]; notes?: string }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/recurring`, { method: 'POST', body: JSON.stringify(body) }),
  deleteRecurring: (dossierId: string, tid: string) => req<void>(`/api/dossiers/${dossierId}/recurring/${tid}`, { method: 'DELETE' }),
  setRecurringActive: (dossierId: string, tid: string, active: boolean) => req<void>(`/api/dossiers/${dossierId}/recurring/${tid}/active`, { method: 'POST', body: JSON.stringify({ active }) }),
  generateRecurring: (dossierId: string, tid: string, upTo?: string) => req<{ count: number; total: number; skipped: number }>(`/api/dossiers/${dossierId}/recurring/${tid}/generate`, { method: 'POST', body: JSON.stringify({ upTo }) }),
  generateAllRecurring: (dossierId: string, upTo?: string) => req<{ count: number; total: number; templates: number }>(`/api/dossiers/${dossierId}/recurring-generate`, { method: 'POST', body: JSON.stringify({ upTo }) }),
  audit: (dossierId: string, limit?: number) => req<AuditEntry[]>(`/api/dossiers/${dossierId}/audit${limit ? `?limit=${limit}` : ''}`),
  assets: (dossierId: string) => req<FixedAsset[]>(`/api/dossiers/${dossierId}/assets`),
  assetDetail: (dossierId: string, aid: string) => req<FixedAssetDetail>(`/api/dossiers/${dossierId}/assets/${aid}`),
  createAsset: (dossierId: string, body: { label: string; assetAccountCode: string; amortAccountCode?: string; expenseAccountCode?: string; acquisitionDate: string; commissioningDate?: string; amount: number; residualValue?: number; durationYears: number; depreciationPeriod?: 'annual' | 'monthly'; depreciationMethod?: 'linear' | 'degressive'; notes?: string; repriseCumul?: number; repriseDate?: string }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/assets`, { method: 'POST', body: JSON.stringify(body) }),
  deleteAsset: (dossierId: string, aid: string) => req<void>(`/api/dossiers/${dossierId}/assets/${aid}`, { method: 'DELETE' }),
  depreciateAsset: (dossierId: string, aid: string, periodDate: string) =>
    req<{ entryId: string; amount: number; periodDate: string }>(`/api/dossiers/${dossierId}/assets/${aid}/depreciate`, { method: 'POST', body: JSON.stringify({ periodDate }) }),
  depreciateAssetDue: (dossierId: string, aid: string, upTo?: string) =>
    req<{ count: number; total: number; skipped: number }>(`/api/dossiers/${dossierId}/assets/${aid}/depreciate-due`, { method: 'POST', body: JSON.stringify({ upTo }) }),
  depreciateDue: (dossierId: string, upTo?: string) =>
    req<{ count: number; total: number; skipped: number }>(`/api/dossiers/${dossierId}/depreciate-due`, { method: 'POST', body: JSON.stringify({ upTo }) }),
  disposeAsset: (dossierId: string, aid: string, body: { disposalDate: string; salePrice?: number; cashAccount?: string }) =>
    req<{ entryId: string; vnc: number; plusValue: number; salePrice: number }>(`/api/dossiers/${dossierId}/assets/${aid}/dispose`, { method: 'POST', body: JSON.stringify(body) }),
  invoices: (dossierId: string, docType?: string, status?: string) => req<Invoice[]>(`/api/dossiers/${dossierId}/invoices?docType=${docType || 'invoice'}${status ? `&status=${status}` : ''}`),
  invoice: (dossierId: string, iid: string) => req<InvoiceDetail>(`/api/dossiers/${dossierId}/invoices/${iid}`),
  createInvoice: (dossierId: string, body: { clientName: string; invoiceDate: string; dueDate?: string; notes?: string; docType?: string; lines: InvoiceLine[] }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/invoices`, { method: 'POST', body: JSON.stringify(body) }),
  convertQuote: (dossierId: string, iid: string) => req<{ id: string }>(`/api/dossiers/${dossierId}/invoices/${iid}/convert`, { method: 'POST', body: '{}' }),
  creditNoteFromInvoice: (dossierId: string, iid: string) => req<{ id: string }>(`/api/dossiers/${dossierId}/invoices/${iid}/credit-note`, { method: 'POST', body: '{}' }),
  deleteInvoice: (dossierId: string, iid: string) => req<void>(`/api/dossiers/${dossierId}/invoices/${iid}`, { method: 'DELETE' }),
  issueInvoice: (dossierId: string, iid: string) => req<{ number: string; entryId: string }>(`/api/dossiers/${dossierId}/invoices/${iid}/issue`, { method: 'POST', body: '{}' }),
  certifyInvoice: (dossierId: string, iid: string) => req<{ reference: string; provider: string }>(`/api/dossiers/${dossierId}/invoices/${iid}/certify`, { method: 'POST', body: '{}' }),
  // --- Achats fournisseurs ---
  purchases: (dossierId: string, status?: string) => req<Purchase[]>(`/api/dossiers/${dossierId}/purchases${status ? `?status=${status}` : ''}`),
  purchase: (dossierId: string, pid: string) => req<PurchaseDetail>(`/api/dossiers/${dossierId}/purchases/${pid}`),
  createPurchase: (dossierId: string, body: { supplierName: string; supplierRef?: string; invoiceDate: string; dueDate?: string; notes?: string; lines: PurchaseLine[] }) =>
    req<{ id: string; duplicates?: PurchaseDuplicate[] }>(`/api/dossiers/${dossierId}/purchases`, { method: 'POST', body: JSON.stringify(body) }),
  checkPurchaseDuplicate: (dossierId: string, body: { supplierName?: string; supplierRef?: string; invoiceDate?: string; totalTtc?: number; excludeId?: string }) =>
    req<{ duplicates: PurchaseDuplicate[] }>(`/api/dossiers/${dossierId}/purchases/check-duplicate`, { method: 'POST', body: JSON.stringify(body) }),
  closures: (dossierId: string) => req<ClosuresData>(`/api/dossiers/${dossierId}/closures`),
  closePeriod: (dossierId: string, year: number, month: number) => req<void>(`/api/dossiers/${dossierId}/closures`, { method: 'POST', body: JSON.stringify({ year, month }) }),
  reopenPeriod: (dossierId: string, year: number, month: number) => req<void>(`/api/dossiers/${dossierId}/closures/${year}/${month}`, { method: 'DELETE' }),
  catalog: (dossierId: string, all?: boolean) => req<CatalogItem[]>(`/api/dossiers/${dossierId}/catalog${all ? '?all=1' : ''}`),
  createCatalogItem: (dossierId: string, body: CatalogItemInput) => req<{ id: string }>(`/api/dossiers/${dossierId}/catalog`, { method: 'POST', body: JSON.stringify(body) }),
  updateCatalogItem: (dossierId: string, cid: string, body: CatalogItemInput) => req<void>(`/api/dossiers/${dossierId}/catalog/${cid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCatalogItem: (dossierId: string, cid: string) => req<void>(`/api/dossiers/${dossierId}/catalog/${cid}`, { method: 'DELETE' }),
  deletePurchase: (dossierId: string, pid: string) => req<void>(`/api/dossiers/${dossierId}/purchases/${pid}`, { method: 'DELETE' }),
  recordPurchase: (dossierId: string, pid: string) => req<{ entryId: string }>(`/api/dossiers/${dossierId}/purchases/${pid}/record`, { method: 'POST', body: '{}' }),
  payPurchase: (dossierId: string, pid: string, body: { paymentDate: string; treasuryCode: string; channel?: string }) =>
    req<{ entryId: string }>(`/api/dossiers/${dossierId}/purchases/${pid}/pay`, { method: 'POST', body: JSON.stringify(body) }),
  supplierAging: (dossierId: string, asOf?: string) => req<SupplierAging[]>(`/api/dossiers/${dossierId}/purchases/aging${asOf ? `?asOf=${asOf}` : ''}`),
  journalEntries: (dossierId: string, opts: { journal?: string; fiscalYearId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.journal) q.set('journal', opts.journal);
    if (opts.fiscalYearId) q.set('fiscalYearId', opts.fiscalYearId);
    const qs = q.toString();
    return req<JournalLine[]>(`/api/dossiers/${dossierId}/journal-entries${qs ? `?${qs}` : ''}`);
  },
  createFiscalYear: (dossierId: string, label: string, startDate: string, endDate: string) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/fiscal-years`, { method: 'POST', body: JSON.stringify({ label, startDate, endDate }) }),
  closeExercise: (dossierId: string, fiscalYearId: string) =>
    req<{ anEntryId: string; newFiscalYearId: string; resultat: number }>(`/api/dossiers/${dossierId}/close-exercise`, { method: 'POST', body: JSON.stringify({ fiscalYearId }) }),
  generalLedger: (dossierId: string, opts: { fiscalYearId?: string; account?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.fiscalYearId) q.set('fiscalYearId', opts.fiscalYearId);
    if (opts.account) q.set('account', opts.account);
    const qs = q.toString();
    return req<LedgerRow[]>(`/api/dossiers/${dossierId}/general-ledger${qs ? `?${qs}` : ''}`);
  },
  financialStatements: (dossierId: string, fiscalYearId?: string) =>
    req<FinancialStatements>(`/api/dossiers/${dossierId}/financial-statements${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  isEstimate: (dossierId: string, fiscalYearId?: string) =>
    req<IsEstimate>(`/api/dossiers/${dossierId}/is-estimate${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  liasseStatus: (dossierId: string) => req<{ enabled: boolean }>(`/api/dossiers/${dossierId}/liasse-status`),
  financialStatementsComparative: (dossierId: string, fiscalYearId?: string) =>
    req<ComparativeFS>(`/api/dossiers/${dossierId}/financial-statements-comparative${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  creditScore: (dossierId: string, fiscalYearId?: string) => req<CreditScore>(`/api/dossiers/${dossierId}/score${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  financingRequests: (dossierId: string) => req<FinancingRequest[]>(`/api/dossiers/${dossierId}/financing`),
  requestFinancing: (dossierId: string, amount: number) => req<{ id: string }>(`/api/dossiers/${dossierId}/financing/request`, { method: 'POST', body: JSON.stringify({ amount }) }),
  decideFinancing: (dossierId: string, fid: string, approve: boolean, note?: string) => req<void>(`/api/dossiers/${dossierId}/financing/${fid}/decide`, { method: 'POST', body: JSON.stringify({ approve, note }) }),
  disburseFinancing: (dossierId: string, fid: string, date: string, bankAccount?: string) => req<{ entryId: string }>(`/api/dossiers/${dossierId}/financing/${fid}/disburse`, { method: 'POST', body: JSON.stringify({ date, bankAccount }) }),
  repayFinancing: (dossierId: string, fid: string, body: { date: string; amount: number; interest?: number; bankAccount?: string }) => req<{ entryId: string; fullyRepaid: boolean }>(`/api/dossiers/${dossierId}/financing/${fid}/repay`, { method: 'POST', body: JSON.stringify(body) }),
  cashForecast: (dossierId: string, weeks?: number, delay?: number) => req<CashForecast>(`/api/dossiers/${dossierId}/cash-forecast?${weeks ? `weeks=${weeks}&` : ''}${delay != null ? `delay=${delay}` : ''}`),
  echeancier: (dossierId: string) => req<Echeancier>(`/api/dossiers/${dossierId}/echeancier`),
  revisionReport: (dossierId: string, fiscalYearId: string) => req<RevisionReport>(`/api/dossiers/${dossierId}/revision?fiscalYearId=${fiscalYearId}`),
  setReview: (dossierId: string, fiscalYearId: string, accountCode: string, body: { status?: string; note?: string }) =>
    req<void>(`/api/dossiers/${dossierId}/revision`, { method: 'POST', body: JSON.stringify({ fiscalYearId, accountCode, ...body }) }),
  entryTemplates: (dossierId: string) => req<EntryTemplate[]>(`/api/dossiers/${dossierId}/entry-templates`),
  createEntryTemplate: (dossierId: string, body: { name: string; journalCode?: string | null; lines: { accountCode: string; label?: string; debit?: number; credit?: number }[] }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/entry-templates`, { method: 'POST', body: JSON.stringify(body) }),
  deleteEntryTemplate: (dossierId: string, tid: string) => req<void>(`/api/dossiers/${dossierId}/entry-templates/${tid}`, { method: 'DELETE' }),
  obligations: (dossierId: string) => req<Obligation[]>(`/api/dossiers/${dossierId}/obligations`),
  createObligation: (dossierId: string, body: { label: string; periodicity: string; dueDay: number; dueMonth?: number | null }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/obligations`, { method: 'POST', body: JSON.stringify(body) }),
  seedObligations: (dossierId: string) => req<{ added: number }>(`/api/dossiers/${dossierId}/obligations/seed`, { method: 'POST', body: '{}' }),
  deleteObligation: (dossierId: string, oid: string) => req<void>(`/api/dossiers/${dossierId}/obligations/${oid}`, { method: 'DELETE' }),
  postCutoff: (dossierId: string, body: { type: string; date: string; accountCode: string; amount: number; label: string; autoReverse?: boolean }) =>
    req<{ entryId: string; reversalId: string | null }>(`/api/dossiers/${dossierId}/cutoff`, { method: 'POST', body: JSON.stringify(body) }),
  budgetReport: (dossierId: string, fiscalYearId: string) => req<BudgetReport>(`/api/dossiers/${dossierId}/budget?fiscalYearId=${fiscalYearId}`),
  rollingForecast: (dossierId: string, fiscalYearId: string) => req<RollingForecast>(`/api/dossiers/${dossierId}/budget/forecast?fiscalYearId=${fiscalYearId}`),
  generateBudget: (dossierId: string, fiscalYearId: string, growthProduits?: number, inflationCharges?: number) =>
    req<GeneratedBudget>(`/api/dossiers/${dossierId}/budget/generate?fiscalYearId=${fiscalYearId}${growthProduits != null ? `&growthProduits=${growthProduits}` : ''}${inflationCharges != null ? `&inflationCharges=${inflationCharges}` : ''}`),
  applyBudget: (dossierId: string, fiscalYearId: string, lines: { accountCode: string; amount: number }[]) =>
    req<{ applied: number }>(`/api/dossiers/${dossierId}/budget/apply`, { method: 'POST', body: JSON.stringify({ fiscalYearId, lines }) }),
  budgetScenarios: (dossierId: string, fiscalYearId: string) => req<ScenariosReport>(`/api/dossiers/${dossierId}/budget/scenarios?fiscalYearId=${fiscalYearId}`),
  budgetProvisional: (dossierId: string, fiscalYearId: string, scenario = 'central', stress = 0) =>
    req<ProvisionalReport>(`/api/dossiers/${dossierId}/budget/provisional?fiscalYearId=${fiscalYearId}&scenario=${scenario}&stress=${stress}`),
  setBudget: (dossierId: string, fiscalYearId: string, accountCode: string, amount: number) => req<void>(`/api/dossiers/${dossierId}/budget`, { method: 'POST', body: JSON.stringify({ fiscalYearId, accountCode, amount }) }),
  importBudget: (dossierId: string, fiscalYearId: string, csv: string) =>
    req<{ imported: number; errors: { accountCode: string; reason: string }[] }>(`/api/dossiers/${dossierId}/budget/import`, { method: 'POST', body: JSON.stringify({ fiscalYearId, csv }) }),
  deleteBudget: (dossierId: string, fiscalYearId: string, accountCode: string) => req<void>(`/api/dossiers/${dossierId}/budget`, { method: 'DELETE', body: JSON.stringify({ fiscalYearId, accountCode }) }),
  analyticSections: (dossierId: string) => req<AnalyticSection[]>(`/api/dossiers/${dossierId}/analytic/sections`),
  createAnalyticSection: (dossierId: string, code: string, label: string) => req<{ id: string }>(`/api/dossiers/${dossierId}/analytic/sections`, { method: 'POST', body: JSON.stringify({ code, label }) }),
  deleteAnalyticSection: (dossierId: string, sid: string) => req<void>(`/api/dossiers/${dossierId}/analytic/sections/${sid}`, { method: 'DELETE' }),
  analyticReport: (dossierId: string, fiscalYearId?: string) => req<AnalyticReport>(`/api/dossiers/${dossierId}/analytic/report${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  analyticDetail: (dossierId: string, section: string, fiscalYearId?: string) => req<AnalyticDetail>(`/api/dossiers/${dossierId}/analytic/detail?section=${encodeURIComponent(section)}${fiscalYearId ? `&fiscalYearId=${fiscalYearId}` : ''}`),
  analyticMonthly: (dossierId: string, fiscalYearId?: string) => req<AnalyticMonthly>(`/api/dossiers/${dossierId}/analytic/monthly${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  agentStatus: (dossierId: string) => req<AgentStatus>(`/api/dossiers/${dossierId}/agent/status`),
  agentChat: (dossierId: string, messages: AgentMessage[]) => req<AgentResult>(`/api/dossiers/${dossierId}/agent/chat`, { method: 'POST', body: JSON.stringify({ messages }) }),
  agentHistory: (dossierId: string) => req<AgentMessage[]>(`/api/dossiers/${dossierId}/agent/history`),
  clearAgentHistory: (dossierId: string) => req<{ deleted: number }>(`/api/dossiers/${dossierId}/agent/history`, { method: 'DELETE' }),
  decisions: (dossierId: string, limit = 30) => req<DecisionSummary[]>(`/api/dossiers/${dossierId}/decisions?limit=${limit}`),
  decision: (dossierId: string, id: string) => req<DecisionDetail>(`/api/dossiers/${dossierId}/decisions/${id}`),
  qualityDashboard: (dossierId: string) => req<QualityDashboard>(`/api/dossiers/${dossierId}/quality-dashboard`),
  setAgentMode: (dossierId: string, mode: AgentMode) => req<{ mode: AgentMode }>(`/api/dossiers/${dossierId}/agent/mode`, { method: 'POST', body: JSON.stringify({ mode }) }),
  lexaMemory: (dossierId: string) => req<{ id: string; content: string; source: string; created_at: string }[]>(`/api/dossiers/${dossierId}/lexa/memory`),
  lexaRemember: (dossierId: string, content: string) => req<{ id: string }>(`/api/dossiers/${dossierId}/lexa/memory`, { method: 'POST', body: JSON.stringify({ content }) }),
  lexaForget: (dossierId: string, mid: string) => req<void>(`/api/dossiers/${dossierId}/lexa/memory/${mid}`, { method: 'DELETE' }),
  whatsappLinks: (dossierId: string) => req<{ enabled: boolean; links: { id: string; phone: string; label: string | null; created_at: string }[] }>(`/api/dossiers/${dossierId}/whatsapp/links`),
  whatsappLink: (dossierId: string, phone: string, label?: string) => req<{ id: string }>(`/api/dossiers/${dossierId}/whatsapp/links`, { method: 'POST', body: JSON.stringify({ phone, label }) }),
  whatsappUnlink: (dossierId: string, lid: string) => req<void>(`/api/dossiers/${dossierId}/whatsapp/links/${lid}`, { method: 'DELETE' }),
  telegramLinks: (dossierId: string) => req<{ enabled: boolean; links: { id: string; code: string; label: string | null; linked: boolean; created_at: string }[] }>(`/api/dossiers/${dossierId}/telegram/links`),
  telegramLink: (dossierId: string, label?: string) => req<{ code: string }>(`/api/dossiers/${dossierId}/telegram/links`, { method: 'POST', body: JSON.stringify({ label }) }),
  telegramUnlink: (dossierId: string, lid: string) => req<void>(`/api/dossiers/${dossierId}/telegram/links/${lid}`, { method: 'DELETE' }),
  setLexaVoice: (dossierId: string, provider: string, voiceId: string | null) => req<{ provider: string; voiceId: string | null }>(`/api/dossiers/${dossierId}/lexa/voice`, { method: 'PATCH', body: JSON.stringify({ provider, voiceId }) }),
  // --- Paie ---
  payrollEmployees: (dossierId: string) => req<PayrollEmployee[]>(`/api/dossiers/${dossierId}/payroll/employees`),
  createPayrollEmployee: (dossierId: string, body: Partial<PayrollEmployee>) => req<{ id: string }>(`/api/dossiers/${dossierId}/payroll/employees`, { method: 'POST', body: JSON.stringify(body) }),
  updatePayrollEmployee: (dossierId: string, eid: string, body: Partial<PayrollEmployee>) => req<void>(`/api/dossiers/${dossierId}/payroll/employees/${eid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePayrollEmployee: (dossierId: string, eid: string) => req<void>(`/api/dossiers/${dossierId}/payroll/employees/${eid}`, { method: 'DELETE' }),
  payrollPayslips: (dossierId: string, year: number, month: number) => req<Payslip[]>(`/api/dossiers/${dossierId}/payroll/payslips?year=${year}&month=${month}`),
  runPayroll: (dossierId: string, year: number, month: number) => req<PayrollRunResult>(`/api/dossiers/${dossierId}/payroll/run`, { method: 'POST', body: JSON.stringify({ year, month }) }),
  postPayroll: (dossierId: string, year: number, month: number, entryDate?: string) => req<{ entryId: string; totalBrut: number; totalNet: number; totalCoutEmployeur: number }>(`/api/dossiers/${dossierId}/payroll/post`, { method: 'POST', body: JSON.stringify({ year, month, entryDate }) }),
  payrollYear: (dossierId: string, year: number) => req<PayrollYear>(`/api/dossiers/${dossierId}/payroll/year?year=${year}`),
  distributePayslips: (dossierId: string, year: number, month: number) => req<{ enabled: boolean; period: string; sent: { nom: string; email: string }[]; skipped: { nom: string; raison: string }[] }>(`/api/dossiers/${dossierId}/payroll/distribute-payslips`, { method: 'POST', body: JSON.stringify({ year, month }) }),
  leave: (dossierId: string) => req<{ demandes: LeaveRequest[]; soldes: LeaveBalance[] }>(`/api/dossiers/${dossierId}/payroll/leave`),
  createLeave: (dossierId: string, body: { employeeId: string; type: string; dateDebut: string; dateFin: string; jours: number; motif?: string }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/payroll/leave`, { method: 'POST', body: JSON.stringify(body) }),
  decideLeave: (dossierId: string, id: string, approve: boolean, note?: string) =>
    req<{ statut: string }>(`/api/dossiers/${dossierId}/payroll/leave/${id}/decide`, { method: 'POST', body: JSON.stringify({ approve, note }) }),
  cancelLeave: (dossierId: string, id: string) => req<void>(`/api/dossiers/${dossierId}/payroll/leave/${id}`, { method: 'DELETE' }),
  rhAlerts: (dossierId: string) => req<RhAlerts>(`/api/dossiers/${dossierId}/payroll/rh-alerts`),
  rhAnalysis: (dossierId: string, year: number, month: number) => req<RhAnalysis>(`/api/dossiers/${dossierId}/payroll/rh-analysis?year=${year}&month=${month}`),
  // Factures de vente récurrentes (abonnements)
  recurringInvoices: (dossierId: string) => req<RecurringInvoice[]>(`/api/dossiers/${dossierId}/recurring-invoices`),
  createRecurringInvoice: (dossierId: string, body: any) => req<{ id: string }>(`/api/dossiers/${dossierId}/recurring-invoices`, { method: 'POST', body: JSON.stringify(body) }),
  setRecurringInvoiceActive: (dossierId: string, tid: string, active: boolean) => req<void>(`/api/dossiers/${dossierId}/recurring-invoices/${tid}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
  deleteRecurringInvoice: (dossierId: string, tid: string) => req<void>(`/api/dossiers/${dossierId}/recurring-invoices/${tid}`, { method: 'DELETE' }),
  generateRecurringInvoices: (dossierId: string) => req<{ count: number; templates: number }>(`/api/dossiers/${dossierId}/recurring-invoices/generate`, { method: 'POST' }),
  // RH : absences
  payrollAbsences: (dossierId: string) => req<PayrollAbsence[]>(`/api/dossiers/${dossierId}/payroll/absences`),
  createAbsence: (dossierId: string, input: Partial<PayrollAbsence>) => req<{ id: string }>(`/api/dossiers/${dossierId}/payroll/absences`, { method: 'POST', body: JSON.stringify(input) }),
  deleteAbsence: (dossierId: string, aid: string) => req<void>(`/api/dossiers/${dossierId}/payroll/absences/${aid}`, { method: 'DELETE' }),
  // RH : avances & prêts
  payrollAdvances: (dossierId: string) => req<PayrollAdvance[]>(`/api/dossiers/${dossierId}/payroll/advances`),
  createAdvance: (dossierId: string, input: Partial<PayrollAdvance>) => req<{ id: string }>(`/api/dossiers/${dossierId}/payroll/advances`, { method: 'POST', body: JSON.stringify(input) }),
  deleteAdvance: (dossierId: string, aid: string) => req<void>(`/api/dossiers/${dossierId}/payroll/advances/${aid}`, { method: 'DELETE' }),
  // RH : pointage
  payrollTime: (dossierId: string) => req<PayrollTimeEntry[]>(`/api/dossiers/${dossierId}/payroll/time`),
  createTimeEntry: (dossierId: string, input: Partial<PayrollTimeEntry>) => req<{ id: string }>(`/api/dossiers/${dossierId}/payroll/time`, { method: 'POST', body: JSON.stringify(input) }),
  deleteTimeEntry: (dossierId: string, tid: string) => req<void>(`/api/dossiers/${dossierId}/payroll/time/${tid}`, { method: 'DELETE' }),
  // RH : solde de tout compte
  computeStc: (dossierId: string, input: StcInput) => req<StcResult>(`/api/dossiers/${dossierId}/payroll/stc`, { method: 'POST', body: JSON.stringify(input) }),
};

export type RuptureType = 'licenciement' | 'demission' | 'fin_cdd' | 'rupture_conventionnelle' | 'retraite' | 'faute_lourde';
export const RUPTURE_LABELS: Record<RuptureType, string> = {
  licenciement: 'Licenciement (hors faute grave/lourde)', demission: 'Démission', fin_cdd: 'Fin de CDD (terme normal)',
  rupture_conventionnelle: 'Rupture conventionnelle', retraite: 'Départ / mise à la retraite', faute_lourde: 'Faute grave ou lourde',
};
export interface StcInput { employeeId: string; ruptureType: RuptureType; ruptureDate: string; joursCongesNonPris: number; preavisEffectue: boolean; salaireMoisDu?: number; cddTotalGross?: number }
export interface StcResult { lines: { key: string; label: string; amount: number; note?: string }[]; total: number; tenureYears: number; referenceSalary: number; ruleSetLabel: string; employee: { nom: string; prenoms: string; matricule: string; categorie: string } }

export interface PayrollTimeEntry { id: string; employeeId: string; nom: string; prenoms: string; matricule: string; jour: string; heuresJour: number; heuresNuit: number; ferie: boolean }
export interface RecurringInvoiceLine { description: string; quantity: number; unit_price: number; vat_rate?: number; account_code?: string }
export interface RecurringInvoice { id: string; label: string; clientName: string; lines: RecurringInvoiceLine[]; frequency: string; frequencyLabel: string; dayOfMonth: number; startDate: string; endDate: string | null; active: boolean; montantTtc: number; generated: number; due: number }
export interface RhAnalysis {
  periode: { year: number; month: number }; devise: string; effectif: number; ancienneteMoy: number;
  brutMedian: number; brutMoyen: number; masse: number; variationMasse: number | null; tauxCharges: number;
  absenteisme: number; joursAbs: number; joursTheoriques: number;
  provisionTotale: number; provision: { nom: string; poste: string; joursRestants: number; provision: number }[];
  pyramide: { label: string; count: number }[]; bulletins: number;
}
export interface RhAlert { niveau: 'haute' | 'moyenne' | 'info'; categorie: string; salarie: string; message: string; date: string; joursRestants: number; }
export interface RhAlerts { genereLe: string; resume: { haute: number; moyenne: number; info: number; total: number }; alertes: RhAlert[]; }
export interface PayrollYearEmp { employeeId: string; matricule: string; nom: string; prenoms: string; mois: number; brut: number; brutImposable: number; cnpsSalarial: number; cnpsPatronal: number; its: number; cn: number; igr: number; cmu: number; net: number }
export interface PayrollYear { employer: { raisonSociale: string; taxId: string | null; rccm: string | null; country: string }; year: number; annual: PayrollYearEmp[]; totals: Omit<PayrollYearEmp, 'employeeId' | 'matricule' | 'nom' | 'prenoms' | 'mois'> }
export interface PayrollAbsence { id: string; employeeId: string; nom: string; prenoms: string; matricule: string; dateDebut: string; dateFin: string; jours: number; justifiee: boolean; paye: boolean; motif: string | null }
export interface PayrollAdvance { id: string; employeeId: string; nom: string; prenoms: string; matricule: string; type: 'avance' | 'pret'; montantTotal: number; mensualite: number; startYear: number; startMonth: number; motif: string | null; restant: number }

export const OHADA_COUNTRIES: { code: string; name: string }[] = [
  { code: 'CI', name: "Côte d'Ivoire" }, { code: 'SN', name: 'Sénégal' }, { code: 'BJ', name: 'Bénin' },
  { code: 'BF', name: 'Burkina Faso' }, { code: 'ML', name: 'Mali' }, { code: 'TG', name: 'Togo' },
  { code: 'NE', name: 'Niger' }, { code: 'GW', name: 'Guinée-Bissau' }, { code: 'CM', name: 'Cameroun' },
  { code: 'GA', name: 'Gabon' }, { code: 'CG', name: 'Congo' }, { code: 'TD', name: 'Tchad' },
  { code: 'CF', name: 'Centrafrique' }, { code: 'GQ', name: 'Guinée équatoriale' }, { code: 'CD', name: 'RD Congo' },
  { code: 'GN', name: 'Guinée' }, { code: 'KM', name: 'Comores' },
];

export function fmtMoney(n: number, currency = 'XOF'): string {
  const decimals = currency === 'XOF' || currency === 'XAF' ? 0 : 2;
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
}

export interface TriagePoint { niveau: string; titre: string; categorie: string }
export interface TriageDossier { dossierId: string; raisonSociale: string; analyseLe: string | null; haute: number; moyenne: number; points: TriagePoint[] }
export interface CabinetTriage {
  dossiers: TriageDossier[];
  jamaisAnalyses: { dossierId: string; raisonSociale: string }[];
  resume: { dossiers: number; critiques: number; aTraiter: number };
  parCategorie: { categorie: string; libelle: string; dossiers: number; points: number }[];
}

export interface LeaveRequest {
  id: string; employee_id: string; matricule: string; nom: string; prenoms: string;
  type: string; statut: string; date_debut: string; date_fin: string; jours: number;
  motif: string | null; note: string | null; created_at: string; decided_at: string | null;
}
export interface LeaveBalance { employeeId: string; matricule: string; nom: string; poste: string; acquis: number; pris: number; enAttente: number; solde: number }
