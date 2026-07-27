import type { Client } from '../db.js';
import { postEntry } from './accounting.js';
import { createAsset } from './assets.js';
import { recordAudit } from './audit.js';

// ============================================================================
// Immobilisations PRODUITES EN INTERNE : le chantier, de la première charge à
// la mise en service.
//
// Une entreprise qui construit pour elle-même engage des charges par nature —
// salaires (66), services extérieurs (62), achats (60). Laissées en charges,
// elles amputent le résultat d'un exercice alors qu'elles créent un actif
// durable. Le SYSCOHADA les neutralise par le compte 72 « Production
// immobilisée » et les accumule en compte d'en-cours (2191, 2193, 2391…), puis
// les vire au compte définitif à la mise en service, qui ouvre l'amortissement.
//
// Deux règles de fond, portées par le code et rappelées à l'utilisateur :
//   • seule la phase de DÉVELOPPEMENT se capitalise ; la recherche reste en
//     charges, définitivement ;
//   • on ne capitalise que des coûts RÉELLEMENT ENREGISTRÉS. Du temps non
//     rémunéré ne s'immobilise pas — il n'existe pas en comptabilité.
//
// Effet à connaître : la capitalisation passe par un PRODUIT (72). Elle
// augmente donc le résultat de l'exercice, et l'impôt avec. L'amortissement le
// rendra sur les exercices suivants : c'est un décalage, pas une perte — mais
// il pèse sur la trésorerie l'année où l'on dépense.
// ============================================================================

const round2 = (n: number) => Math.round(n * 100) / 100;

// Comptes d'en-cours admis et leur destination usuelle à la mise en service.
export const ENCOURS_CONNUS: { wip: string; cible: string; production: string; libelle: string }[] = [
  { wip: '2191', cible: '211', production: '721', libelle: 'Frais de développement' },
  { wip: '2193', cible: '212', production: '721', libelle: 'Logiciels et site internet' },
  { wip: '2198', cible: '218', production: '721', libelle: 'Autres droits et valeurs incorporels' },
  { wip: '2391', cible: '231', production: '722', libelle: 'Bâtiments' },
  { wip: '2392', cible: '232', production: '722', libelle: 'Installations techniques' },
  { wip: '2395', cible: '235', production: '722', libelle: 'Aménagements de bureaux' },
];

export interface WipInput {
  label: string;
  wipAccountCode: string;
  targetAccountCode?: string;
  productionAccountCode?: string;
  analyticSection?: string;
  startedOn: string;
  notes?: string;
}

async function assertCompte(c: Client, dossierId: string, code: string, quoi: string) {
  const { rows } = await c.query('select 1 from accounts where dossier_id=$1 and account_code=$2', [dossierId, code]);
  if (!rows[0]) throw new Error(`Compte ${quoi} « ${code} » absent du plan de ce dossier.`);
}

export async function listWip(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select w.*, coalesce(sum(k.amount), 0) as cumul, count(k.id)::int as nb_capitalisations
       from assets_in_progress w
       left join assets_in_progress_costs k on k.wip_id = w.id
      where w.dossier_id = $1
      group by w.id
      order by w.commissioned_on nulls first, w.started_on desc`,
    [dossierId],
  );
  return rows.map((r: any) => ({
    id: r.id, label: r.label,
    wipAccountCode: r.wip_account_code, targetAccountCode: r.target_account_code,
    productionAccountCode: r.production_account_code,
    analyticSection: r.analytic_section, startedOn: r.started_on, commissionedOn: r.commissioned_on,
    fixedAssetId: r.fixed_asset_id, notes: r.notes,
    cumul: round2(Number(r.cumul)), nbCapitalisations: r.nb_capitalisations,
    statut: r.commissioned_on ? 'en_service' : 'en_cours',
  }));
}

export async function createWip(c: Client, dossierId: string, input: WipInput, userId?: string) {
  if (!input.label?.trim()) throw new Error('Libellé requis.');
  const connu = ENCOURS_CONNUS.find((x) => x.wip === input.wipAccountCode);
  const cible = input.targetAccountCode || connu?.cible;
  const prod = input.productionAccountCode || connu?.production || '721';
  if (!cible) throw new Error(`Compte définitif requis : aucune destination usuelle connue pour l'en-cours ${input.wipAccountCode}.`);
  await assertCompte(c, dossierId, input.wipAccountCode, "d'en-cours");
  await assertCompte(c, dossierId, cible, 'définitif');
  await assertCompte(c, dossierId, prod, 'de production immobilisée');

  const { rows } = await c.query(
    `insert into assets_in_progress(dossier_id, label, wip_account_code, target_account_code,
        production_account_code, analytic_section, started_on, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [dossierId, input.label.trim(), input.wipAccountCode, cible, prod,
     input.analyticSection?.trim() || null, input.startedOn, input.notes ?? null, userId ?? null],
  );
  await recordAudit(c, { dossierId, action: 'wip.created', entity: 'assets_in_progress', entityId: rows[0].id, detail: { label: input.label } });
  return { id: rows[0].id };
}

// Coûts portés par la section analytique du chantier sur une période : ce que
// l'entreprise a réellement enregistré. Sert de PROPOSITION — le montant
// capitalisable reste un jugement (part développement vs recherche, quote-part
// de temps réellement consacrée).
export async function coutsDeLaPeriode(
  c: Client, dossierId: string, wipId: string, from: string, to: string,
): Promise<{ section: string | null; total: number; parCompte: { compte: string; intitule: string; montant: number }[] }> {
  const { rows: w } = await c.query('select analytic_section from assets_in_progress where dossier_id=$1 and id=$2', [dossierId, wipId]);
  if (!w[0]) throw new Error('Chantier introuvable.');
  const section = w[0].analytic_section as string | null;
  if (!section) return { section: null, total: 0, parCompte: [] };

  const { rows } = await c.query(
    `select a.account_code, a.label, coalesce(sum(l.amount_debit - l.amount_credit), 0) as montant
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id and a.class_no = 6
      where l.dossier_id = $1 and l.analytic_axis = $2
        and e.entry_date between $3::date and $4::date
      group by a.account_code, a.label
     having coalesce(sum(l.amount_debit - l.amount_credit), 0) <> 0
      order by 3 desc`,
    [dossierId, section, from, to],
  );
  const parCompte = rows.map((r: any) => ({ compte: r.account_code, intitule: r.label, montant: round2(Number(r.montant)) }));
  return { section, total: round2(parCompte.reduce((s, x) => s + x.montant, 0)), parCompte };
}

// Écriture de capitalisation : débit de l'en-cours, crédit de la production
// immobilisée. Les charges d'origine RESTENT en charges — c'est le produit 72
// qui les neutralise, pas une extourne.
export async function capitaliser(
  c: Client, dossierId: string, wipId: string,
  input: { date: string; montant: number; from?: string; to?: string; journalCode?: string; note?: string },
  userId?: string,
) {
  const { rows: w } = await c.query('select * from assets_in_progress where dossier_id=$1 and id=$2', [dossierId, wipId]);
  const wip = w[0];
  if (!wip) throw new Error('Chantier introuvable.');
  if (wip.commissioned_on) throw new Error('Chantier déjà mis en service : plus aucune capitalisation possible.');
  const montant = round2(Number(input.montant));
  if (!(montant > 0)) throw new Error('Montant à capitaliser invalide.');

  const { rows: j } = await c.query(
    `select id from journals where dossier_id=$1 and (code = $2 or type = 'operations_diverses') order by (code = $2) desc limit 1`,
    [dossierId, input.journalCode ?? 'OD'],
  );
  if (!j[0]) throw new Error("Aucun journal d'opérations diverses : créez-en un (OD).");
  const { rows: fy } = await c.query(
    'select id from fiscal_years where dossier_id=$1 and $2::date between start_date and end_date limit 1',
    [dossierId, input.date]);
  if (!fy[0]) throw new Error(`La date ${input.date} ne tombe dans aucun exercice.`);

  const libelle = `Production immobilisée — ${wip.label}`;
  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy[0].id, journalId: j[0].id, entryDate: input.date,
    description: input.note?.trim() || libelle, source: 'manual', createdBy: userId,
    lines: [
      { accountCode: wip.wip_account_code, debit: montant, label: libelle, analyticAxis: wip.analytic_section ?? undefined },
      { accountCode: wip.production_account_code, credit: montant, label: libelle },
    ],
  });

  await c.query(
    `insert into assets_in_progress_costs(dossier_id, wip_id, entry_id, amount, period_from, period_to, note)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [dossierId, wipId, entryId, montant, input.from ?? null, input.to ?? null, input.note ?? null],
  );
  await recordAudit(c, { dossierId, action: 'wip.capitalized', entity: 'assets_in_progress', entityId: wipId, detail: { montant, entryId } });
  return { entryId, montant };
}

// Mise en service : vire l'en-cours au compte définitif et crée
// l'immobilisation, qui démarre alors son amortissement.
export async function mettreEnService(
  c: Client, dossierId: string, wipId: string,
  input: { date: string; durationYears: number; residualValue?: number; journalCode?: string },
  userId?: string,
) {
  const { rows: w } = await c.query(
    `select w.*, coalesce((select sum(amount) from assets_in_progress_costs k where k.wip_id = w.id), 0) as cumul
       from assets_in_progress w where w.dossier_id=$1 and w.id=$2`, [dossierId, wipId]);
  const wip = w[0];
  if (!wip) throw new Error('Chantier introuvable.');
  if (wip.commissioned_on) throw new Error('Chantier déjà mis en service.');
  const cumul = round2(Number(wip.cumul));
  if (!(cumul > 0)) throw new Error("Rien à mettre en service : aucune capitalisation n'a été passée sur ce chantier.");
  if (!(input.durationYears > 0)) throw new Error("Durée d'utilité invalide.");

  const { rows: j } = await c.query(
    `select id from journals where dossier_id=$1 and (code = $2 or type = 'operations_diverses') order by (code = $2) desc limit 1`,
    [dossierId, input.journalCode ?? 'OD']);
  if (!j[0]) throw new Error("Aucun journal d'opérations diverses : créez-en un (OD).");
  const { rows: fy } = await c.query(
    'select id from fiscal_years where dossier_id=$1 and $2::date between start_date and end_date limit 1',
    [dossierId, input.date]);
  if (!fy[0]) throw new Error(`La date ${input.date} ne tombe dans aucun exercice.`);

  const libelle = `Mise en service — ${wip.label}`;
  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId: fy[0].id, journalId: j[0].id, entryDate: input.date,
    description: libelle, source: 'manual', createdBy: userId,
    lines: [
      { accountCode: wip.target_account_code, debit: cumul, label: libelle },
      { accountCode: wip.wip_account_code, credit: cumul, label: libelle },
    ],
  });

  const asset = await createAsset(c, dossierId, {
    label: wip.label,
    assetAccountCode: wip.target_account_code,
    acquisitionDate: wip.started_on,
    commissioningDate: input.date,
    amount: cumul,
    residualValue: input.residualValue ?? 0,
    durationYears: input.durationYears,
    notes: `Produite en interne — cumul de production immobilisée (${wip.wip_account_code}).`,
  } as any, userId);

  // L'immobilisation hérite de la section analytique du chantier : sans cela,
  // la rentabilité de l'activité verrait ses charges mais jamais son
  // investissement.
  if (wip.analytic_section) {
    await c.query('update fixed_assets set analytic_section=$3 where dossier_id=$1 and id=$2',
      [dossierId, asset.id, wip.analytic_section]);
  }

  await c.query(
    'update assets_in_progress set commissioned_on=$3, fixed_asset_id=$4 where dossier_id=$1 and id=$2',
    [dossierId, wipId, input.date, asset.id]);
  await recordAudit(c, { dossierId, action: 'wip.commissioned', entity: 'assets_in_progress', entityId: wipId, detail: { cumul, entryId, assetId: asset.id } });
  return { entryId, assetId: asset.id, montant: cumul };
}

export async function deleteWip(c: Client, dossierId: string, id: string) {
  const { rows } = await c.query(
    'select count(*)::int n from assets_in_progress_costs where dossier_id=$1 and wip_id=$2', [dossierId, id]);
  if (rows[0].n > 0) throw new Error("Des capitalisations ont été comptabilisées sur ce chantier : extournez-les d'abord.");
  await c.query('delete from assets_in_progress where dossier_id=$1 and id=$2', [dossierId, id]);
}
