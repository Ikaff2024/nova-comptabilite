import type { Client } from '../db.js';
import { tablePdf, letterPdf } from '../documents/pdf.js';
import { carryForwardFiscalYears, NOT_CARRY_FORWARD } from './carryforward.js';

// ============================================================================
// Comptabilité auxiliaire : plan des tiers, balance tiers, grand livre tiers.
// ============================================================================

const grp = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Retrouve un tiers par code auxiliaire ou par nom (utile à Lexa qui reçoit un nom).
export async function findCounterparty(c: Client, dossierId: string, ref: string): Promise<any | null> {
  const q = String(ref ?? '').trim();
  if (!q) return null;
  const { rows } = await c.query(
    `select id, name, type, aux_code, tax_id, email from counterparties
      where dossier_id=$1 and (aux_code ilike $2 or name ilike $3)
      order by (lower(aux_code)=lower($2)) desc, (aux_code ilike $2) desc, length(name) asc limit 1`,
    [dossierId, q, `%${q}%`]);
  return rows[0] ?? null;
}

export async function listCounterparties(c: Client, dossierId: string, type?: string): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'cp.dossier_id = $1';
  if (type) { params.push(type); where += ` and cp.type = $${params.length}`; }
  const { rows } = await c.query(
    `select cp.id, cp.type, cp.name, cp.aux_code, cp.tax_id, cp.email,
            a.account_code as collective
       from counterparties cp
       left join accounts a on a.id = cp.account_id
      where ${where}
      order by cp.type, cp.name`,
    params,
  );
  return rows;
}

const COLL: Record<string, string> = { client: '411', fournisseur: '401', salarie: '421' };

// Schéma de code tiers du dossier (tolérant si la colonne n'est pas migrée).
async function codeScheme(c: Client, dossierId: string): Promise<'numerique' | 'alphanumerique'> {
  try {
    const { rows } = await c.query('select tiers_code_scheme from dossiers where id=$1', [dossierId]);
    return rows[0]?.tiers_code_scheme === 'alphanumerique' ? 'alphanumerique' : 'numerique';
  } catch { return 'numerique'; }
}

// Génère le prochain code auxiliaire selon le schéma, en évitant les collisions.
async function nextAuxCode(c: Client, dossierId: string, type: string, collCode: string | null, name?: string): Promise<string> {
  const prefix = collCode ?? 'TIER';
  const taken = async (code: string) => {
    const { rows } = await c.query('select 1 from counterparties where dossier_id=$1 and aux_code=$2 limit 1', [dossierId, code]);
    return !!rows[0];
  };

  if ((await codeScheme(c, dossierId)) === 'alphanumerique') {
    // Collectif + radical alphanumérique tiré du nom (sans accents ni espaces).
    const base = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'TIERS';
    let code = prefix + base;
    let n = 1;
    while (await taken(code)) { n += 1; code = `${prefix}${base}${n}`; }
    return code;
  }

  // Numérique : collectif + numéro séquentiel (comportement historique).
  const { rows: cnt } = await c.query('select count(*) n from counterparties where dossier_id=$1 and type=$2', [dossierId, type]);
  let seq = Number(cnt[0].n) + 1;
  let code = prefix + String(seq).padStart(4, '0');
  while (await taken(code)) { seq += 1; code = prefix + String(seq).padStart(4, '0'); }
  return code;
}

export async function getTiersCodeScheme(c: Client, dossierId: string): Promise<'numerique' | 'alphanumerique'> {
  return codeScheme(c, dossierId);
}
export async function setTiersCodeScheme(c: Client, dossierId: string, scheme: string): Promise<void> {
  const s = scheme === 'alphanumerique' ? 'alphanumerique' : 'numerique';
  await c.query('update dossiers set tiers_code_scheme=$2 where id=$1', [dossierId, s]);
}

export async function createCounterparty(
  c: Client, dossierId: string, input: { type: string; name: string; auxCode?: string; taxId?: string; email?: string },
): Promise<any> {
  const type = input.type || 'client';
  if (!input.name?.trim()) throw new Error('Nom requis');
  const collCode = COLL[type] ?? null;
  let accId: string | null = null;
  if (collCode) {
    const { rows } = await c.query('select id from accounts where dossier_id=$1 and account_code=$2', [dossierId, collCode]);
    accId = rows[0]?.id ?? null;
  }
  let aux = input.auxCode?.trim();
  if (!aux) aux = await nextAuxCode(c, dossierId, type, collCode, input.name);
  const { rows } = await c.query(
    'insert into counterparties(dossier_id, type, name, aux_code, tax_id, email, account_id) values ($1,$2,$3,$4,$5,$6,$7) returning id, type, name, aux_code, tax_id, email',
    [dossierId, type, input.name.trim(), aux, input.taxId ?? null, input.email?.trim() || null, accId],
  );
  return rows[0];
}

export async function updateCounterparty(
  c: Client, dossierId: string, id: string, input: { name?: string; auxCode?: string; taxId?: string; email?: string },
): Promise<void> {
  await c.query(
    `update counterparties set
       name = coalesce($3, name),
       aux_code = coalesce($4, aux_code),
       tax_id = coalesce($5, tax_id),
       email = coalesce($6, email)
     where dossier_id=$1 and id=$2`,
    [dossierId, id, input.name ?? null, input.auxCode ?? null, input.taxId ?? null, input.email ?? null],
  );
}

export async function deleteCounterparty(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from counterparties where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Balance auxiliaire : un solde par tiers, dans les DEUX lectures que tient un
// comptable, côte à côte (cf. domain/carryforward.ts) :
//   • le solde de l'EXERCICE (à-nouveaux + mouvements) — c'est lui qui justifie
//     le compte collectif 401/411 de la balance générale du même exercice ;
//   • l'ENCOURS non lettré, toutes périodes, qui suit la vie des pièces
//     (facture impayée) sans se réinitialiser au 1er janvier.
// Les deux se recoupent quand tout est lettré ; l'écart, c'est ce qui reste dû.
export async function auxiliaryBalance(
  c: Client, dossierId: string, opts: { type?: string; fiscalYearId?: string } = {},
): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'cp.dossier_id = $1';
  if (opts.type) { params.push(opts.type); where += ` and cp.type = $${params.length}`; }

  params.push(opts.fiscalYearId ?? null);
  const fyP = params.length;
  params.push(await carryForwardFiscalYears(c, dossierId));
  const cfP = params.length;

  // Écritures retenues pour la lecture « exercice » (toutes si aucun exercice
  // n'est demandé) et pour la lecture « encours » (hors à-nouveaux de report).
  const inFy = `e.id is not null and ($${fyP}::uuid is null or e.fiscal_year_id = $${fyP}::uuid)`;
  const isOpen = `e.id is not null and ${NOT_CARRY_FORWARD(cfP)}
                  and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)`;

  const { rows } = await c.query(
    `select cp.id, cp.aux_code, cp.name, cp.type, coalesce(a.account_code, '') as collective,
            coalesce(sum(l.amount_debit)  filter (where ${inFy}), 0) as debit,
            coalesce(sum(l.amount_credit) filter (where ${inFy}), 0) as credit,
            coalesce(sum(l.amount_debit - l.amount_credit) filter (where ${inFy}), 0) as balance,
            coalesce(sum(l.amount_debit - l.amount_credit) filter (where ${isOpen}), 0) as open_balance,
            count(*) filter (where ${isOpen} and l.amount_debit <> l.amount_credit) as open_count
       from counterparties cp
       left join entry_lines l on l.counterparty_id = cp.id
       left join entries e on e.id = l.entry_id and e.status = 'posted'
       left join accounts a on a.id = cp.account_id
      where ${where}
      group by cp.id, cp.aux_code, cp.name, cp.type, a.account_code
      order by cp.type, cp.name`,
    params,
  );
  return rows.map((r: any) => ({
    id: r.id, aux_code: r.aux_code, name: r.name, type: r.type, collective: r.collective,
    debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.balance),
    open_balance: Number(r.open_balance), open_count: Number(r.open_count),
  }));
}

// Grand livre auxiliaire : mouvements d'un tiers.
// `fiscalYearId` : lecture par exercice (à-nouveaux compris).
// `cumulative`  : lecture toutes périodes — écarte alors les à-nouveaux de
//                 report, qui rejoueraient les pièces des exercices clos.
// `openOnly`    : ne garde que les postes non lettrés (ce qui reste dû).
export async function auxiliaryLedger(
  c: Client, dossierId: string, counterpartyId: string,
  opts: { fiscalYearId?: string; cumulative?: boolean; openOnly?: boolean } = {},
): Promise<any[]> {
  const params: any[] = [dossierId, counterpartyId];
  let where = 'l.dossier_id = $1 and l.counterparty_id = $2';
  if (opts.fiscalYearId) { params.push(opts.fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }
  if (opts.cumulative || opts.openOnly) {
    params.push(await carryForwardFiscalYears(c, dossierId));
    where += ` and ${NOT_CARRY_FORWARD(params.length)}`;
  }
  if (opts.openOnly) {
    where += ' and not exists (select 1 from lettrage_lines ll where ll.entry_line_id = l.id)';
  }
  const { rows } = await c.query(
    `select to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, j.code as journal_code, e.piece_ref,
            a.account_code, coalesce(l.label, e.description) as label,
            l.amount_debit as debit, l.amount_credit as credit
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id
      where ${where}
      order by e.entry_date, e.created_at`,
    params,
  );
  return rows.map((r: any) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) }));
}

// Grand livre auxiliaire complet : tous les mouvements de tous les tiers, triés
// par nature puis par tiers puis par date. Sert à justifier les comptes collectifs
// (411 / 401) ligne à ligne.
export async function allTiersLedger(
  c: Client, dossierId: string, opts: { type?: string; fiscalYearId?: string } = {},
): Promise<any[]> {
  const params: any[] = [dossierId];
  let where = 'l.dossier_id = $1';
  if (opts.type) { params.push(opts.type); where += ` and cp.type = $${params.length}`; }
  if (opts.fiscalYearId) { params.push(opts.fiscalYearId); where += ` and e.fiscal_year_id = $${params.length}`; }
  const { rows } = await c.query(
    `select cp.aux_code, cp.name as tiers_name, cp.type as tiers_type,
            to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, j.code as journal_code, e.piece_ref,
            a.account_code, coalesce(l.label, e.description) as label,
            l.amount_debit as debit, l.amount_credit as credit
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join journals j on j.id = e.journal_id
       join accounts a on a.id = l.account_id
       join counterparties cp on cp.id = l.counterparty_id
      where ${where}
      order by cp.type, cp.name, e.entry_date, e.created_at`,
    params,
  );
  return rows.map((r: any) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) }));
}

// --- Relevé de compte d'un tiers (état de compte, recouvrement) --------------
// Mouvements chronologiques + solde progressif + solde final (à recevoir/à payer).
export async function tiersStatement(c: Client, dossierId: string, counterpartyId: string): Promise<any> {
  const { rows: cp } = await c.query(
    'select id, name, type, aux_code, tax_id, email from counterparties where dossier_id=$1 and id=$2', [dossierId, counterpartyId]);
  if (!cp[0]) throw new Error('Tiers introuvable');
  // Relevé adressé au tiers : la vie du compte toutes périodes confondues, donc
  // sans les à-nouveaux de report (qui doubleraient les pièces déjà listées).
  const moves = await auxiliaryLedger(c, dossierId, counterpartyId, { cumulative: true });
  let solde = 0;
  const rows = moves.map((m: any) => { solde += m.debit - m.credit; return { ...m, solde: Math.round(solde * 100) / 100 }; });
  const debit = moves.reduce((s: number, m: any) => s + m.debit, 0);
  const credit = moves.reduce((s: number, m: any) => s + m.credit, 0);
  return { tiers: cp[0], rows, totals: { debit, credit, solde: Math.round((debit - credit) * 100) / 100 } };
}

// Relevé de compte en PDF (à imprimer / envoyer au tiers).
export async function tiersStatementPdf(c: Client, dossierId: string, counterpartyId: string, currency = 'XOF'): Promise<{ filename: string; buffer: Buffer; count: number; found: boolean }> {
  const st = await tiersStatement(c, dossierId, counterpartyId);
  const { rows: dr } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = dr[0]?.j ?? {};
  const money = (n: number) => (n ? `${grp(n)} ${currency}` : '');
  const tp = st.tiers;
  const supplier = tp.type === 'fournisseur';
  const soldeLabel = st.totals.solde === 0 ? 'soldé' : supplier ? (st.totals.solde < 0 ? 'à payer' : 'avance/avoir') : (st.totals.solde > 0 ? 'à recevoir' : 'avance/avoir');
  const today = new Date().toISOString().slice(0, 10);
  const meta = [
    `Émetteur : ${d.raison_sociale ?? '—'}${d.tax_id ? ` · NCC/IFU ${d.tax_id}` : ''}${d.rccm ? ` · RCCM ${d.rccm}` : ''}`,
    `${supplier ? 'Fournisseur' : 'Client'} : ${tp.name}${tp.aux_code ? ` (${tp.aux_code})` : ''}${tp.tax_id ? ` · ${tp.tax_id}` : ''}`,
  ];
  const buffer = await tablePdf({
    title: 'Relevé de compte',
    subtitle: `${tp.name} · au ${today}`,
    meta,
    columns: [
      { label: 'Date', width: 70 }, { label: 'Pièce', width: 85 }, { label: 'Libellé', width: 190 },
      { label: 'Débit', width: 80, align: 'right' }, { label: 'Crédit', width: 80, align: 'right' }, { label: 'Solde', width: 90, align: 'right' },
    ],
    rows: st.rows.map((r: any) => [r.entry_date, r.piece_ref ?? '', r.label ?? '', money(r.debit), money(r.credit), `${grp(r.solde)} ${currency}`]),
    totals: ['', '', `Solde (${soldeLabel})`, money(st.totals.debit), money(st.totals.credit), `${grp(st.totals.solde)} ${currency}`],
    footNote: `Relevé généré par Nova le ${today}.${st.totals.solde !== 0 ? ` Solde ${soldeLabel} : ${grp(Math.abs(st.totals.solde))} ${currency}.` : ''} Sauf erreur ou omission ; en cas de règlement récent, merci de ne pas tenir compte de ce relevé.`,
  });
  const safe = String(tp.aux_code || tp.name || 'tiers').replace(/[^a-zA-Z0-9]+/g, '-');
  return { filename: `releve-${safe}.pdf`, buffer, count: st.rows.length, found: true };
}

const MOIS_FR2 = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const dateFr2 = (d = new Date()) => `${d.getUTCDate()} ${MOIS_FR2[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// Lettre de confirmation de solde (circularisation) : demande au tiers de
// confirmer le solde figurant dans nos livres. Document d'audit / recouvrement.
export async function tiersBalanceLetterPdf(c: Client, dossierId: string, counterpartyId: string, currency = 'XOF'): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const st = await tiersStatement(c, dossierId, counterpartyId);
  const { rows: dr } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = dr[0]?.j ?? {};
  const tp = st.tiers;
  const supplier = tp.type === 'fournisseur';
  const solde = st.totals.solde;
  const abs = `${grp(Math.abs(solde))} ${currency}`;
  const sens = supplier ? (solde < 0 ? 'créditeur (en votre faveur)' : 'débiteur') : (solde > 0 ? 'débiteur (à votre charge)' : 'créditeur');
  const today = dateFr2();
  const buffer = await letterPdf({
    sender: [d.raison_sociale ?? '—', ...(d.tax_id ? [`NCC/IFU : ${d.tax_id}`] : []), ...(d.rccm ? [`RCCM : ${d.rccm}`] : [])],
    recipient: [`À l'attention de ${tp.name}`, ...(tp.aux_code ? [`Réf. compte : ${tp.aux_code}`] : [])],
    date: today,
    subject: `Confirmation de solde de compte au ${today}`,
    bodyBefore: [
      'Madame, Monsieur,',
      `Dans le cadre du suivi de nos comptes, nous vous informons que votre compte présente, dans nos livres au ${today}, un solde ${sens} de ${abs}.`,
      'Nous vous saurions gré de bien vouloir nous confirmer votre accord sur ce solde, ou, le cas échéant, de nous communiquer les éléments de désaccord (règlements ou factures non pris en compte).',
      solde === 0 ? 'À ce jour, votre compte est soldé.' : '',
    ].filter(Boolean),
    bodyAfter: [
      'Dans l\'attente de votre retour, nous vous prions d\'agréer, Madame, Monsieur, l\'expression de nos salutations distinguées.',
    ],
    signature: ['Pour ' + (d.raison_sociale ?? "l'entreprise"), 'La Direction', '', '(signature et cachet)'],
    footNote: `Document généré par Nova le ${today} — solde issu de la comptabilité auxiliaire. À vérifier et signer avant envoi.`,
  });
  const safe = String(tp.aux_code || tp.name || 'tiers').replace(/[^a-zA-Z0-9]+/g, '-');
  return { filename: `confirmation-solde-${safe}.pdf`, buffer, count: st.rows.length };
}
