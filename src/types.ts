export type TransactionStatus = 'completed' | 'pending' | 'failed';
export type TransactionType = 'income' | 'expense';

export interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  type: TransactionType;
  category: string;
  status: TransactionStatus;
  merchant?: string;
}

export interface MonthlyStats {
  month: string;
  revenue: number;
  expenses: number;
}

export interface Insight {
  id: string;
  title: string;
  description: string;
  type: 'positive' | 'warning' | 'neutral';
  impact?: string;
}
