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

export interface Cabinet { id: string; name: string; country: string; base_currency: string; }
export interface Dossier {
  id: string; cabinet_id: string; raison_sociale: string; country: string;
  base_currency: string; accounting_system: string; is_active: boolean;
}
export interface Account {
  id: string; account_code: string; label: string; class_no: number;
  account_type: string; normal_side: string; is_collective: boolean; is_postable: boolean; is_active?: boolean;
}
export interface FiscalYear { id: string; label: string; start_date: string; end_date: string; status: string; }
export interface Journal { id: string; code: string; label: string; type: string; }
export interface DashboardData {
  dossierCount: number; totalEntries: number; entriesThisMonth: number;
  autoCodedPct: number; resultatCumule: number;
  perDossier: { id: string; raisonSociale: string; currency: string; entries: number; drafts: number; autoPct: number; resultat: number; lastDate: string | null; needsSetup: boolean }[];
  sourceBreakdown: { source: string; label: string; count: number }[];
  alerts: { type: string; dossierId: string; dossierName: string; message: string }[];
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
export interface Counterparty { id: string; type: string; name: string; aux_code: string | null; tax_id: string | null; collective: string | null; }
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
export interface AnalyticSection { id: string; code: string; label: string; }
export interface AnalyticReport {
  sections: { code: string; label: string; produits: number; charges: number; resultat: number }[];
  totals: { produits: number; charges: number; resultat: number };
}
export interface ProposedLine {
  accountCode: string; accountLabel?: string; debit?: number; credit?: number; label?: string;
}
export interface CaptureProposal {
  description: string; entryDate?: string; journalCode?: string; counterpartyName?: string;
  currency: string; confidence: number; lines: ProposedLine[]; warnings?: string[];
}

export interface AuthUser { id: string; email: string; name: string | null; twoFactorEnabled?: boolean; }
export interface CabinetMember { userId: string; email: string; name: string | null; role: string; createdAt: string; }

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
  renameCabinet: (cabinetId: string, name: string) => req<void>(`/api/cabinets/${cabinetId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  members: (cabinetId: string) => req<CabinetMember[]>(`/api/cabinets/${cabinetId}/members`),
  addMember: (cabinetId: string, email: string, role: string) => req<{ id: string }>(`/api/cabinets/${cabinetId}/members`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  setMemberRole: (cabinetId: string, uid: string, role: string) => req<void>(`/api/cabinets/${cabinetId}/members/${uid}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (cabinetId: string, uid: string) => req<void>(`/api/cabinets/${cabinetId}/members/${uid}`, { method: 'DELETE' }),
  cabinets: () => req<Cabinet[]>('/api/cabinets'),
  dashboard: () => req<DashboardData>('/api/dashboard'),
  seedDemo: () => req<{ dossierId: string }>('/api/demo/seed', { method: 'POST', body: '{}' }),
  onboard: (name: string, country: string) =>
    req<{ cabinetId: string }>('/api/onboarding/cabinet', { method: 'POST', body: JSON.stringify({ name, country }) }),
  dossiers: () => req<Dossier[]>('/api/dossiers'),
  createDossier: (input: { cabinetId: string; raisonSociale: string; country: string; accountingSystem?: string; taxId?: string }) =>
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
  uploadDocument: (dossierId: string, body: { mimeType: string; dataBase64: string; filename?: string; entryId?: string }) =>
    req<{ id: string; url: string; storage: string; size: number }>(`/api/dossiers/${dossierId}/documents`, { method: 'POST', body: JSON.stringify(body) }),
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
  createCounterparty: (dossierId: string, body: { type: string; name: string; auxCode?: string; taxId?: string }) =>
    req<Counterparty>(`/api/dossiers/${dossierId}/counterparties`, { method: 'POST', body: JSON.stringify(body) }),
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
  commitBalanceImport: (dossierId: string, body: { csv?: string; lines?: any[]; fiscalYearId: string; date: string; description?: string; createMissing?: boolean }) =>
    req<{ entryId: string; accountsCreated: number; lines: number; totalDebit: number }>(`/api/dossiers/${dossierId}/import-balance/commit`, { method: 'POST', body: JSON.stringify(body) }),
  dossierDashboard: (dossierId: string, fiscalYearId?: string) => req<DossierDashboard>(`/api/dossiers/${dossierId}/dashboard${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
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
  createAsset: (dossierId: string, body: { label: string; assetAccountCode: string; amortAccountCode?: string; expenseAccountCode?: string; acquisitionDate: string; commissioningDate?: string; amount: number; residualValue?: number; durationYears: number; depreciationPeriod?: 'annual' | 'monthly'; depreciationMethod?: 'linear' | 'degressive'; notes?: string }) =>
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
    req<{ id: string }>(`/api/dossiers/${dossierId}/purchases`, { method: 'POST', body: JSON.stringify(body) }),
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
  financialStatementsComparative: (dossierId: string, fiscalYearId?: string) =>
    req<ComparativeFS>(`/api/dossiers/${dossierId}/financial-statements-comparative${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  creditScore: (dossierId: string, fiscalYearId?: string) => req<CreditScore>(`/api/dossiers/${dossierId}/score${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  financingRequests: (dossierId: string) => req<FinancingRequest[]>(`/api/dossiers/${dossierId}/financing`),
  requestFinancing: (dossierId: string, amount: number) => req<{ id: string }>(`/api/dossiers/${dossierId}/financing/request`, { method: 'POST', body: JSON.stringify({ amount }) }),
  decideFinancing: (dossierId: string, fid: string, approve: boolean, note?: string) => req<void>(`/api/dossiers/${dossierId}/financing/${fid}/decide`, { method: 'POST', body: JSON.stringify({ approve, note }) }),
  disburseFinancing: (dossierId: string, fid: string, date: string, bankAccount?: string) => req<{ entryId: string }>(`/api/dossiers/${dossierId}/financing/${fid}/disburse`, { method: 'POST', body: JSON.stringify({ date, bankAccount }) }),
  repayFinancing: (dossierId: string, fid: string, body: { date: string; amount: number; interest?: number; bankAccount?: string }) => req<{ entryId: string; fullyRepaid: boolean }>(`/api/dossiers/${dossierId}/financing/${fid}/repay`, { method: 'POST', body: JSON.stringify(body) }),
  cashForecast: (dossierId: string, weeks?: number, delay?: number) => req<CashForecast>(`/api/dossiers/${dossierId}/cash-forecast?${weeks ? `weeks=${weeks}&` : ''}${delay != null ? `delay=${delay}` : ''}`),
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
  setBudget: (dossierId: string, fiscalYearId: string, accountCode: string, amount: number) => req<void>(`/api/dossiers/${dossierId}/budget`, { method: 'POST', body: JSON.stringify({ fiscalYearId, accountCode, amount }) }),
  importBudget: (dossierId: string, fiscalYearId: string, csv: string) =>
    req<{ imported: number; errors: { accountCode: string; reason: string }[] }>(`/api/dossiers/${dossierId}/budget/import`, { method: 'POST', body: JSON.stringify({ fiscalYearId, csv }) }),
  deleteBudget: (dossierId: string, fiscalYearId: string, accountCode: string) => req<void>(`/api/dossiers/${dossierId}/budget`, { method: 'DELETE', body: JSON.stringify({ fiscalYearId, accountCode }) }),
  analyticSections: (dossierId: string) => req<AnalyticSection[]>(`/api/dossiers/${dossierId}/analytic/sections`),
  createAnalyticSection: (dossierId: string, code: string, label: string) => req<{ id: string }>(`/api/dossiers/${dossierId}/analytic/sections`, { method: 'POST', body: JSON.stringify({ code, label }) }),
  deleteAnalyticSection: (dossierId: string, sid: string) => req<void>(`/api/dossiers/${dossierId}/analytic/sections/${sid}`, { method: 'DELETE' }),
  analyticReport: (dossierId: string, fiscalYearId?: string) => req<AnalyticReport>(`/api/dossiers/${dossierId}/analytic/report${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
};

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
