import type { Client } from '../db.js';
import { recordAudit } from './audit.js';
import { tableExists, columnExists } from '../schema-cache.js';

// ============================================================================
// Couche domaine comptable — opérations sûres au-dessus du ledger Postgres.
// Aucune SQL "libre" côté API : tout passe par ces fonctions, qui s'appuient
// sur les garde-fous en base (équilibre, immuabilité, RLS, contre-passation).
// ============================================================================

export type OhadaCountry =
  | 'BJ' | 'BF' | 'CM' | 'CF' | 'KM' | 'CG' | 'CI' | 'GA' | 'GN'
  | 'GW' | 'GQ' | 'ML' | 'NE' | 'CD' | 'SN' | 'TD' | 'TG';
export type Currency = 'XOF' | 'XAF' | 'GNF' | 'CDF' | 'KMF' | 'EUR' | 'USD';
export type AccountingSystem = 'normal' | 'smt';
export type JournalType =
  | 'achats' | 'ventes' | 'banque' | 'caisse' | 'operations_diverses' | 'a_nouveaux';
export type EntrySource =
  | 'manual' | 'ocr' | 'bank_import' | 'mobile_money' | 'recurring' | 'api' | 'opening_balance';
export type PaymentChannel =
  | 'cash' | 'bank' | 'cheque' | 'om' | 'momo' | 'wave' | 'moov'
  | 'other_mobile_money' | 'card' | 'none';

export interface EntryLineInput {
  /** Code de compte SYSCOHADA (ex. '521', '701'). Résolu en interne. */
  accountCode: string;
  debit?: number;
  credit?: number;
  label?: string;
  paymentChannel?: PaymentChannel;
  counterpartyId?: string;
  taxCodeId?: string;
  analyticAxis?: string;
  externalRef?: string;
  /** Date d'origine de la pièce (reprise d'antériorité) — sert à l'ancienneté. */
  operationDate?: string;
}

export interface PostEntryInput {
  dossierId: string;
  fiscalYearId: string;
  journalId: string;
  entryDate: string; // 'YYYY-MM-DD'
  description: string;
  source?: EntrySource;
  pieceRef?: string;
  documentUrl?: string;
  aiConfidence?: number;
  createdBy?: string;
  counterpartyName?: string; // utilisé pour la mémoire de codification
  lines: EntryLineInput[];
}

// Normalisation d'un libellé/tiers en clé de codification (sans accents, minuscule).
export function normalizeKeyword(s: string): string {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// --- Onboarding & structures -------------------------------------------------

export async function onboardCabinet(
  c: Client,
  userId: string,
  name: string,
  country: OhadaCountry,
  currency: Currency = 'XOF',
  accountType: 'cabinet' | 'entreprise' = 'cabinet',
): Promise<string> {
  const { rows } = await c.query(
    'select onboard_cabinet($1,$2,$3,$4) as id',
    [userId, name, country, currency],
  );
  const id = rows[0].id;
  // Le type de compte passe par une fonction SECURITY DEFINER (la RLS de
  // cabinets n'autorise pas l'UPDATE direct). Tolérant : ignoré si la migration
  // 0058 n'est pas encore appliquée (le compte reste « cabinet » par défaut).
  if (accountType === 'entreprise') {
    try { await c.query('select cabinet_set_account_type($1,$2)', [id, 'entreprise']); }
    catch { /* migration pas encore appliquée — dégrade en cabinet */ }
  }
  return id;
}

// Change le type d'un compte existant (cabinet ↔ entreprise), owner/associé.
export async function setCabinetAccountType(c: Client, cabinetId: string, type: 'cabinet' | 'entreprise'): Promise<void> {
  await c.query('select cabinet_set_account_type($1,$2)', [cabinetId, type]);
}

export async function listCabinets(c: Client): Promise<any[]> {
  const hasType = await columnExists('cabinets', 'account_type');
  const { rows } = await c.query(
    `select id, name, country, base_currency, ${hasType ? 'account_type' : "'cabinet' as account_type"} from cabinets order by name`,
  );
  return rows;
}

export async function listDossiers(c: Client): Promise<any[]> {
  const { rows } = await c.query(
    `select id, cabinet_id, raison_sociale, country, base_currency, accounting_system, is_active,
            dossier_role_for(id) as role
       from dossiers order by raison_sociale`,
  );
  return rows;
}

export interface OpenDossierInput {
  cabinetId: string;
  raisonSociale: string;
  country: OhadaCountry;
  currency?: Currency;
  accountingSystem?: AccountingSystem;
  taxId?: string;
  rccm?: string;
  /** Instancie le plan SYSCOHADA dans le dossier (défaut: true). */
  instantiateChart?: boolean;
}

// Suppression complète d'un dossier (irréversible). L'autorisation (owner/associé
// du cabinet ou admin plateforme) et le démontage ordonné sont portés par la
// fonction SECURITY DEFINER dossier_delete (migration 0068).
export async function deleteDossier(c: Client, dossierId: string): Promise<void> {
  await c.query('select dossier_delete($1)', [dossierId]);
}

export async function openDossier(c: Client, input: OpenDossierInput): Promise<{ id: string; accounts: number }> {
  const { rows } = await c.query(
    `insert into dossiers(cabinet_id, raison_sociale, country, base_currency, accounting_system, tax_id, rccm)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [input.cabinetId, input.raisonSociale, input.country, input.currency ?? 'XOF', input.accountingSystem ?? 'normal',
     input.taxId ?? null, input.rccm ?? null]);
  const id = rows[0].id;
  let accounts = 0;
  if (input.instantiateChart !== false) {
    const r = await c.query('select instantiate_chart($1) as n', [id]);
    accounts = r.rows[0].n;
  }
  return { id, accounts };
}

export async function createFiscalYear(
  c: Client, dossierId: string, label: string, startDate: string, endDate: string,
): Promise<string> {
  const { rows } = await c.query(
    `insert into fiscal_years(dossier_id, label, start_date, end_date)
     values ($1,$2,$3,$4) returning id`,
    [dossierId, label, startDate, endDate],
  );
  return rows[0].id;
}

export async function createJournal(
  c: Client, dossierId: string, code: string, label: string, type: JournalType,
): Promise<string> {
  const { rows } = await c.query(
    `insert into journals(dossier_id, code, label, type) values ($1,$2,$3,$4) returning id`,
    [dossierId, code, label, type],
  );
  return rows[0].id;
}

export async function listFiscalYears(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    'select id, label, start_date, end_date, status from fiscal_years where dossier_id=$1 order by start_date',
    [dossierId],
  );
  return rows;
}

export async function listJournals(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    'select id, code, label, type from journals where dossier_id=$1 order by code',
    [dossierId],
  );
  return rows;
}

/** Crée l'exercice courant + les journaux standards s'ils n'existent pas. */
export async function setupDossierDefaults(
  c: Client, dossierId: string,
): Promise<{ fiscalYears: any[]; journals: any[] }> {
  let fys = await listFiscalYears(c, dossierId);
  if (fys.length === 0) {
    const year = new Date().getFullYear();
    await createFiscalYear(c, dossierId, `Exercice ${year}`, `${year}-01-01`, `${year}-12-31`);
    fys = await listFiscalYears(c, dossierId);
  }
  const defs: [string, string, JournalType][] = [
    ['AC', 'Achats', 'achats'],
    ['VE', 'Ventes', 'ventes'],
    ['BQ', 'Banque', 'banque'],
    ['CA', 'Caisse', 'caisse'],
    ['OD', 'Opérations diverses', 'operations_diverses'],
  ];
  const existing = await listJournals(c, dossierId);
  for (const [code, label, type] of defs) {
    if (!existing.find((j: any) => j.code === code)) {
      await createJournal(c, dossierId, code, label, type);
    }
  }
  return { fiscalYears: fys, journals: await listJournals(c, dossierId) };
}

export async function listAccounts(
  c: Client, dossierId: string, opts: { search?: string; classNo?: number; limit?: number; includeInactive?: boolean } = {},
): Promise<any[]> {
  const params: any[] = [dossierId];
  let sql = `select id, account_code, label, class_no, account_type, normal_side, is_collective, is_postable, is_active
             from accounts where dossier_id = $1${opts.includeInactive ? '' : ' and is_active = true'}`;
  if (opts.classNo) { params.push(opts.classNo); sql += ` and class_no = $${params.length}`; }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    sql += ` and (account_code ilike $${params.length} or label ilike $${params.length})`;
  }
  sql += ' order by account_code';
  // Un plan comptable est borné (~1500 comptes) : on charge large par défaut,
  // sinon la recherche/typeahead ne « voit » pas les classes au-delà des 100
  // premiers codes (les charges/produits 6/7 notamment).
  params.push(opts.limit ?? 3000); sql += ` limit $${params.length}`;
  const { rows } = await c.query(sql, params);
  return rows;
}

// --- Édition du plan comptable ----------------------------------------------

// Cherche, dans le plan SYSCOHADA officiel (gabarit par défaut), le compte dont
// le code est le plus long préfixe du code fourni. Sert à garantir qu'un compte
// créé se rattache bien au référentiel SYSCOHADA (conformité), et à hériter sa
// nature (classe, type, sens) du compte officiel parent.
async function syscohadaReference(
  c: Client, code: string,
): Promise<{ account_code: string; class_no: number; account_type: string; normal_side: string; is_collective: boolean } | null> {
  const prefixes: string[] = [];
  for (let i = code.length; i >= 2; i--) prefixes.push(code.slice(0, i));
  const { rows } = await c.query(
    `select cta.account_code, cta.class_no, cta.account_type, cta.normal_side, cta.is_collective
       from chart_template_accounts cta
       join chart_templates t on t.id = cta.template_id and t.is_default
      where cta.account_code = any($1)
      order by length(cta.account_code) desc
      limit 1`, [prefixes]);
  return rows[0] ?? null;
}

export async function createAccount(
  c: Client, dossierId: string, input: { accountCode: string; label: string; isCollective?: boolean },
): Promise<{ id: string }> {
  const code = String(input.accountCode ?? '').trim();
  // Plan à 8 chiffres : un compte détaillé peut aller jusqu'à 8 positions.
  if (!/^\d{2,8}$/.test(code)) throw new Error('Code de compte invalide : de 2 à 8 chiffres.');
  if (!input.label?.trim()) throw new Error('Intitulé requis.');
  const { rows: ex } = await c.query('select 1 from accounts where dossier_id=$1 and account_code=$2', [dossierId, code]);
  if (ex[0]) throw new Error(`Le compte ${code} existe déjà.`);

  // Conformité SYSCOHADA : le compte doit se rattacher à un compte officiel
  // (soit être ce compte, soit le prolonger — ex. 60110000 sous 601).
  const ref = await syscohadaReference(c, code);
  if (!ref) {
    throw new Error(`Compte non conforme au plan SYSCOHADA : « ${code} » ne se rattache à aucun compte officiel. Un compte créé doit prolonger un compte SYSCOHADA existant (ex. 6011 ou 60110000 sous 601).`);
  }
  // Hérite la nature du compte officiel racine (plus fiable que la seule classe).
  const meta = { classNo: ref.class_no, type: ref.account_type, side: ref.normal_side };
  const { rows } = await c.query(
    `insert into accounts(dossier_id, account_code, label, class_no, account_type, normal_side, is_collective, is_postable)
     values ($1,$2,$3,$4,$5::account_type,$6::account_nature,$7,true) returning id`,
    [dossierId, code, input.label.trim(), meta.classNo, meta.type, meta.side, !!input.isCollective || ref.is_collective || /^(40|41|42)/.test(code)],
  );
  return { id: rows[0].id };
}

export async function updateAccount(
  c: Client, dossierId: string, id: string, patch: { label?: string; isActive?: boolean },
): Promise<void> {
  const sets: string[] = []; const params: any[] = [dossierId, id];
  if (patch.label != null) { params.push(patch.label.trim()); sets.push(`label=$${params.length}`); }
  if (patch.isActive != null) { params.push(patch.isActive); sets.push(`is_active=$${params.length}`); }
  if (sets.length === 0) return;
  await c.query(`update accounts set ${sets.join(', ')} where dossier_id=$1 and id=$2`, params);
}

export async function deleteAccount(c: Client, dossierId: string, id: string): Promise<void> {
  const { rows } = await c.query(
    'select count(*)::int n from entry_lines where dossier_id=$1 and account_id=$2', [dossierId, id]);
  if (rows[0].n > 0) throw new Error('Compte mouvementé : désactivez-le plutôt que de le supprimer.');
  await c.query('delete from accounts where dossier_id=$1 and id=$2', [dossierId, id]);
}

// --- Le cœur : passer une écriture (atomique, équilibrée) --------------------

export async function postEntry(c: Client, input: PostEntryInput): Promise<{ id: string }> {
  if (!input.lines || input.lines.length < 2) {
    throw new Error('Une écriture exige au moins 2 lignes (partie double).');
  }
  const totalDebit = input.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCredit = input.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (totalDebit !== totalCredit) {
    throw new Error(`Écriture déséquilibrée : débit ${totalDebit} ≠ crédit ${totalCredit}.`);
  }

  // Garde-fou : la date d'écriture doit tomber dans les bornes de l'exercice.
  const { rows: fyr } = await c.query(
    "select label, to_char(start_date,'YYYY-MM-DD') as start, to_char(end_date,'YYYY-MM-DD') as end from fiscal_years where dossier_id=$1 and id=$2",
    [input.dossierId, input.fiscalYearId],
  );
  if (!fyr[0]) throw new Error('Exercice introuvable pour ce dossier.');
  if (input.entryDate < fyr[0].start || input.entryDate > fyr[0].end) {
    const fr = (s: string) => s.split('-').reverse().join('/');
    throw new Error(`La date ${fr(input.entryDate)} est hors de l'exercice « ${fyr[0].label} » (${fr(fyr[0].start)} – ${fr(fyr[0].end)}). Choisissez l'exercice correspondant ou une date dans l'exercice.`);
  }

  // Garde-fou : refuser une écriture dans un mois clôturé (clôtures mensuelles).
  // Tolérant : si la table n'existe pas encore (migration non appliquée), on saute.
  if (await tableExists('period_closures')) {
    const ey = Number(input.entryDate.slice(0, 4)), em = Number(input.entryDate.slice(5, 7));
    const { rows: closed } = await c.query(
      'select 1 from period_closures where dossier_id=$1 and (year*12 + month) >= ($2*12 + $3) limit 1',
      [input.dossierId, ey, em],
    );
    if (closed[0]) {
      const fr = (s: string) => s.split('-').reverse().join('/');
      throw new Error(`La période ${em}/${ey} est clôturée : aucune écriture ne peut y être ajoutée (date ${fr(input.entryDate)}). Rouvrez le mois pour saisir.`);
    }
  }

  // Résolution des comptes par code (dans le périmètre RLS du dossier)
  const codes = [...new Set(input.lines.map((l) => l.accountCode))];
  const { rows: accs } = await c.query(
    'select id, account_code, is_collective from accounts where dossier_id = $1 and account_code = any($2)',
    [input.dossierId, codes],
  );
  const byCode = new Map<string, { id: string; collective: boolean }>(
    accs.map((a: any) => [a.account_code, { id: a.id, collective: a.is_collective }]),
  );
  for (const code of codes) {
    if (!byCode.has(code)) throw new Error(`Compte ${code} introuvable dans ce dossier.`);
  }

  // Numéro de pièce séquentiel par journal et par exercice (ex. VE-2026-0001)
  let pieceRef = input.pieceRef;
  if (!pieceRef) {
    const { rows: jr } = await c.query('select code from journals where id = $1', [input.journalId]);
    const jcode = jr[0]?.code ?? 'OD';
    const { rows: cnt } = await c.query(
      'select count(*) n from entries where dossier_id=$1 and journal_id=$2 and fiscal_year_id=$3',
      [input.dossierId, input.journalId, input.fiscalYearId],
    );
    pieceRef = `${jcode}-${input.entryDate.slice(0, 4)}-${String(Number(cnt[0].n) + 1).padStart(4, '0')}`;
  }

  const { rows: er } = await c.query(
    `insert into entries(dossier_id, fiscal_year_id, journal_id, entry_date, description,
                         source, piece_ref, document_url, ai_confidence, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [
      input.dossierId, input.fiscalYearId, input.journalId, input.entryDate, input.description,
      input.source ?? 'manual', pieceRef, input.documentUrl ?? null,
      input.aiConfidence ?? null, input.createdBy ?? null,
    ],
  );
  const entryId = er[0].id;

  let lineNo = 1;
  for (const l of input.lines) {
    const acc = byCode.get(l.accountCode)!;
    // Auto-rattachement du tiers sur les comptes collectifs (401/411/42x).
    let counterpartyId = l.counterpartyId ?? null;
    if (!counterpartyId && input.counterpartyName && isCollective(l.accountCode, acc.collective)) {
      counterpartyId = await resolveCounterparty(c, input.dossierId, input.counterpartyName, tiersTypeForCode(l.accountCode));
    }
    await c.query(
      `insert into entry_lines(entry_id, dossier_id, account_id, line_no, amount_debit, amount_credit,
                               label, payment_channel, counterparty_id, tax_code_id, analytic_axis, external_ref, operation_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        entryId, input.dossierId, acc.id, lineNo++,
        l.debit ?? 0, l.credit ?? 0, l.label ?? null, l.paymentChannel ?? 'none',
        counterpartyId, l.taxCodeId ?? null, l.analyticAxis ?? null, l.externalRef ?? null, l.operationDate ?? null,
      ],
    );
  }

  // Validation : déclenche en base le contrôle d'équilibre + verrouillage
  await c.query("update entries set status = 'posted' where id = $1", [entryId]);

  // Apprentissage : enrichit la mémoire de codification du dossier.
  await learnFromEntry(c, input);

  // Piste d'audit : toute écriture comptabilisée est tracée (source incluse).
  await recordAudit(c, {
    dossierId: input.dossierId, action: 'entry.posted', entity: 'entry', entityId: entryId,
    detail: { piece_ref: pieceRef, source: input.source ?? 'manual', amount: totalDebit, lines: input.lines.length, description: input.description },
  });
  return { id: entryId };
}

// Enregistre les correspondances « libellé / tiers -> compte » de l'écriture.
async function learnFromEntry(c: Client, input: PostEntryInput): Promise<void> {
  const pairs: { keyword: string; code: string }[] = [];
  const cp = input.counterpartyName ? normalizeKeyword(input.counterpartyName) : '';

  for (const l of input.lines) {
    const cls = (l.accountCode || '')[0];
    // le tiers code surtout les comptes de charge/produit (classes 6 et 7)
    if (cp && (cls === '6' || cls === '7')) pairs.push({ keyword: cp, code: l.accountCode });
    const k = normalizeKeyword(l.label ?? '');
    if (k.length >= 3) pairs.push({ keyword: k, code: l.accountCode });
  }
  for (const p of pairs) {
    if (!p.keyword || !p.code) continue;
    await c.query(
      `insert into account_mappings(dossier_id, keyword, account_code)
       values ($1,$2,$3)
       on conflict (dossier_id, keyword, account_code)
       do update set hits = account_mappings.hits + 1, updated_at = now()`,
      [input.dossierId, p.keyword, p.code],
    );
  }
}

// --- Comptabilité auxiliaire : rattachement automatique des tiers -----------

function isCollective(code: string, flag: boolean): boolean {
  return flag || /^(40|41|42)/.test(code);
}
function tiersTypeForCode(code: string): 'client' | 'fournisseur' | 'salarie' | 'autre' {
  if (code.startsWith('41')) return 'client';
  if (code.startsWith('40')) return 'fournisseur';
  if (code.startsWith('42')) return 'salarie';
  return 'autre';
}

// Trouve le tiers par nom (insensible à la casse) ou le crée (compte auxiliaire).
export async function resolveCounterparty(
  c: Client, dossierId: string, name: string, type: 'client' | 'fournisseur' | 'salarie' | 'autre',
): Promise<string> {
  const trimmed = name.trim();
  const { rows: ex } = await c.query(
    'select id from counterparties where dossier_id=$1 and lower(name)=lower($2) limit 1', [dossierId, trimmed],
  );
  if (ex[0]) return ex[0].id;
  const collCode = type === 'client' ? '411' : type === 'fournisseur' ? '401' : type === 'salarie' ? '421' : null;
  let accId: string | null = null;
  if (collCode) {
    const { rows } = await c.query('select id from accounts where dossier_id=$1 and account_code=$2', [dossierId, collCode]);
    accId = rows[0]?.id ?? null;
  }
  const { rows: cnt } = await c.query('select count(*) n from counterparties where dossier_id=$1 and type=$2', [dossierId, type]);
  const aux = (collCode ?? 'TIER') + String(Number(cnt[0].n) + 1).padStart(4, '0');
  const { rows: ins } = await c.query(
    'insert into counterparties(dossier_id, type, name, aux_code, account_id) values ($1,$2,$3,$4,$5) returning id',
    [dossierId, type, trimmed, aux, accId],
  );
  return ins[0].id;
}

// Comptes imputables (classes 4-7) du dossier, pour ancrer l'IA sur le plan réel.
export async function getAccountsForPrompt(
  c: Client, dossierId: string,
): Promise<{ code: string; label: string }[]> {
  // On inclut comptes parents ET feuilles : en SYSCOHADA on impute souvent
  // sur un compte à 3 chiffres (ex. 628) sans descendre au sous-compte.
  const { rows } = await c.query(
    `select account_code, label from accounts
       where dossier_id=$1 and is_active and class_no in (4,5,6,7)
       order by account_code limit 1000`,
    [dossierId],
  );
  return rows.map((r: any) => ({ code: r.account_code, label: r.label }));
}

// Correspondances APPRISES (source learned) — les plus confirmées d'abord.
export async function getLearnedMappings(
  c: Client, dossierId: string, limit = 40,
): Promise<{ keyword: string; accountCode: string; hits: number }[]> {
  const { rows } = await c.query(
    `select keyword, account_code, hits from account_mappings
       where dossier_id=$1 and source='learned' order by hits desc, updated_at desc limit $2`,
    [dossierId, limit],
  );
  return rows.map((r: any) => ({ keyword: r.keyword, accountCode: r.account_code, hits: r.hits }));
}

// Règles MANUELLES du cabinet (priorité absolue à la capture).
export async function getManualRules(
  c: Client, dossierId: string,
): Promise<{ keyword: string; accountCode: string }[]> {
  const { rows } = await c.query(
    `select keyword, account_code from account_mappings
       where dossier_id=$1 and source='manual' order by updated_at desc`,
    [dossierId],
  );
  return rows.map((r: any) => ({ keyword: r.keyword, accountCode: r.account_code }));
}

// Liste complète (manuel + appris) avec intitulé du compte, pour l'éditeur.
export async function listMappings(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select m.id, m.keyword, m.account_code, m.hits, m.source, a.label as account_label
       from account_mappings m
       left join accounts a on a.dossier_id = m.dossier_id and a.account_code = m.account_code
      where m.dossier_id=$1
      order by (m.source='manual') desc, m.hits desc, m.updated_at desc`,
    [dossierId],
  );
  return rows;
}

// Crée/écrase une règle MANUELLE : elle remplace toute correspondance du même libellé.
export async function upsertManualRule(
  c: Client, dossierId: string, keywordRaw: string, accountCode: string,
): Promise<any> {
  const keyword = normalizeKeyword(keywordRaw);
  if (keyword.length < 2) throw new Error('Libellé/tiers trop court');
  const { rows: acc } = await c.query(
    'select label from accounts where dossier_id=$1 and account_code=$2',
    [dossierId, accountCode],
  );
  if (!acc[0]) throw new Error(`Compte ${accountCode} introuvable dans ce dossier`);
  // une règle manuelle pour ce libellé écrase les autres comptes du même libellé
  await c.query('delete from account_mappings where dossier_id=$1 and keyword=$2 and account_code<>$3', [dossierId, keyword, accountCode]);
  const { rows } = await c.query(
    `insert into account_mappings(dossier_id, keyword, account_code, source, hits)
       values ($1,$2,$3,'manual',5)
       on conflict (dossier_id, keyword, account_code)
       do update set source='manual', hits=greatest(account_mappings.hits,5), updated_at=now()
       returning id, keyword, account_code, hits, source`,
    [dossierId, keyword, accountCode],
  );
  return { ...rows[0], account_label: acc[0].label };
}

export async function deleteMapping(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from account_mappings where dossier_id=$1 and id=$2', [dossierId, id]);
}

export async function reverseEntry(c: Client, entryId: string, date?: string): Promise<{ reversalId: string }> {
  const { rows } = await c.query('select reverse_entry($1,$2) as id', [entryId, date ?? null]);
  const reversalId = rows[0].id;
  const { rows: dr } = await c.query('select dossier_id from entries where id = $1', [entryId]);
  await recordAudit(c, {
    dossierId: dr[0]?.dossier_id ?? null, action: 'entry.reversed', entity: 'entry', entityId: entryId,
    detail: { reversalId },
  });
  return { reversalId };
}

// ---- Dossier de démonstration (prise en main immédiate) --------------------

export async function seedDemoDossier(c: Client, cabinetId: string): Promise<{ dossierId: string }> {
  const { id } = await openDossier(c, { cabinetId, raisonSociale: 'Dossier de démonstration', country: 'CI' });
  const { fiscalYears, journals } = await setupDossierDefaults(c, id);
  // ⚠️ On capture l'exercice COURANT avant d'ajouter le N-1 : listFiscalYears
  // trie par date, donc fiscalYears[0] deviendrait 2025 et les écritures 2026
  // partiraient dans le mauvais exercice.
  const fy = fiscalYears[0].id;
  const J = (code: string) => journals.find((j: any) => j.code === code)!.id;
  const post = (jc: string, date: string, description: string, source: EntrySource, cp: string, lines: EntryLineInput[]) =>
    postEntry(c, { dossierId: id, fiscalYearId: fy, journalId: J(jc), entryDate: date, description, source, counterpartyName: cp, lines });

  // Bloc OPTIONNEL du seed. En Postgres, une requête en erreur avorte TOUTE la
  // transaction : un simple try/catch ne suffirait pas (tout ce qui suit
  // échouerait). On isole donc chaque bloc par un SAVEPOINT.
  let sp = 0;
  const safe = async (fn: () => Promise<unknown>): Promise<boolean> => {
    const name = `sp_seed_${++sp}`;
    await c.query(`savepoint ${name}`);
    try { await fn(); await c.query(`release savepoint ${name}`); return true; }
    catch { await c.query(`rollback to savepoint ${name}`); return false; }
  };

  // --- Identité complète : alimente l'en-tête des bulletins, les attestations,
  // les courriers, les déclarations et le dossier de financement.
  const identiteOk = await safe(() => c.query(
    `update dossiers set raison_sociale=$2, adresse=$3, ville=$4, telephone=$5, tax_id=$6, rccm=$7,
            numero_cnps=$8, forme_juridique=$9, regime_fiscal=$10, bank_name=$11, rib=$12
       where id=$1`,
    [id, 'Éburnéa Distribution SARL', 'Rue du Commerce, Zone 4C', 'Abidjan', '+225 27 21 00 00 00',
      'CI-2021-B-045178', 'CI-ABJ-2021-B-12345', '1234567', 'SARL', 'reel_simplifie',
      "Ecobank Côte d'Ivoire", 'CI93 CI000 01234 5678901234 56']));
  if (!identiteOk) await safe(() => c.query('update dossiers set raison_sociale=$2 where id=$1', [id, 'Éburnéa Distribution SARL']));

  // --- Exercice N-1 : indispensable aux états comparatifs, au TFT et au
  // dossier de financement (qui exige un historique).
  // pg renvoie start_date en objet Date : passer par getFullYear(), jamais par
  // String().slice() (qui donnerait « Thu »…).
  const curYear = new Date(fiscalYears[0].start_date).getFullYear();
  const prevYear = curYear - 1;
  await createFiscalYear(c, id, `Exercice ${prevYear}`, `${prevYear}-01-01`, `${prevYear}-12-31`);
  const allFys = await listFiscalYears(c, id);
  const fyPrev = allFys.find((f: any) => new Date(f.start_date).getFullYear() === prevYear)!.id;
  const postPrev = (jc: string, date: string, description: string, cp: string, lines: EntryLineInput[]) =>
    postEntry(c, { dossierId: id, fiscalYearId: fyPrev, journalId: J(jc), entryDate: date, description, source: 'manual' as EntrySource, counterpartyName: cp, lines });

  // Apport en capital : sans capitaux propres, le score financier et le dossier
  // de financement sont mécaniquement au plancher.
  await postPrev('BQ', `${prevYear}-01-02`, 'Constitution — apport en capital', 'Associés',
    [{ accountCode: '521', debit: 5000000, paymentChannel: 'bank' }, { accountCode: '101', credit: 5000000 }]);
  // Activité N-1 (base de comparaison pour l'évolution du CA).
  for (const [mois, ca, achat] of [['03', 1600000, 900000], ['06', 1900000, 1050000], ['09', 1750000, 980000], ['11', 2100000, 1150000]] as [string, number, number][]) {
    await postPrev('VE', `${prevYear}-${mois}-18`, 'Ventes du mois', 'Clients divers',
      [{ accountCode: '521', debit: ca, paymentChannel: 'bank' }, { accountCode: '701', credit: ca, analyticAxis: 'COCODY' }]);
    await postPrev('AC', `${prevYear}-${mois}-20`, 'Achats de marchandises', 'Grossiste Adjamé',
      [{ accountCode: '601', debit: achat, analyticAxis: 'COCODY' }, { accountCode: '521', credit: achat, paymentChannel: 'bank' }]);
  }

  // Sections analytiques de démo (deux points de vente) — pour illustrer les
  // restitutions par section et la vue mensuelle.
  await c.query(
    "insert into analytic_sections(dossier_id, code, label) values ($1,'COCODY','Boutique Cocody'),($1,'YOPOUGON','Boutique Yopougon')",
    [id]);

  // Ventes ventilées, réparties sur plusieurs mois (saisonnalité par point de vente).
  await post('VE', '2026-05-08', 'Vente marchandises comptant', 'ocr', 'Client Awa',
    [{ accountCode: '521', debit: 380000, paymentChannel: 'bank' }, { accountCode: '701', credit: 380000, analyticAxis: 'COCODY' }]);
  await post('VE', '2026-06-14', 'Prestation de service', 'mobile_money', 'Société TechCorp',
    [{ accountCode: '521', debit: 300000, paymentChannel: 'om' }, { accountCode: '706', credit: 300000, analyticAxis: 'YOPOUGON' }]);
  await post('VE', '2026-06-20', 'Vente marchandises comptant', 'ocr', 'Client Kouassi',
    [{ accountCode: '521', debit: 250000, paymentChannel: 'bank' }, { accountCode: '701', credit: 250000, analyticAxis: 'COCODY' }]);
  await post('VE', '2026-07-02', 'Vente marchandises comptant', 'ocr', 'Client Awa',
    [{ accountCode: '521', debit: 450000, paymentChannel: 'bank' }, { accountCode: '701', credit: 450000, analyticAxis: 'COCODY' }]);
  await post('VE', '2026-07-05', 'Prestation de service (Orange Money)', 'mobile_money', 'Société TechCorp',
    [{ accountCode: '521', debit: 200000, paymentChannel: 'om' }, { accountCode: '706', credit: 200000, analyticAxis: 'YOPOUGON' }]);
  await post('AC', '2026-07-06', 'Achat marchandises', 'ocr', 'Grossiste Adjamé',
    [{ accountCode: '601', debit: 180000, analyticAxis: 'COCODY' }, { accountCode: '401', credit: 180000 }]);
  await post('AC', '2026-07-08', 'Facture Orange Internet', 'ocr', 'Orange CI',
    [{ accountCode: '628', debit: 29661, analyticAxis: 'YOPOUGON' }, { accountCode: '445', debit: 5339 }, { accountCode: '401', credit: 35000 }]);
  await post('AC', '2026-07-10', 'Loyer boutique', 'manual', 'Bailleur Cocody',
    [{ accountCode: '622', debit: 120000, analyticAxis: 'COCODY' }, { accountCode: '521', credit: 120000, paymentChannel: 'bank' }]);
  await post('AC', '2026-07-30', 'Frais Mobile Money', 'mobile_money', 'Wave',
    [{ accountCode: '631', debit: 1200 }, { accountCode: '521', credit: 1200, paymentChannel: 'wave' }]);
  // NB : pas d'écriture de salaire « à la main » ici — la paie est réellement
  // comptabilisée plus bas (postPayroll), sinon le contrôle de cohérence
  // AQM paie ↔ compta signalerait un écart dans le dossier de démonstration.

  // Activité du début d'exercice : donne un chiffre d'affaires crédible, un
  // résultat positif et une tendance lisible (score, budget, prévisionnel).
  const y = String(curYear);
  for (const [mois, ca, achat] of [['01', 1850000, 1020000], ['02', 1720000, 960000], ['03', 2050000, 1130000], ['04', 2240000, 1210000]] as [string, number, number][]) {
    await post('VE', `${y}-${mois}-16`, 'Ventes du mois', 'ocr', 'Clients divers',
      [{ accountCode: '521', debit: ca, paymentChannel: 'bank' }, { accountCode: '701', credit: ca, analyticAxis: mois === '02' || mois === '04' ? 'YOPOUGON' : 'COCODY' }]);
    await post('AC', `${y}-${mois}-22`, 'Achats de marchandises', 'ocr', 'Grossiste Adjamé',
      [{ accountCode: '601', debit: achat, analyticAxis: 'COCODY' }, { accountCode: '521', credit: achat, paymentChannel: 'bank' }]);
    await post('AC', `${y}-${mois}-28`, 'Loyer des boutiques', 'manual', 'Bailleur Cocody',
      [{ accountCode: '622', debit: 120000, analyticAxis: 'COCODY' }, { accountCode: '521', credit: 120000, paymentChannel: 'bank' }]);
  }

  // Cycle achats fournisseurs : factures de démo (statuts variés + balance âgée).
  const { seedDemoPurchases } = await import('./purchases.js');
  await seedDemoPurchases(c, id);

  // Catalogue des articles/services vendus (prix, TVA, comptes de produit).
  const { seedDemoCatalog } = await import('./catalog.js');
  await seedDemoCatalog(c, id);

  // Immobilisation reprise (bien acquis avant la bascule, à mi-vie) : illustre la
  // reprise d'antériorité — cumul déjà amorti + dotations futures uniquement.
  const { createAsset } = await import('./assets.js');
  await createAsset(c, id, {
    label: 'Camionnette de livraison (reprise)', assetAccountCode: '2441',
    amount: 6000000, residualValue: 0, durationYears: 5,
    acquisitionDate: '2024-01-01', commissioningDate: '2024-01-01',
    depreciationPeriod: 'annual', depreciationMethod: 'linear',
    repriseCumul: 2400000, repriseDate: '2025-12-31',
  });

  // Portail client : compte client de démonstration (idempotent) + accès à CE
  // dossier. Permet de se connecter côté « espace client ».
  //   Identifiants démo : client-demo@nova.ci / ClientDemo2026
  await safe(async () => {
    const clientEmail = 'client-demo@nova.ci';
    const { rows: ex } = await c.query('select id from get_user_for_login($1)', [clientEmail]);
    if (!ex[0]) {
      const { hashPassword } = await import('../auth.js');
      await c.query('select register_user($1,$2,$3)', [clientEmail, hashPassword('ClientDemo2026'), 'Client Démo (Éburnéa)']);
    }
    await c.query('select dossier_client_grant($1,$2)', [id, clientEmail]);
  });

  // Paie de démo : 3 salariés + bulletins de juillet 2026 (non comptabilisés,
  // à valider dans l'onglet Paie) — illustre le module de bout en bout.
  await safe(async () => {
    const { createEmployee, runPayroll, postPayroll, createAbsence } = await import('./payroll.js');
    const e1 = await createEmployee(c, id, { matricule: 'S001', nom: 'Koné', prenoms: 'Awa', poste: 'Vendeuse', categorie: 'Employe', dateEmbauche: '2022-06-01', salaireBase: 180000, indemniteTransport: 30000, email: 'awa.kone@example.ci', typeContrat: 'CDI' });
    await createEmployee(c, id, { matricule: 'S002', nom: 'Traoré', prenoms: 'Bakary', poste: 'Chef de boutique', categorie: 'Agent de Maitrise', dateEmbauche: '2020-02-15', salaireBase: 350000, sursalaire: 50000, indemniteTransport: 40000, email: 'bakary.traore@example.ci', typeContrat: 'CDI' });
    await createEmployee(c, id, { matricule: 'S003', nom: 'Diabaté', prenoms: 'Fatou', poste: 'Comptable', categorie: 'Cadre', dateEmbauche: '2019-09-01', salaireBase: 600000, sursalaire: 150000, indemniteTransport: 50000, indemniteLogement: 100000, email: 'fatou.diabate@example.ci', typeContrat: 'CDI' });
    // Un CDD proche de son terme : illustre les ALERTES LÉGALES RH.
    const finCdd = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
    await createEmployee(c, id, { matricule: 'S004', nom: 'Yao', prenoms: 'Serge', poste: 'Magasinier (saison)', categorie: 'Employe', dateEmbauche: `${y}-02-01`, salaireBase: 160000, indemniteTransport: 30000, typeContrat: 'CDD', dateFinContrat: finCdd });
    // Absences : alimentent le taux d'absentéisme et la provision congés.
    await createAbsence(c, id, { employeeId: e1.id, dateDebut: `${y}-07-06`, dateFin: `${y}-07-08`, jours: 3, justifiee: true, paye: true, motif: 'Congés payés' });
    await createAbsence(c, id, { employeeId: e1.id, dateDebut: `${y}-07-20`, dateFin: `${y}-07-21`, jours: 2, justifiee: false, paye: false, motif: 'Absence non justifiée' });
    await runPayroll(c, id, Number(y), 6);
    // Comptabilisée pour de vrai : la démo doit être COHÉRENTE (contrôle AQM
    // paie ↔ compta au vert) et alimenter les charges de personnel.
    await postPayroll(c, id, Number(y), 6);
  });

  // Dotations aux amortissements dues : sans elles, le contrôle de cohérence
  // inter-modules signalerait des dotations en retard sur la démo.
  await safe(async () => {
    const { postDepreciationDue } = await import('./assets.js');
    await postDepreciationDue(c, id);
  });

  // Besoin de financement pré-rempli : le dossier bancaire est produisible
  // immédiatement (sinon la porte de complétude le bloque).
  await safe(() => c.query(
    `update dossiers set financing_brief = $2::jsonb where id=$1`,
    [id, JSON.stringify({
      montant: 8000000, objet: "Acquisition d'un véhicule de livraison et renforcement du stock",
      dureeMois: 36, tauxAnnuel: 10,
      garanties: 'Nantissement du véhicule financé + caution solidaire du gérant',
      engagements: 'Découvert autorisé de 1 500 000 XOF (Ecobank)',
    })]));

  return { dossierId: id };
}

// ---- Tableau de bord cabinet (agrégats portefeuille) -----------------------

const AUTO_SOURCES = ['ocr', 'mobile_money', 'bank_import', 'recurring', 'api'];
const SOURCE_LABELS: Record<string, string> = {
  manual: 'Manuelle', ocr: 'Capture IA', mobile_money: 'Mobile Money',
  bank_import: 'Import bancaire', recurring: 'Récurrente', api: 'API', opening_balance: 'À-nouveaux',
};

export async function cabinetDashboard(c: Client) {
  const { rows: dossiers } = await c.query(
    'select id, raison_sociale, base_currency from dossiers where is_active order by raison_sociale',
  );
  const { rows: agg } = await c.query(`
    select dossier_id,
      count(*) filter (where status='posted') as posted,
      count(*) filter (where status='draft') as drafts,
      count(*) filter (where status='posted' and source = any($1)) as auto,
      count(*) filter (where status='posted' and entry_date >= date_trunc('month', current_date)) as this_month,
      max(entry_date) filter (where status='posted') as last_date
    from entries group by dossier_id`, [AUTO_SOURCES]);
  const { rows: res } = await c.query(`
    select l.dossier_id, -sum(l.amount_debit - l.amount_credit) as resultat
    from entry_lines l
    join entries e on e.id = l.entry_id and e.status='posted'
    join accounts a on a.id = l.account_id and a.class_no in (6,7)
    group by l.dossier_id`);
  const { rows: fyRows } = await c.query('select dossier_id, count(*) n from fiscal_years group by dossier_id');
  const { rows: jrRows } = await c.query('select dossier_id, count(*) n from journals group by dossier_id');
  const { rows: srcRows } = await c.query(
    "select source, count(*) n from entries where status='posted' group by source order by n desc");

  const aggMap = new Map(agg.map((r: any) => [r.dossier_id, r]));
  const resMap = new Map(res.map((r: any) => [r.dossier_id, Number(r.resultat)]));
  const fyMap = new Map(fyRows.map((r: any) => [r.dossier_id, Number(r.n)]));
  const jrMap = new Map(jrRows.map((r: any) => [r.dossier_id, Number(r.n)]));

  let totalPosted = 0, totalAuto = 0, totalThisMonth = 0, resultatCumule = 0;
  const alerts: { type: string; dossierId: string; dossierName: string; message: string }[] = [];

  const perDossier = dossiers.map((d: any) => {
    const a: any = aggMap.get(d.id) ?? {};
    const posted = Number(a.posted ?? 0), drafts = Number(a.drafts ?? 0), auto = Number(a.auto ?? 0);
    const thisMonth = Number(a.this_month ?? 0);
    const resultat = resMap.get(d.id) ?? 0;
    const needsSetup = !(fyMap.get(d.id) && jrMap.get(d.id));
    totalPosted += posted; totalAuto += auto; totalThisMonth += thisMonth; resultatCumule += resultat;

    if (needsSetup) alerts.push({ type: 'setup', dossierId: d.id, dossierName: d.raison_sociale, message: 'Dossier à initialiser (exercice + journaux)' });
    if (drafts > 0) alerts.push({ type: 'draft', dossierId: d.id, dossierName: d.raison_sociale, message: `${drafts} écriture(s) en brouillon à valider` });
    if (posted === 0 && !needsSetup) alerts.push({ type: 'empty', dossierId: d.id, dossierName: d.raison_sociale, message: 'Aucune écriture comptabilisée' });

    return {
      id: d.id, raisonSociale: d.raison_sociale, currency: d.base_currency,
      entries: posted, drafts, autoPct: posted ? Math.round((auto / posted) * 100) : 0,
      resultat, lastDate: a.last_date ?? null, needsSetup,
    };
  });

  const sourceBreakdown = srcRows.map((r: any) => ({
    source: r.source, label: SOURCE_LABELS[r.source] ?? r.source, count: Number(r.n),
  }));

  return {
    dossierCount: dossiers.length,
    totalEntries: totalPosted,
    entriesThisMonth: totalThisMonth,
    autoCodedPct: totalPosted ? Math.round((totalAuto / totalPosted) * 100) : 0,
    resultatCumule,
    perDossier,
    sourceBreakdown,
    alerts,
  };
}

// ---- États financiers SYSCOHADA (Compte de résultat + Bilan) ---------------

const GROUP_LABELS: Record<string, string> = {
  '60': 'Achats et variations de stocks', '61': 'Transports', '62': 'Services extérieurs A',
  '63': 'Services extérieurs B', '64': 'Impôts et taxes', '65': 'Autres charges',
  '66': 'Charges de personnel', '67': 'Frais financiers et charges assimilées',
  '68': 'Dotations aux amortissements', '69': 'Dotations aux provisions et dépréciations',
  '70': 'Ventes', '71': "Subventions d'exploitation", '72': 'Production immobilisée',
  '73': 'Variations des stocks de produits', '75': 'Autres produits',
  '77': 'Revenus financiers et produits assimilés', '78': 'Transferts de charges',
  '79': 'Reprises de provisions et dépréciations',
};

export async function financialStatements(c: Client, dossierId: string, fiscalYearId?: string) {
  const params: any[] = [dossierId];
  let where = 'l.dossier_id=$1';
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id=$${params.length}`; }
  const { rows } = await c.query(
    `select a.account_code, a.label, a.class_no,
            sum(l.amount_debit - l.amount_credit) as balance
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted'
       join accounts a on a.id = l.account_id
      where ${where}
      group by a.account_code, a.label, a.class_no
     having sum(l.amount_debit - l.amount_credit) <> 0
      order by a.account_code`,
    params,
  );
  const accounts = rows.map((r: any) => ({ code: r.account_code, label: r.label, classNo: r.class_no, balance: Number(r.balance) }));

  // --- Compte de résultat (par nature) ---
  const groupSum = (cls: number, sign: 1 | -1) => {
    const m = new Map<string, number>();
    for (const a of accounts) if (a.classNo === cls) {
      const g = a.code.slice(0, 2);
      m.set(g, (m.get(g) ?? 0) + sign * a.balance);
    }
    return [...m.entries()].filter(([, v]) => v !== 0)
      .map(([g, amount]) => ({ group: g, label: GROUP_LABELS[g] ?? `Comptes ${g}`, amount }))
      .sort((x, y) => x.group.localeCompare(y.group));
  };
  const charges = groupSum(6, 1);     // débit positif
  const produits = groupSum(7, -1);   // crédit positif
  const totalCharges = charges.reduce((s, r) => s + r.amount, 0);
  const totalProduits = produits.reduce((s, r) => s + r.amount, 0);
  const resultatNet = totalProduits - totalCharges;

  // --- Soldes Intermédiaires de Gestion (cascade SYSCOHADA) ---
  const ch = (...pfx: string[]) => accounts.filter((a) => pfx.some((p) => a.code.startsWith(p))).reduce((s, a) => s + a.balance, 0);
  const pr = (...pfx: string[]) => accounts.filter((a) => pfx.some((p) => a.code.startsWith(p))).reduce((s, a) => s - a.balance, 0);

  const margeCommerciale = pr('701') - ch('601') - ch('6031');
  const production = pr('702', '703', '704', '705', '706', '707') + pr('72') + pr('73');
  const consommations = ch('602', '603', '604', '605', '606', '608') - ch('6031') + ch('61') + ch('62') + ch('63');
  const valeurAjoutee = margeCommerciale + production - consommations;
  const ebe = valeurAjoutee + pr('71') - ch('64') - ch('66');
  const resultatExploitation = ebe + pr('75') + pr('78') + pr('79') - ch('65') - ch('68') - ch('69');
  const resultatFinancier = pr('76', '77') - ch('67');
  const rao = resultatExploitation + resultatFinancier;
  const resultatHao = pr('82', '84', '86', '88') - ch('81', '83', '85');
  const resultatNetSig = rao + resultatHao - ch('87') - ch('89');

  const sig = [
    { label: "Chiffre d'affaires", amount: pr('70'), strong: false },
    { label: 'Marge commerciale', amount: margeCommerciale, strong: true },
    { label: "Production de l'exercice", amount: production, strong: false },
    { label: 'Valeur ajoutée (V.A.)', amount: valeurAjoutee, strong: true },
    { label: "Excédent brut d'exploitation (E.B.E.)", amount: ebe, strong: true },
    { label: "Résultat d'exploitation", amount: resultatExploitation, strong: true },
    { label: 'Résultat financier', amount: resultatFinancier, strong: false },
    { label: 'Résultat des activités ordinaires (R.A.O.)', amount: rao, strong: true },
    { label: 'Résultat hors activités ordinaires (H.A.O.)', amount: resultatHao, strong: false },
    { label: 'Résultat net', amount: resultatNetSig, strong: true },
  ];

  // --- Bilan (grandes masses) — équilibré par construction ---
  const sumClass = (cls: number) => accounts.filter((a) => a.classNo === cls).reduce((s, a) => s + a.balance, 0);
  const class4 = accounts.filter((a) => a.classNo === 4);
  const class5 = accounts.filter((a) => a.classNo === 5);
  const creances = class4.filter((a) => a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const dettesCirc = -class4.filter((a) => a.balance < 0).reduce((s, a) => s + a.balance, 0);
  const tresorerieActif = class5.filter((a) => a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const tresoreriePassif = -class5.filter((a) => a.balance < 0).reduce((s, a) => s + a.balance, 0);
  const class1 = accounts.filter((a) => a.classNo === 1);
  const capitauxPropres = -class1.filter((a) => Number(a.code.slice(0, 2)) <= 15).reduce((s, a) => s + a.balance, 0);
  const dettesFin = -class1.filter((a) => Number(a.code.slice(0, 2)) >= 16).reduce((s, a) => s + a.balance, 0);
  const actifImmobilise = sumClass(2);
  const stocks = sumClass(3);

  const actif = [
    { label: 'Actif immobilisé (net)', amount: actifImmobilise },
    { label: 'Stocks', amount: stocks },
    { label: 'Créances et emplois assimilés', amount: creances },
    { label: 'Trésorerie-Actif', amount: tresorerieActif },
  ].filter((r) => r.amount !== 0);
  const passif = [
    { label: 'Capitaux propres', amount: capitauxPropres },
    { label: "Résultat net de l'exercice", amount: resultatNet },
    { label: 'Dettes financières et ressources assimilées', amount: dettesFin },
    { label: 'Passif circulant', amount: dettesCirc },
    { label: 'Trésorerie-Passif', amount: tresoreriePassif },
  ].filter((r) => r.amount !== 0);
  const totalActif = actif.reduce((s, r) => s + r.amount, 0);
  const totalPassif = passif.reduce((s, r) => s + r.amount, 0);

  return {
    incomeStatement: { produits, charges, totalProduits, totalCharges, resultatNet, sig },
    balanceSheet: { actif, passif, totalActif, totalPassif, equilibre: Math.abs(totalActif - totalPassif) < 0.001 },
  };
}

// États financiers avec comparatif N‑1 : calcule l'exercice courant et le précédent.
export async function financialStatementsComparative(c: Client, dossierId: string, fiscalYearId?: string) {
  const fys = await listFiscalYears(c, dossierId); // triés par start_date asc
  let current = fiscalYearId ? fys.find((f: any) => f.id === fiscalYearId) : undefined;
  if (!current) current = fys.filter((f: any) => f.status !== 'closed')[0] ?? fys[fys.length - 1];
  const idx = current ? fys.findIndex((f: any) => f.id === current.id) : -1;
  const prev = idx > 0 ? fys[idx - 1] : null;
  const currentData = await financialStatements(c, dossierId, current?.id);
  const previousData = prev ? await financialStatements(c, dossierId, prev.id) : null;
  return {
    currentLabel: current?.label ?? null,
    previousLabel: prev?.label ?? null,
    current: currentData,
    previous: previousData,
  };
}

// Tableau de flux de trésorerie (TFT, SYSCOHADA révisé) — méthode INDIRECTE,
// reconstitué à partir des grandes masses N et N-1. SIMPLIFIÉ : ne capte pas
// finement les dividendes, mouvements de capital et l'affectation du résultat ;
// l'ÉCART DE RÉCONCILIATION mesure ces éléments non détaillés. Indicatif.
export async function cashFlowStatement(c: Client, dossierId: string, fiscalYearId?: string): Promise<any> {
  const cmp: any = await financialStatementsComparative(c, dossierId, fiscalYearId);
  const cur = cmp.current, prv = cmp.previous;
  if (!prv) return { hasPrevious: false, currentLabel: cmp.currentLabel, previousLabel: cmp.previousLabel };

  const A = (bs: any, label: string) => bs.actif.find((x: any) => x.label === label)?.amount ?? 0;
  const P = (bs: any, label: string) => bs.passif.find((x: any) => x.label === label)?.amount ?? 0;
  const bsN = cur.balanceSheet, bsP = prv.balanceSheet, isN = cur.incomeStatement;

  const tresorerieN = A(bsN, 'Trésorerie-Actif') - P(bsN, 'Trésorerie-Passif');
  const tresorerieN1 = A(bsP, 'Trésorerie-Actif') - P(bsP, 'Trésorerie-Passif');
  const variationConstatee = tresorerieN - tresorerieN1;

  // Charges non décaissées de l'exercice : dotations aux amortissements (68) et provisions (69).
  const grp = (code: string) => isN.charges.find((x: any) => x.group === code)?.amount ?? 0;
  const dotations = grp('68') + grp('69');
  const resultatNet = isN.resultatNet;

  // Variation du besoin en fonds de roulement (une hausse consomme de la trésorerie).
  const dCreances = A(bsN, 'Créances et emplois assimilés') - A(bsP, 'Créances et emplois assimilés');
  const dStocks = A(bsN, 'Stocks') - A(bsP, 'Stocks');
  const dDettesCirc = P(bsN, 'Passif circulant') - P(bsP, 'Passif circulant');
  const variationBFR = dCreances + dStocks - dDettesCirc;
  const fluxOperationnels = resultatNet + dotations - variationBFR;

  // Investissement : acquisitions nettes ≈ Δ actif immobilisé net + dotations.
  const dImmoNet = A(bsN, 'Actif immobilisé (net)') - A(bsP, 'Actif immobilisé (net)');
  const acquisitions = dImmoNet + dotations;
  const fluxInvestissement = -acquisitions;

  // Financement : Δ capitaux propres (structurels) + Δ dettes financières.
  const dCapitaux = P(bsN, 'Capitaux propres') - P(bsP, 'Capitaux propres');
  const dDettesFin = P(bsN, 'Dettes financières et ressources assimilées') - P(bsP, 'Dettes financières et ressources assimilées');
  const fluxFinancement = dCapitaux + dDettesFin;

  const variationCalculee = fluxOperationnels + fluxInvestissement + fluxFinancement;
  const ecartReconciliation = variationConstatee - variationCalculee;

  return {
    hasPrevious: true, currentLabel: cmp.currentLabel, previousLabel: cmp.previousLabel,
    resultatNet, dotations, dCreances, dStocks, dDettesCirc, variationBFR, fluxOperationnels,
    dImmoNet, acquisitions, fluxInvestissement,
    dCapitaux, dDettesFin, fluxFinancement,
    variationCalculee, ecartReconciliation, variationConstatee, tresorerieN1, tresorerieN,
  };
}

// Consultation d'un journal : écritures (avec leurs lignes) d'un journal.
export async function journalEntries(
  c: Client, dossierId: string, opts: { journal?: string; fiscalYearId?: string } = {},
): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = "e.dossier_id = $1 and e.status = 'posted'";
  if (opts.journal) { params.push(opts.journal); where += ` and j.code = $${params.length}`; }
  if (opts.fiscalYearId) { params.push(opts.fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }
  const { rows } = await c.query(
    `select e.id as entry_id, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, j.code as journal_code,
            e.piece_ref, e.description as entry_description, e.source, e.document_url,
            a.account_code, coalesce(l.label, e.description) as label,
            l.amount_debit as debit, l.amount_credit as credit
       from entries e
       join journals j on j.id = e.journal_id
       join entry_lines l on l.entry_id = e.id
       join accounts a on a.id = l.account_id
      where ${where}
      order by e.entry_date, e.created_at, l.line_no`,
    params,
  );
  return rows.map((r: any) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) }));
}

// Journal centralisateur : récapitulatif mensuel par journal (totaux débit/crédit
// de chaque journal, mois par mois). Livre comptable de synthèse OHADA.
export async function journalCentralisateur(
  c: Client, dossierId: string, fiscalYearId?: string,
): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = "e.dossier_id = $1 and e.status = 'posted'";
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }
  const { rows } = await c.query(
    `select j.code as journal_code, j.label as journal_label,
            to_char(date_trunc('month', e.entry_date), 'YYYY-MM') as mois,
            coalesce(sum(l.amount_debit), 0)  as debit,
            coalesce(sum(l.amount_credit), 0) as credit
       from entries e
       join journals j on j.id = e.journal_id
       join entry_lines l on l.entry_id = e.id
      where ${where}
      group by j.code, j.label, mois
      order by j.code, mois`,
    params,
  );
  return rows.map((r: any) => ({
    journal_code: r.journal_code, journal_label: r.journal_label, mois: r.mois,
    debit: Number(r.debit), credit: Number(r.credit),
  }));
}

// Clôture d'exercice : reporte les soldes de bilan (classes 1-5) en à-nouveaux
// dans l'exercice suivant, transfère le résultat (6-7) en report à nouveau (12),
// et clôture l'exercice. Le résultat part en 121 (bénéfice) ou 129 (perte).
export async function closeExercise(
  c: Client, dossierId: string, fiscalYearId: string,
): Promise<{ anEntryId: string; newFiscalYearId: string; resultat: number }> {
  const { rows: fy } = await c.query('select * from fiscal_years where dossier_id=$1 and id=$2', [dossierId, fiscalYearId]);
  if (!fy[0]) throw new Error('Exercice introuvable');
  if (fy[0].status === 'closed') throw new Error('Exercice déjà clôturé');
  const year = new Date(fy[0].start_date).getFullYear();

  // Soldes de bilan (classes 1-5) de l'exercice. On ventile PAR TIERS sur les
  // comptes détenant une contrepartie : les à-nouveaux des comptes clients/
  // fournisseurs (40x/41x/42x) portent ainsi un solde d'ouverture par tiers,
  // et la balance auxiliaire reprend correctement à l'ouverture. Les comptes
  // sans tiers sont agrégés (counterparty_id = null).
  const { rows: bals } = await c.query(
    `select a.account_code, l.counterparty_id, cp.name as counterparty_name,
            coalesce(sum(l.amount_debit - l.amount_credit), 0) as balance
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted' and e.fiscal_year_id = $2
       join accounts a on a.id = l.account_id and a.class_no between 1 and 5
       left join counterparties cp on cp.id = l.counterparty_id
      where l.dossier_id = $1
      group by a.account_code, l.counterparty_id, cp.name
     having coalesce(sum(l.amount_debit - l.amount_credit), 0) <> 0`,
    [dossierId, fiscalYearId],
  );
  // Résultat = produits - charges = -(somme des soldes classes 6 et 7)
  const { rows: rr } = await c.query(
    `select coalesce(sum(l.amount_debit - l.amount_credit), 0) as s
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status='posted' and e.fiscal_year_id = $2
       join accounts a on a.id = l.account_id and a.class_no in (6,7)
      where l.dossier_id = $1`,
    [dossierId, fiscalYearId],
  );
  const resultat = -Number(rr[0].s);

  // Exercice suivant (créé si absent)
  const nextStart = `${year + 1}-01-01`;
  const { rows: ny } = await c.query('select id from fiscal_years where dossier_id=$1 and start_date=$2', [dossierId, nextStart]);
  const newFiscalYearId = ny[0]?.id ?? await createFiscalYear(c, dossierId, `Exercice ${year + 1}`, nextStart, `${year + 1}-12-31`);

  // Journal des à-nouveaux (créé si absent)
  const { rows: jn } = await c.query("select id from journals where dossier_id=$1 and type='a_nouveaux' limit 1", [dossierId]);
  const anJournal = jn[0]?.id ?? await createJournal(c, dossierId, 'AN', 'À-nouveaux', 'a_nouveaux');

  const lines: EntryLineInput[] = bals.map((b: any) => {
    const bal = Number(b.balance);
    return {
      accountCode: b.account_code,
      counterpartyId: b.counterparty_id ?? undefined,
      label: b.counterparty_name ? `À-nouveau ${b.counterparty_name}` : undefined,
      debit: bal > 0 ? bal : 0,
      credit: bal < 0 ? -bal : 0,
    };
  });
  if (Math.abs(resultat) > 0.001) {
    if (resultat > 0) lines.push({ accountCode: '121', credit: resultat });
    else lines.push({ accountCode: '129', debit: -resultat });
  }
  if (lines.length < 2) throw new Error("Rien à reporter : l'exercice n'a pas de mouvements de bilan.");

  const { id: anEntryId } = await postEntry(c, {
    dossierId, fiscalYearId: newFiscalYearId, journalId: anJournal, entryDate: nextStart,
    description: `À-nouveaux ${year + 1} (report de clôture ${year})`, source: 'opening_balance', lines,
  });

  await c.query("update fiscal_years set status='closed' where dossier_id=$1 and id=$2", [dossierId, fiscalYearId]);
  await recordAudit(c, {
    dossierId, action: 'exercise.closed', entity: 'fiscal_year', entityId: fiscalYearId,
    detail: { resultat, anEntryId, newFiscalYearId },
  });
  return { anEntryId, newFiscalYearId, resultat };
}

// Grand livre : détail chronologique des mouvements par compte (dos de la balance).
export async function generalLedger(
  c: Client, dossierId: string, opts: { fiscalYearId?: string; accountCode?: string } = {},
): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'l.dossier_id = $1';
  if (opts.fiscalYearId) { params.push(opts.fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }
  if (opts.accountCode) { params.push(opts.accountCode); where += ` and a.account_code = $${params.length}`; }

  const { rows } = await c.query(
    `select a.account_code, a.label as account_label,
            to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, j.code as journal_code,
            e.piece_ref, e.description, l.label as line_label,
            l.amount_debit as debit, l.amount_credit as credit
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id
      where ${where}
      order by a.account_code, e.entry_date, e.created_at, l.line_no`,
    params,
  );
  return rows.map((r: any) => ({
    account_code: r.account_code, account_label: r.account_label,
    entry_date: r.entry_date, journal_code: r.journal_code,
    piece_ref: r.piece_ref, description: r.description, line_label: r.line_label,
    debit: Number(r.debit), credit: Number(r.credit),
  }));
}

// Balance à 6 / 8 colonnes : sépare les à-nouveaux (report) des mouvements de la
// période. Colonnes fournies : à-nouveaux (D/C), mouvements période (D/C),
// mouvements cumulés (D/C) et solde. Le front choisit la présentation 6 ou 8.
export async function trialBalance(
  c: Client, dossierId: string, fiscalYearId?: string,
): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'l.dossier_id = $1';
  if (fiscalYearId) { params.push(fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }
  const opening = `(e.source = 'opening_balance' or j.type = 'a_nouveaux')`;

  const { rows } = await c.query(
    `select a.account_code, a.label as account_label,
       coalesce(sum(l.amount_debit)  filter (where ${opening}), 0)     as open_debit,
       coalesce(sum(l.amount_credit) filter (where ${opening}), 0)     as open_credit,
       coalesce(sum(l.amount_debit)  filter (where not ${opening}), 0) as period_debit,
       coalesce(sum(l.amount_credit) filter (where not ${opening}), 0) as period_credit,
       coalesce(sum(l.amount_debit), 0)                                as total_debit,
       coalesce(sum(l.amount_credit), 0)                               as total_credit,
       coalesce(sum(l.amount_debit - l.amount_credit), 0)              as balance
     from entry_lines l
     join entries e on e.id = l.entry_id and e.status = 'posted'
     join journals j on j.id = e.journal_id
     join accounts a on a.id = l.account_id
     where ${where}
     group by a.account_code, a.label
     having coalesce(sum(l.amount_debit), 0) <> 0 or coalesce(sum(l.amount_credit), 0) <> 0
     order by a.account_code`,
    params,
  );
  return rows.map((r: any) => ({
    account_code: r.account_code, account_label: r.account_label,
    open_debit: Number(r.open_debit), open_credit: Number(r.open_credit),
    period_debit: Number(r.period_debit), period_credit: Number(r.period_credit),
    total_debit: Number(r.total_debit), total_credit: Number(r.total_credit),
    balance: Number(r.balance),
  }));
}
