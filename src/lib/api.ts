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
export interface BankAccount { account_code: string; label: string; moves: number; unpointed: number; }
export interface ReconMove { entry_line_id: string; entry_date: string; journal_code: string; piece_ref: string | null; label: string; debit: number; credit: number; pointed: boolean; }
export interface ReconView { balance: number; pointedBalance: number; moves: ReconMove[]; }
export interface TiersAccount { account_code: string; label: string; open_count: number; }
export interface OpenItem { entry_line_id: string; entry_date: string; journal_code: string; piece_ref: string | null; label: string; debit: number; credit: number; }
export interface LetteredItem { id: string; code: string; entry_date: string; piece_ref: string | null; label: string; debit: number; credit: number; }
export interface AgedRow { account_code: string; label: string; balance: number; b0_30: number; b31_60: number; b61_90: number; b90_plus: number; }
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
