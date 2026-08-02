import type { Client } from '../db.js';
import { postEntry, reverseEntry, normaliseDate } from './accounting.js';
import { recordAudit } from './audit.js';

// ============================================================================
// RECLASSEMENTS — préparés en brouillon, validés par un humain.
//
// Un reclassement ne corrige pas une écriture : le grand livre est immuable. Il
// passe une écriture NOUVELLE qui déplace le montant du compte erroné vers le
// compte correct. La piste reste donc lisible : on voit ce qui a été enregistré,
// puis ce qui a été redressé, et pourquoi.
//
// La règle qui gouverne ce module : on ne propose QUE ce qui est déductible
// sans jugement. Un fournisseur dont le solde est débiteur est une avance —
// c'est mécanique, la norme le dit. Un compte d'attente 47 non soldé, lui,
// demande de savoir CE QUE l'opération était : Lexa le signale, elle ne propose
// rien. Mieux vaut un silence qu'une proposition plausible et fausse.
//
// Et rien n'est jamais comptabilisé : tout sort en brouillon. Une écriture
// brouillon n'entre ni en balance ni dans les états, se modifie et se supprime.
// ============================================================================

const r2 = (n: number) => Math.round(n * 100) / 100;

export type NatureCandidat = 'fournisseur_debiteur' | 'client_crediteur' | 'exercice_errone' | 'attente_non_solde';

export interface CandidatReclassement {
  nature: NatureCandidat;
  /** true si le traitement se déduit sans jugement — seuls ceux-là sont proposés. */
  automatisable: boolean;
  libelle: string;
  montant: number;
  compteSource?: string;
  compteCible?: string;
  tiers?: { id: string; nom: string } | null;
  entryIds?: string[];
  explication: string;
}

// --- Détection ---------------------------------------------------------------

export async function candidatsReclassement(
  c: Client, dossierId: string, fiscalYearId?: string,
): Promise<CandidatReclassement[]> {
  const out: CandidatReclassement[] = [];
  const fyFilter = fiscalYearId ? 'and e.fiscal_year_id = $2' : '';
  const params: any[] = fiscalYearId ? [dossierId, fiscalYearId] : [dossierId];

  // 1) Fournisseur au solde débiteur = avance versée (409). Mécanique.
  // 2) Client au solde créditeur = avance reçue (419). Mécanique.
  const { rows: tiers } = await c.query(
    `select cp.id, cp.name, a.account_code,
            coalesce(sum(l.amount_debit - l.amount_credit), 0) as solde
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id
       join counterparties cp on cp.id = l.counterparty_id
      where l.dossier_id = $1 ${fyFilter}
        and (a.account_code like '40%' or a.account_code like '41%')
        and a.account_code not in ('409', '419')
      group by cp.id, cp.name, a.account_code
     having abs(coalesce(sum(l.amount_debit - l.amount_credit), 0)) > 0.5`,
    params);

  for (const t of tiers) {
    const solde = r2(Number(t.solde));
    if (t.account_code.startsWith('40') && solde > 0) {
      out.push({
        nature: 'fournisseur_debiteur', automatisable: true,
        libelle: `${t.name} — fournisseur au solde débiteur`,
        montant: solde, compteSource: t.account_code, compteCible: '409',
        tiers: { id: t.id, nom: t.name },
        explication: "Un compte fournisseur débiteur n'est pas une dette : c'est une avance versée, qui figure à l'ACTIF. Sans reclassement, le bilan présente une dette négative au passif.",
      });
    }
    if (t.account_code.startsWith('41') && solde < 0) {
      out.push({
        nature: 'client_crediteur', automatisable: true,
        libelle: `${t.name} — client au solde créditeur`,
        montant: r2(-solde), compteSource: t.account_code, compteCible: '419',
        tiers: { id: t.id, nom: t.name },
        explication: "Un compte client créditeur n'est pas une créance : c'est une avance reçue, qui figure au PASSIF. Sans reclassement, le bilan présente une créance négative à l'actif.",
      });
    }
  }

  // 3) Écritures rattachées à un exercice qui ne couvre pas leur date.
  // Le redressement n'est pas un virement de compte : il faut contre-passer
  // dans l'exercice erroné et réécrire dans le bon.
  const { rows: hors } = await c.query(
    `select e.id, to_char(e.entry_date,'YYYY-MM-DD') as d, e.description,
            f.label as exercice, to_char(f.start_date,'YYYY-MM-DD') as d1, to_char(f.end_date,'YYYY-MM-DD') as d2,
            coalesce((select sum(amount_debit) from entry_lines where entry_id = e.id), 0) as montant
       from entries e
       join fiscal_years f on f.id = e.fiscal_year_id
      where e.dossier_id = $1 and e.status = 'posted'
        and (e.entry_date < f.start_date or e.entry_date > f.end_date)
      order by e.entry_date`, [dossierId]);

  for (const h of hors) {
    // Existe-t-il un exercice ouvert qui couvre réellement la date ?
    const { rows: bon } = await c.query(
      "select label from fiscal_years where dossier_id=$1 and $2::date between start_date and end_date limit 1",
      [dossierId, h.d]);
    out.push({
      nature: 'exercice_errone',
      automatisable: !!bon[0],
      libelle: `${h.description} — datée du ${h.d}, rattachée à « ${h.exercice} »`,
      montant: r2(Number(h.montant)), entryIds: [h.id], tiers: null,
      explication: bon[0]
        ? `L'écriture porte l'exercice « ${h.exercice} » (${h.d1} → ${h.d2}) alors que sa date tombe dans « ${bon[0].label} ». Redressement : contre-passation dans l'exercice erroné, puis réécriture à l'identique dans le bon. N'étirez pas les bornes pour l'englober — ce serait mélanger deux exercices.`
        : `L'écriture est datée du ${h.d}, hors de « ${h.exercice} » (${h.d1} → ${h.d2}), et AUCUN exercice ne couvre cette date. Créez l'exercice manquant avant tout redressement.`,
    });
  }

  // 4) Comptes d'attente non soldés : signalés, jamais proposés — leur
  // destination dépend de la nature réelle de l'opération, qu'aucune règle ne
  // peut deviner.
  const { rows: attente } = await c.query(
    `select a.account_code, a.label, coalesce(sum(l.amount_debit - l.amount_credit), 0) as solde
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts a on a.id = l.account_id
      where l.dossier_id = $1 ${fyFilter} and a.account_code like '47%'
      group by a.account_code, a.label
     having abs(coalesce(sum(l.amount_debit - l.amount_credit), 0)) > 0.5`,
    params);

  for (const x of attente) {
    out.push({
      nature: 'attente_non_solde', automatisable: false,
      libelle: `${x.account_code} ${x.label} — non soldé`,
      montant: r2(Math.abs(Number(x.solde))), compteSource: x.account_code, tiers: null,
      explication: "Un compte d'attente doit être soldé à la clôture, mais sa destination dépend de la nature réelle de l'opération — elle ne se déduit pas du montant. À ventiler manuellement, en reprenant les pièces.",
    });
  }

  return out;
}

// --- Préparation du brouillon ------------------------------------------------

export interface ReclassementInput {
  compteSource: string;
  compteCible: string;
  montant: number;
  date: string;
  motif: string;
  counterpartyId?: string;
  journalCode?: string;
}

async function contexte(c: Client, dossierId: string, date: string, journalCode = 'OD') {
  const { rows: j } = await c.query(
    `select id from journals where dossier_id=$1 and (code = $2 or type = 'operations_diverses')
      order by (code = $2) desc limit 1`, [dossierId, journalCode]);
  if (!j[0]) throw new Error("Aucun journal d'opérations diverses : créez-en un (OD).");
  const { rows: fy } = await c.query(
    'select id, label from fiscal_years where dossier_id=$1 and $2::date between start_date and end_date limit 1',
    [dossierId, date]);
  if (!fy[0]) throw new Error(`Aucun exercice ne couvre le ${date}.`);
  return { journalId: j[0].id, fiscalYearId: fy[0].id, exercice: fy[0].label };
}

// Vire un montant d'un compte vers un autre, EN BROUILLON.
export async function preparerReclassement(
  c: Client, dossierId: string, input: ReclassementInput, userId?: string,
): Promise<{ entryId: string; montant: number; exercice: string }> {
  const montant = r2(Number(input.montant));
  if (!(montant > 0)) throw new Error('Montant à reclasser invalide.');
  if (!input.compteSource || !input.compteCible) throw new Error('Compte source et compte cible requis.');
  if (input.compteSource === input.compteCible) throw new Error('Les deux comptes sont identiques : rien à reclasser.');
  if (!input.motif?.trim()) throw new Error('Motif requis : un reclassement sans justification est inexploitable en révision.');

  const { journalId, fiscalYearId, exercice } = await contexte(c, dossierId, input.date, input.journalCode);
  const libelle = `Reclassement — ${input.motif.trim()}`;

  // Sens : on solde la source par son inverse. Un compte débiteur qu'on vide se
  // crédite, la cible reçoit au débit — et réciproquement, ce que l'appelant
  // exprime en choisissant l'ordre source → cible.
  const { id: entryId } = await postEntry(c, {
    dossierId, fiscalYearId, journalId, entryDate: input.date,
    description: libelle, source: 'manual', status: 'draft', createdBy: userId,
    lines: [
      { accountCode: input.compteCible, debit: montant, label: libelle, counterpartyId: input.counterpartyId },
      { accountCode: input.compteSource, credit: montant, label: libelle, counterpartyId: input.counterpartyId },
    ],
  });

  await recordAudit(c, {
    dossierId, action: 'reclassement.drafted', entity: 'entry', entityId: entryId,
    detail: { compteSource: input.compteSource, compteCible: input.compteCible, montant, motif: input.motif },
  });
  return { entryId, montant, exercice };
}

/**
 * Redressement d'une écriture mal rattachée : contre-passation dans l'exercice
 * où elle a été comptabilisée (obligatoire, le grand livre est immuable), puis
 * réécriture À L'IDENTIQUE avec la date et l'exercice corrigés — en BROUILLON.
 *
 * Attention à ce qui est immédiat et à ce qui ne l'est pas : la contre-passation
 * est COMPTABILISÉE tout de suite (une extourne ne se prépare pas, elle
 * s'enregistre), la réécriture attend la validation humaine. Entre les deux,
 * l'écriture n'est plus nulle part — c'est voulu, et ça doit se dire.
 */
async function redresser(
  c: Client, dossierId: string, entryId: string,
  cible: { fiscalYearId: string; date: string; label: string },
  userId?: string,
): Promise<{ extourneId: string; brouillonId: string; montant: number }> {
  const { rows } = await c.query(
    `select e.*, to_char(e.entry_date,'YYYY-MM-DD') as d, j.code as jcode, f.label as exercice
       from entries e join journals j on j.id = e.journal_id
       join fiscal_years f on f.id = e.fiscal_year_id
      where e.dossier_id=$1 and e.id=$2`, [dossierId, entryId]);
  const e = rows[0];

  const { rows: lignes } = await c.query(
    `select a.account_code, l.amount_debit, l.amount_credit, l.label, l.counterparty_id, l.analytic_axis, l.id as line_id
       from entry_lines l join accounts a on a.id = l.account_id
      where l.entry_id = $1 order by l.line_no`, [entryId]);

  // Les axes secondaires suivent la réécriture : les perdre viderait l'analytique
  // de l'exercice d'arrivée sans que le total, lui, ne bouge.
  const { rows: ax } = await c.query(
    `select ela.entry_line_id, a.code as axe, s.code as section
       from entry_line_analytics ela
       join analytic_axes a on a.id = ela.axis_id
       join analytic_sections s on s.id = ela.section_id
      where ela.dossier_id=$1 and ela.entry_line_id = any($2::uuid[])`,
    [dossierId, lignes.map((l: any) => l.line_id)]);
  const axesDe = new Map<string, Record<string, string>>();
  for (const a of ax) {
    const cur = axesDe.get(a.entry_line_id) ?? {};
    cur[a.axe] = a.section;
    axesDe.set(a.entry_line_id, cur);
  }

  const { reversalId } = await reverseEntry(c, entryId);

  const { rows: j } = await c.query('select id from journals where dossier_id=$1 and code=$2 limit 1', [dossierId, e.jcode]);
  const memeExercice = cible.fiscalYearId === e.fiscal_year_id;
  const mention = memeExercice
    ? `date corrigée, était ${e.d}`
    : `réaffecté depuis « ${e.exercice} »`;
  const { id: brouillonId } = await postEntry(c, {
    dossierId, fiscalYearId: cible.fiscalYearId, journalId: j[0]?.id ?? e.journal_id, entryDate: cible.date,
    description: `${e.description} (${mention})`,
    source: e.source, status: 'draft', createdBy: userId,
    lines: lignes.map((l: any) => ({
      accountCode: l.account_code,
      debit: Number(l.amount_debit) || undefined,
      credit: Number(l.amount_credit) || undefined,
      label: l.label ?? undefined,
      counterpartyId: l.counterparty_id ?? undefined,
      analyticAxis: l.analytic_axis ?? undefined,
      axes: axesDe.get(l.line_id),
    })),
  });

  const montant = r2(lignes.reduce((s: number, l: any) => s + Number(l.amount_debit), 0));
  await recordAudit(c, {
    dossierId, action: 'reclassement.exercice', entity: 'entry', entityId: entryId,
    detail: { extourneId: reversalId, brouillonId, de: e.exercice, vers: cible.label, dateAvant: e.d, dateApres: cible.date, montant },
  });
  return { extourneId: reversalId, brouillonId, montant };
}

// Écriture rattachée au mauvais exercice : on la remet dans celui qui couvre sa
// date, à date inchangée.
export async function preparerReaffectationExercice(
  c: Client, dossierId: string, entryId: string, userId?: string,
): Promise<{ extourneId: string; brouillonId: string; exercice: string; montant: number }> {
  const { rows } = await c.query(
    `select e.status, to_char(e.entry_date,'YYYY-MM-DD') as d, f.label as exercice,
            to_char(f.start_date,'YYYY-MM-DD') as d1, to_char(f.end_date,'YYYY-MM-DD') as d2
       from entries e join fiscal_years f on f.id = e.fiscal_year_id
      where e.dossier_id=$1 and e.id=$2`, [dossierId, entryId]);
  const e = rows[0];
  if (!e) throw new Error('Écriture introuvable.');
  if (e.status !== 'posted') throw new Error('Seule une écriture validée se réaffecte : un brouillon se corrige directement.');
  if (e.d >= e.d1 && e.d <= e.d2) throw new Error(`L'écriture est déjà dans les bornes de « ${e.exercice} » : rien à réaffecter.`);

  const { rows: cible } = await c.query(
    "select id, label from fiscal_years where dossier_id=$1 and status <> 'closed' and $2::date between start_date and end_date limit 1",
    [dossierId, e.d]);
  if (!cible[0]) throw new Error(`Aucun exercice ouvert ne couvre le ${e.d} : créez-le ou rouvrez-le avant de réaffecter.`);

  const r = await redresser(c, dossierId, entryId, { fiscalYearId: cible[0].id, date: e.d, label: cible[0].label }, userId);
  return { ...r, exercice: cible[0].label };
}

// --- Redressement en masse ---------------------------------------------------
//
// Quinze écritures mal rattachées se redressent une par une : c'est long, et
// surtout on ne voit jamais l'effet d'ensemble avant de s'être engagé. D'où cet
// écran : sélection, APERÇU DE L'IMPACT SUR LES DEUX EXERCICES, puis exécution.
//
// Le point qui compte, et qu'un traitement en lot rend dangereux s'il est tu :
// « mal rattachée » ne dit PAS laquelle des deux données est fausse.
//
//   · la date est bonne, l'exercice est faux  → on déplace l'écriture ;
//   · l'exercice est bon, la DATE est fausse  → on corrige la date, sur place.
//
// Le second cas est le plus fréquent quand les pièces arrivent par capture ou
// par import : l'outil date la pièce du jour de la saisie. Déplacer l'écriture
// serait alors doublement faux — elle partirait dans un exercice où elle n'a
// rien à faire, en changeant le résultat de deux années.
//
// Nova ne tranche pas à la place du comptable. Elle donne l'indice qu'elle a :
// quand la date d'écriture est exactement la date de SAISIE et que la pièce
// vient d'un canal automatique, c'est la date qui est suspecte, pas l'exercice.

export type IndiceRattachement = 'date_suspecte' | 'exercice_suspect';

export interface EcritureMalRattachee {
  id: string; date: string; description: string; journal: string; source: string;
  montant: number; resultat: number;
  exercice: { id: string; label: string; debut: string; fin: string; statut: string };
  exerciceDeLaDate: { id: string; label: string; statut: string } | null;
  dateDeSaisie: string;
  indice: IndiceRattachement;
  raison: string;
}

export async function ecrituresMalRattachees(c: Client, dossierId: string): Promise<EcritureMalRattachee[]> {
  const { rows } = await c.query(
    `select e.id, to_char(e.entry_date,'YYYY-MM-DD') as date, e.description, e.source,
            j.code as journal,
            f.id as fy_id, f.label as fy_label, f.status as fy_statut,
            to_char(f.start_date,'YYYY-MM-DD') as fy_debut, to_char(f.end_date,'YYYY-MM-DD') as fy_fin,
            to_char(e.created_at,'YYYY-MM-DD') as saisie,
            coalesce((select sum(l.amount_debit) from entry_lines l where l.entry_id = e.id), 0) as montant,
            -- Contribution au RÉSULTAT : produits (cl.7) moins charges (cl.6).
            -- C'est elle qui bouge d'un exercice à l'autre, pas le montant brut.
            coalesce((select sum(case a.class_no
                        when 7 then l.amount_credit - l.amount_debit
                        when 6 then l.amount_credit - l.amount_debit
                        else 0 end)
                        from entry_lines l join accounts a on a.id = l.account_id
                       where l.entry_id = e.id and a.class_no in (6,7)), 0) as resultat,
            cible.id as cible_id, cible.label as cible_label, cible.status as cible_statut
       from entries e
       join journals j on j.id = e.journal_id
       join fiscal_years f on f.id = e.fiscal_year_id
       left join lateral (
            select fy.id, fy.label, fy.status from fiscal_years fy
             where fy.dossier_id = e.dossier_id and e.entry_date between fy.start_date and fy.end_date
             order by fy.start_date limit 1) cible on true
      where e.dossier_id = $1 and e.status = 'posted'
        and e.reversed_by_entry_id is null
        and (e.entry_date < f.start_date or e.entry_date > f.end_date)
      order by e.entry_date, e.created_at`, [dossierId]);

  const AUTO = new Set(['ocr', 'bank_import', 'mobile_money', 'api', 'recurring']);
  return rows.map((r: any) => {
    const dateEgaleSaisie = r.date === r.saisie;
    const auto = AUTO.has(r.source);
    const indice: IndiceRattachement = dateEgaleSaisie && auto ? 'date_suspecte' : 'exercice_suspect';
    return {
      id: r.id, date: r.date, description: r.description, journal: r.journal, source: r.source,
      montant: r2(Number(r.montant)), resultat: r2(Number(r.resultat)),
      exercice: { id: r.fy_id, label: r.fy_label, debut: r.fy_debut, fin: r.fy_fin, statut: r.fy_statut },
      exerciceDeLaDate: r.cible_id ? { id: r.cible_id, label: r.cible_label, statut: r.cible_statut } : null,
      dateDeSaisie: r.saisie,
      indice,
      raison: indice === 'date_suspecte'
        ? `La date de l'écriture (${r.date}) est exactement celle de sa saisie, et la pièce vient d'un canal automatique : c'est la DATE qui est probablement fausse, pas l'exercice. Corrigez-la à la date réelle de l'opération — l'écriture reste alors dans « ${r.fy_label} ».`
        : `L'écriture est datée du ${r.date}, hors de « ${r.fy_label} » (${r.fy_debut} → ${r.fy_fin})${r.cible_label ? `, alors que « ${r.cible_label} » couvre cette date` : ", et aucun exercice ne couvre cette date"}.`,
    };
  });
}

export type ModeRedressement = 'exercice' | 'date';
export interface ChoixRedressement { entryId: string; mode: ModeRedressement; nouvelleDate?: string }

interface Plan {
  ecriture: EcritureMalRattachee;
  mode: ModeRedressement;
  date: string;
  fiscalYearId: string;
  exercice: string;
}

/** Valide chaque choix et calcule la cible. Lève à la PREMIÈRE incohérence. */
async function planifier(c: Client, dossierId: string, choix: ChoixRedressement[]): Promise<Plan[]> {
  if (!choix?.length) throw new Error('Aucune écriture sélectionnée.');
  const toutes = await ecrituresMalRattachees(c, dossierId);
  const parId = new Map(toutes.map((e) => [e.id, e]));
  const plans: Plan[] = [];

  for (const ch of choix) {
    const e = parId.get(ch.entryId);
    if (!e) throw new Error(`Écriture ${ch.entryId.slice(0, 8)} introuvable ou déjà redressée — rechargez la liste.`);

    if (ch.mode === 'exercice') {
      if (!e.exerciceDeLaDate) throw new Error(`Aucun exercice ne couvre le ${e.date} (« ${e.description} ») : créez-le avant de redresser.`);
      if (e.exerciceDeLaDate.statut === 'closed') throw new Error(`« ${e.exerciceDeLaDate.label} » est clôturé : on n'y déplace pas d'écriture. Corrigez plutôt la date, ou passez une régularisation.`);
      plans.push({ ecriture: e, mode: 'exercice', date: e.date, fiscalYearId: e.exerciceDeLaDate.id, exercice: e.exerciceDeLaDate.label });
    } else {
      const d = normaliseDate(ch.nouvelleDate);
      if (!d) throw new Error(`Date invalide pour « ${e.description} » : « ${ch.nouvelleDate ?? ''} ». Format attendu AAAA-MM-JJ.`);
      // Corriger la date, c'est garder l'exercice. Si la date proposée tombe
      // ailleurs, ce n'est plus une correction de date mais un déplacement : on
      // le dit au lieu de faire l'un en croyant faire l'autre.
      if (d < e.exercice.debut || d > e.exercice.fin) {
        throw new Error(`Le ${d} est hors de « ${e.exercice.label} » (${e.exercice.debut} → ${e.exercice.fin}) : ce n'est plus une correction de date mais une réaffectation d'exercice. Choisissez l'autre traitement pour « ${e.description} ».`);
      }
      if (e.exercice.statut === 'closed') throw new Error(`« ${e.exercice.label} » est clôturé : la date ne s'y corrige plus.`);
      plans.push({ ecriture: e, mode: 'date', date: d, fiscalYearId: e.exercice.id, exercice: e.exercice.label });
    }
  }
  return plans;
}

export interface ImpactRedressement {
  lignes: { entryId: string; description: string; mode: ModeRedressement; de: string; vers: string; date: string; dateAvant: string; resultat: number }[];
  parExercice: { label: string; delta: number; nb: number }[];
  sansEffetSurLeResultat: number;
  total: number;
}

/** Ce que ça change, exercice par exercice, AVANT de s'engager. */
export async function impactRedressement(
  c: Client, dossierId: string, choix: ChoixRedressement[],
): Promise<ImpactRedressement> {
  const plans = await planifier(c, dossierId, choix);
  const delta = new Map<string, { delta: number; nb: number }>();
  const bouge = (label: string, v: number) => {
    const cur = delta.get(label) ?? { delta: 0, nb: 0 };
    cur.delta = r2(cur.delta + v); cur.nb += 1;
    delta.set(label, cur);
  };

  let sansEffet = 0;
  for (const p of plans) {
    if (p.mode === 'date') {
      // Même exercice : le résultat ne bouge pas d'un franc, seule la date change.
      sansEffet += 1;
      continue;
    }
    bouge(p.ecriture.exercice.label, -p.ecriture.resultat);
    bouge(p.exercice, p.ecriture.resultat);
  }

  return {
    lignes: plans.map((p) => ({
      entryId: p.ecriture.id, description: p.ecriture.description, mode: p.mode,
      de: p.ecriture.exercice.label, vers: p.exercice, date: p.date, dateAvant: p.ecriture.date,
      resultat: p.ecriture.resultat,
    })),
    parExercice: [...delta.entries()].map(([label, v]) => ({ label, delta: v.delta, nb: v.nb }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    sansEffetSurLeResultat: sansEffet,
    total: plans.length,
  };
}

/**
 * Exécute le lot. Tout est validé AVANT la première écriture : une erreur sur la
 * dix-septième ligne ne laisse pas seize redressements à moitié faits. La
 * transaction de l'appelant garantit le tout-ou-rien.
 */
export async function redresserEnMasse(
  c: Client, dossierId: string, choix: ChoixRedressement[], userId?: string,
): Promise<{ traitees: number; brouillons: string[]; extournes: string[] }> {
  const plans = await planifier(c, dossierId, choix);
  const brouillons: string[] = [];
  const extournes: string[] = [];
  for (const p of plans) {
    const r = await redresser(c, dossierId, p.ecriture.id, { fiscalYearId: p.fiscalYearId, date: p.date, label: p.exercice }, userId);
    brouillons.push(r.brouillonId); extournes.push(r.extourneId);
  }
  await recordAudit(c, {
    dossierId, action: 'reclassement.masse', entity: 'entry',
    detail: { traitees: plans.length, modes: plans.map((p) => p.mode), ecritures: plans.map((p) => p.ecriture.id) },
  });
  return { traitees: plans.length, brouillons, extournes };
}

// --- Brouillons --------------------------------------------------------------

export async function listerBrouillons(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select e.id, to_char(e.entry_date,'YYYY-MM-DD') as date, j.code as journal, e.description,
            f.label as exercice, e.fiscal_year_id, f.status as exercice_statut,
            -- Les bornes servent à dire, AVANT validation, si l'exercice choisi
            -- couvre bien la date : c'est le seul moyen de rendre un
            -- rattachement volontaire distinguable d'une erreur.
            to_char(f.start_date,'YYYY-MM-DD') as exercice_debut,
            to_char(f.end_date,'YYYY-MM-DD') as exercice_fin,
            e.created_at,
            coalesce((select sum(amount_debit) from entry_lines where entry_id = e.id), 0) as montant,
            (select json_agg(json_build_object('compte', a.account_code, 'intitule', a.label,
                    'debit', l.amount_debit, 'credit', l.amount_credit, 'libelle', l.label) order by l.line_no)
               from entry_lines l join accounts a on a.id = l.account_id where l.entry_id = e.id) as lignes
       from entries e
       join journals j on j.id = e.journal_id
       left join fiscal_years f on f.id = e.fiscal_year_id
      where e.dossier_id = $1 and e.status = 'draft'
      order by e.created_at desc`, [dossierId]);
  return rows.map((r: any) => ({ ...r, montant: r2(Number(r.montant)), lignes: r.lignes ?? [] }));
}

/**
 * Corrige la DATE et/ou l'EXERCICE d'un brouillon, avant validation.
 *
 * Deux besoins réels, tous deux du ressort du comptable et d'aucune règle :
 *
 *  · La DATE. Une comptabilité tenue en retard se rattrape : on saisit en août
 *    2026 un relevé de mars 2025. Les imports datent souvent la pièce du jour
 *    de l'import, pas de l'opération — c'est même la cause première des
 *    écritures « mal rattachées » que la révision signale ensuite. Corriger la
 *    date à la source vaut mieux que déplacer l'écriture d'exercice en
 *    exercice.
 *
 *  · L'EXERCICE. Le rattachement relève de l'indépendance des exercices, donc
 *    du jugement : une facture du 3 janvier pour une prestation de décembre
 *    appartient à l'exercice précédent.
 *
 * Sans cette main, le comptable n'a que deux choix, tous deux mauvais : valider
 * ce qu'il sait faux, ou supprimer le brouillon et tout ressaisir.
 *
 * Confort assumé : si la date change et que l'exercice attaché ne la couvre
 * plus, on bascule sur l'exercice OUVERT qui la couvre — et on le dit. Sinon il
 * faudrait deux gestes pour une seule correction, et l'oubli du second
 * fabriquerait justement l'anomalie qu'on cherche à supprimer.
 *
 * Garde-fous :
 *   · un exercice CLÔTURÉ reste fermé — on n'y rattache rien, même un brouillon ;
 *   · un exercice qui ne couvre pas la date est accepté mais DIT : l'écriture
 *     ressortira en révision comme mal bornée, et c'est normal.
 */
export interface ModifBrouillon { entryDate?: string; fiscalYearId?: string }

export async function modifierBrouillon(
  c: Client, dossierId: string, entryId: string, modif: ModifBrouillon,
): Promise<{ date: string; exercice: string; couvreLaDate: boolean; exerciceAjuste: boolean }> {
  const { rows } = await c.query(
    "select status, to_char(entry_date,'YYYY-MM-DD') as d, fiscal_year_id from entries where dossier_id=$1 and id=$2",
    [dossierId, entryId]);
  if (!rows[0]) throw new Error('Écriture introuvable.');
  if (rows[0].status !== 'draft') {
    throw new Error('Seul un brouillon se modifie : une écriture comptabilisée est immuable, elle se contre-passe.');
  }

  // Date : normalisée, jamais devinée. Une chaîne qui n'est pas une date est
  // refusée plutôt que silencieusement ignorée.
  let date: string = rows[0].d;
  if (modif.entryDate !== undefined) {
    const n = normaliseDate(modif.entryDate);
    if (!n) throw new Error(`Date invalide : « ${modif.entryDate} ». Format attendu : AAAA-MM-JJ.`);
    date = n;
  }

  const lireExercice = async (id: string) => {
    const { rows: f } = await c.query(
      `select id, label, status, to_char(start_date,'YYYY-MM-DD') as d1, to_char(end_date,'YYYY-MM-DD') as d2
         from fiscal_years where dossier_id=$1 and id=$2`, [dossierId, id]);
    return f[0];
  };

  let fy = await lireExercice(modif.fiscalYearId ?? rows[0].fiscal_year_id);
  if (!fy) throw new Error('Exercice introuvable dans ce dossier.');
  if (modif.fiscalYearId && fy.status === 'closed') {
    throw new Error(`« ${fy.label} » est clôturé : on n'y rattache plus d'écriture. Passez plutôt une régularisation de cut-off dans l'exercice ouvert.`);
  }

  // La date a bougé hors des bornes, et l'exercice n'a pas été imposé : on suit.
  let exerciceAjuste = false;
  if (!modif.fiscalYearId && (date < fy.d1 || date > fy.d2)) {
    const { rows: cible } = await c.query(
      `select id from fiscal_years
        where dossier_id=$1 and status <> 'closed' and $2::date between start_date and end_date
        order by start_date limit 1`, [dossierId, date]);
    if (cible[0] && cible[0].id !== fy.id) { fy = await lireExercice(cible[0].id); exerciceAjuste = true; }
  }

  await c.query(
    'update entries set entry_date=$3, fiscal_year_id=$4 where dossier_id=$1 and id=$2',
    [dossierId, entryId, date, fy.id]);

  const couvreLaDate = date >= fy.d1 && date <= fy.d2;
  await recordAudit(c, {
    dossierId, action: 'entry.draft_amended', entity: 'entry', entityId: entryId,
    detail: { date, exercice: fy.label, couvreLaDate, exerciceAjuste, avant: { date: rows[0].d } },
  });
  return { date, exercice: fy.label, couvreLaDate, exerciceAjuste };
}

export async function validerBrouillon(c: Client, dossierId: string, entryId: string): Promise<void> {
  const { rows } = await c.query(
    "select status from entries where dossier_id=$1 and id=$2", [dossierId, entryId]);
  if (!rows[0]) throw new Error('Écriture introuvable.');
  if (rows[0].status !== 'draft') throw new Error('Cette écriture n\'est pas un brouillon.');
  // Le contrôle d'équilibre et le verrouillage se déclenchent en base au passage
  // en 'posted' : on ne court-circuite rien.
  await c.query("update entries set status='posted' where dossier_id=$1 and id=$2", [dossierId, entryId]);
  await recordAudit(c, { dossierId, action: 'entry.posted_from_draft', entity: 'entry', entityId: entryId, detail: {} });
}

export async function supprimerBrouillon(c: Client, dossierId: string, entryId: string): Promise<void> {
  const { rows } = await c.query("select status from entries where dossier_id=$1 and id=$2", [dossierId, entryId]);
  if (!rows[0]) throw new Error('Écriture introuvable.');
  if (rows[0].status !== 'draft') throw new Error('Seul un brouillon se supprime : une écriture validée se contre-passe.');
  await c.query('delete from entries where dossier_id=$1 and id=$2', [dossierId, entryId]);
  await recordAudit(c, { dossierId, action: 'entry.draft_deleted', entity: 'entry', entityId: entryId, detail: {} });
}
