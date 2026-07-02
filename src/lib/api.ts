import { getToken, clearToken } from './session';

// Client API typé. Passe par le proxy Vite (/api -> Express), donc chemins
// relatifs. L'identité voyage dans Authorization: Bearer <JWT>.

const BASE = (import.meta as any).env?.VITE_API_BASE ?? '';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
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
  if (res.status === 401) { clearToken(); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error ?? `Erreur ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Cabinet { id: string; name: string; country: string; base_currency: string; }
export interface Dossier {
  id: string; cabinet_id: string; raison_sociale: string; country: string;
  base_currency: string; accounting_system: string; is_active: boolean;
}
export interface Account {
  id: string; account_code: string; label: string; class_no: number;
  account_type: string; normal_side: string; is_collective: boolean; is_postable: boolean;
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
export interface TiersAccount { account_code: string; label: string; open_count: number; }
export interface OpenItem { entry_line_id: string; entry_date: string; journal_code: string; piece_ref: string | null; label: string; debit: number; credit: number; }
export interface LetteredItem { id: string; code: string; entry_date: string; piece_ref: string | null; label: string; debit: number; credit: number; }
export interface AgedRow { account_code: string; label: string; balance: number; b0_30: number; b31_60: number; b61_90: number; b90_plus: number; }
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
export interface AuditEntry {
  id: number; created_at: string; user_name: string | null; user_email: string | null;
  action: string; entity: string | null; entity_id: string | null; detail: Record<string, any>;
}
export interface FixedAsset {
  id: string; label: string;
  assetAccountCode: string; amortAccountCode: string; expenseAccountCode: string;
  acquisitionDate: string; commissioningDate: string;
  amount: number; residualValue: number; durationYears: number; method: string;
  counterpartyName: string | null; notes: string | null; status: string;
  cumulPosted: number; vnc: number; pendingYears: number[]; fullyAmortized: boolean;
}
export interface AssetScheduleRow { year: number; rate: number; dotation: number; cumul: number; vnc: number; posted: boolean; entryId: string | null; }
export interface FixedAssetDetail {
  id: string; label: string;
  assetAccountCode: string; amortAccountCode: string; expenseAccountCode: string;
  acquisitionDate: string; commissioningDate: string;
  amount: number; residualValue: number; durationYears: number; method: string;
  notes: string | null; status: string; schedule: AssetScheduleRow[];
}
export interface Invoice {
  id: string; number: string | null; client_name: string; invoice_date: string; status: string;
  total_ht: number; total_tva: number; total_ttc: number; fne_status: string; fne_reference: string | null; currency: string;
}
export interface InvoiceLine { id?: string; line_no?: number; description: string; quantity: number; unit_price: number; vat_rate: number; account_code: string; amount_ht?: number; amount_tva?: number; }
export interface InvoiceDetail extends Invoice { counterparty_id: string | null; due_date: string | null; entry_id: string | null; fne_qr: string | null; notes: string | null; lines: InvoiceLine[]; }
export interface JournalLine {
  entry_id: string; entry_date: string; journal_code: string; piece_ref: string | null;
  entry_description: string; source: string; account_code: string; label: string; debit: number; credit: number;
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
  accountCode: string; debit?: number; credit?: number; label?: string; paymentChannel?: string;
}
export interface ProposedLine {
  accountCode: string; accountLabel?: string; debit?: number; credit?: number; label?: string;
}
export interface CaptureProposal {
  description: string; entryDate?: string; journalCode?: string; counterpartyName?: string;
  currency: string; confidence: number; lines: ProposedLine[]; warnings?: string[];
}

export interface AuthUser { id: string; email: string; name: string | null; }

export const api = {
  register: (email: string, password: string, name: string) =>
    req<{ token: string; user: AuthUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    req<{ token: string; user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => req<AuthUser>('/api/auth/me'),
  cabinets: () => req<Cabinet[]>('/api/cabinets'),
  dashboard: () => req<DashboardData>('/api/dashboard'),
  seedDemo: () => req<{ dossierId: string }>('/api/demo/seed', { method: 'POST', body: '{}' }),
  onboard: (name: string, country: string) =>
    req<{ cabinetId: string }>('/api/onboarding/cabinet', { method: 'POST', body: JSON.stringify({ name, country }) }),
  dossiers: () => req<Dossier[]>('/api/dossiers'),
  createDossier: (input: { cabinetId: string; raisonSociale: string; country: string; accountingSystem?: string; taxId?: string }) =>
    req<{ id: string; accounts: number }>('/api/dossiers', { method: 'POST', body: JSON.stringify(input) }),
  accounts: (dossierId: string, q?: string) =>
    req<Account[]>(`/api/dossiers/${dossierId}/accounts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  fiscalYears: (dossierId: string) => req<FiscalYear[]>(`/api/dossiers/${dossierId}/fiscal-years`),
  journals: (dossierId: string) => req<Journal[]>(`/api/dossiers/${dossierId}/journals`),
  setupDossier: (dossierId: string) =>
    req<{ fiscalYears: FiscalYear[]; journals: Journal[] }>(`/api/dossiers/${dossierId}/setup`, { method: 'POST', body: '{}' }),
  postEntry: (dossierId: string, body: {
    fiscalYearId: string; journalId: string; entryDate: string; description: string;
    source?: string; counterpartyName?: string; lines: EntryLineInput[];
  }) => req<{ id: string }>(`/api/dossiers/${dossierId}/entries`, { method: 'POST', body: JSON.stringify(body) }),
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
  tiersAccounts: (dossierId: string) => req<TiersAccount[]>(`/api/dossiers/${dossierId}/tiers-accounts`),
  lettrageView: (dossierId: string, account: string) =>
    req<{ open: OpenItem[]; lettered: LetteredItem[] }>(`/api/dossiers/${dossierId}/lettrage?account=${encodeURIComponent(account)}`),
  createLettrage: (dossierId: string, accountCode: string, lineIds: string[]) =>
    req<{ id: string; code: string }>(`/api/dossiers/${dossierId}/lettrage`, { method: 'POST', body: JSON.stringify({ accountCode, lineIds }) }),
  deleteLettrage: (dossierId: string, id: string) =>
    req<void>(`/api/dossiers/${dossierId}/lettrage/${id}`, { method: 'DELETE' }),
  agedBalance: (dossierId: string, asOf?: string) =>
    req<AgedRow[]>(`/api/dossiers/${dossierId}/aged-balance${asOf ? `?asOf=${asOf}` : ''}`),
  vatDeclaration: (dossierId: string, from: string, to: string) =>
    req<VatDeclaration>(`/api/dossiers/${dossierId}/vat?from=${from}&to=${to}`),
  liquidateVat: (dossierId: string, body: { from: string; to: string; date: string }) =>
    req<{ entryId: string } & VatDeclaration>(`/api/dossiers/${dossierId}/vat/liquidate`, { method: 'POST', body: JSON.stringify(body) }),
  analyzeBalanceImport: (dossierId: string, body: { csv?: string; lines?: any[]; fiscalYearId?: string }) =>
    req<ImportBalanceAnalysis>(`/api/dossiers/${dossierId}/import-balance/analyze`, { method: 'POST', body: JSON.stringify(body) }),
  commitBalanceImport: (dossierId: string, body: { csv?: string; lines?: any[]; fiscalYearId: string; date: string; description?: string; createMissing?: boolean }) =>
    req<{ entryId: string; accountsCreated: number; lines: number; totalDebit: number }>(`/api/dossiers/${dossierId}/import-balance/commit`, { method: 'POST', body: JSON.stringify(body) }),
  audit: (dossierId: string, limit?: number) => req<AuditEntry[]>(`/api/dossiers/${dossierId}/audit${limit ? `?limit=${limit}` : ''}`),
  assets: (dossierId: string) => req<FixedAsset[]>(`/api/dossiers/${dossierId}/assets`),
  assetDetail: (dossierId: string, aid: string) => req<FixedAssetDetail>(`/api/dossiers/${dossierId}/assets/${aid}`),
  createAsset: (dossierId: string, body: { label: string; assetAccountCode: string; amortAccountCode?: string; expenseAccountCode?: string; acquisitionDate: string; commissioningDate?: string; amount: number; residualValue?: number; durationYears: number; notes?: string }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/assets`, { method: 'POST', body: JSON.stringify(body) }),
  deleteAsset: (dossierId: string, aid: string) => req<void>(`/api/dossiers/${dossierId}/assets/${aid}`, { method: 'DELETE' }),
  depreciateAsset: (dossierId: string, aid: string, year: number) =>
    req<{ entryId: string; amount: number; year: number }>(`/api/dossiers/${dossierId}/assets/${aid}/depreciate`, { method: 'POST', body: JSON.stringify({ year }) }),
  depreciateYear: (dossierId: string, year: number) =>
    req<{ count: number; total: number; skipped: number }>(`/api/dossiers/${dossierId}/depreciate-year`, { method: 'POST', body: JSON.stringify({ year }) }),
  invoices: (dossierId: string, status?: string) => req<Invoice[]>(`/api/dossiers/${dossierId}/invoices${status ? `?status=${status}` : ''}`),
  invoice: (dossierId: string, iid: string) => req<InvoiceDetail>(`/api/dossiers/${dossierId}/invoices/${iid}`),
  createInvoice: (dossierId: string, body: { clientName: string; invoiceDate: string; dueDate?: string; notes?: string; lines: InvoiceLine[] }) =>
    req<{ id: string }>(`/api/dossiers/${dossierId}/invoices`, { method: 'POST', body: JSON.stringify(body) }),
  deleteInvoice: (dossierId: string, iid: string) => req<void>(`/api/dossiers/${dossierId}/invoices/${iid}`, { method: 'DELETE' }),
  issueInvoice: (dossierId: string, iid: string) => req<{ number: string; entryId: string }>(`/api/dossiers/${dossierId}/invoices/${iid}/issue`, { method: 'POST', body: '{}' }),
  certifyInvoice: (dossierId: string, iid: string) => req<{ reference: string; provider: string }>(`/api/dossiers/${dossierId}/invoices/${iid}/certify`, { method: 'POST', body: '{}' }),
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
