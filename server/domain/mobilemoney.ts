import type { Client } from '../db.js';
import { parseStatement, suggestCounterAccount, type MMProvider } from '../mobilemoney/parser.js';
import { normalizeKeyword, postEntry } from './accounting.js';

// ============================================================================
// Connecteur Mobile Money : relevé -> propositions d'écritures pré-catégorisées
// (réutilise règles/apprentissage), avec déduplication par external_ref.
// L'IMPORT repasse par postEntry (équilibre, immuabilité, dédup en base).
// ============================================================================

export interface MMProposal {
  externalRef: string;
  date: string;
  direction: 'in' | 'out';
  amount: number;
  counterparty?: string;
  description: string;
  channel: MMProvider;
  counterAccount: string;
  counterLabel: string | null;
  alreadyImported: boolean;
}

export async function mobileMoneyProposals(
  c: Client, dossierId: string, provider: MMProvider, content: string,
): Promise<MMProposal[]> {
  const txs = parseStatement(content, provider);
  if (txs.length === 0) return [];

  // Règles/apprentissage : tiers -> compte (manuel prime sur appris)
  const { rows: maps } = await c.query(
    'select keyword, account_code, source from account_mappings where dossier_id=$1', [dossierId],
  );
  const ruleMap = new Map<string, string>();
  for (const m of maps.filter((x: any) => x.source === 'learned')) ruleMap.set(m.keyword, m.account_code);
  for (const m of maps.filter((x: any) => x.source === 'manual')) ruleMap.set(m.keyword, m.account_code);

  // Déduplication : quels external_ref existent déjà ?
  const refs = txs.map((t) => t.externalRef);
  const { rows: ex } = await c.query(
    'select external_ref from entry_lines where dossier_id=$1 and external_ref = any($2)', [dossierId, refs],
  );
  const imported = new Set(ex.map((r: any) => r.external_ref));

  const enriched = txs.map((t) => {
    const key = t.counterparty ? normalizeKeyword(t.counterparty) : '';
    const counterAccount = (key && ruleMap.get(key)) || suggestCounterAccount(t);
    return { ...t, counterAccount, counterLabel: null as string | null, alreadyImported: imported.has(t.externalRef) };
  });

  // Intitulés des comptes suggérés
  const codes = [...new Set(enriched.map((e) => e.counterAccount))];
  const { rows: la } = await c.query(
    'select account_code, label from accounts where dossier_id=$1 and account_code = any($2)', [dossierId, codes],
  );
  const labelMap = new Map(la.map((r: any) => [r.account_code, r.label]));
  return enriched.map((e) => ({ ...e, counterLabel: labelMap.get(e.counterAccount) ?? null }));
}

export interface MMImportEntry {
  externalRef: string;
  date: string;
  description: string;
  direction: 'in' | 'out';
  amount: number;
  counterAccount: string;
  channel: MMProvider;
  counterparty?: string;
  analyticAxis?: string;
}

/** Construit l'écriture en partie double d'un mouvement Mobile Money. */
export function toPostInput(
  e: MMImportEntry, dossierId: string, fiscalYearId: string, journalId: string, treasuryCode: string,
) {
  const treasuryLine = {
    accountCode: treasuryCode,
    paymentChannel: e.channel,
    externalRef: e.externalRef,
    label: e.description,
    ...(e.direction === 'in' ? { debit: e.amount } : { credit: e.amount }),
  };
  const counterLine = {
    accountCode: e.counterAccount,
    label: e.counterparty || e.description,
    analyticAxis: e.analyticAxis,
    ...(e.direction === 'in' ? { credit: e.amount } : { debit: e.amount }),
  };
  return {
    dossierId, fiscalYearId, journalId, entryDate: e.date, description: e.description,
    source: 'mobile_money' as const, counterpartyName: e.counterparty,
    lines: e.direction === 'in' ? [treasuryLine, counterLine] : [counterLine, treasuryLine],
  };
}

export { postEntry };
