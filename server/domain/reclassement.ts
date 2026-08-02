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

// Écriture rattachée au mauvais exercice : contre-passation dans l'exercice
// erroné (obligatoire, il est immuable) puis réécriture À L'IDENTIQUE dans le
// bon, en brouillon. Deux exercices sont touchés : rien n'est comptabilisé.
export async function preparerReaffectationExercice(
  c: Client, dossierId: string, entryId: string, userId?: string,
): Promise<{ extourneId: string; brouillonId: string; exercice: string; montant: number }> {
  const { rows } = await c.query(
    `select e.*, to_char(e.entry_date,'YYYY-MM-DD') as d, j.code as jcode, f.label as exercice,
            to_char(f.start_date,'YYYY-MM-DD') as d1, to_char(f.end_date,'YYYY-MM-DD') as d2
       from entries e join journals j on j.id = e.journal_id
       join fiscal_years f on f.id = e.fiscal_year_id
      where e.dossier_id=$1 and e.id=$2`, [dossierId, entryId]);
  const e = rows[0];
  if (!e) throw new Error('Écriture introuvable.');
  if (e.status !== 'posted') throw new Error('Seule une écriture validée se réaffecte : un brouillon se corrige directement.');
  if (e.d >= e.d1 && e.d <= e.d2) throw new Error(`L'écriture est déjà dans les bornes de « ${e.exercice} » : rien à réaffecter.`);

  const { rows: cible } = await c.query(
    'select id, label from fiscal_years where dossier_id=$1 and $2::date between start_date and end_date limit 1',
    [dossierId, e.d]);
  if (!cible[0]) throw new Error(`Aucun exercice ne couvre le ${e.d} : créez-le avant de réaffecter.`);

  const { rows: lignes } = await c.query(
    `select a.account_code, l.amount_debit, l.amount_credit, l.label, l.counterparty_id, l.analytic_axis
       from entry_lines l join accounts a on a.id = l.account_id
      where l.entry_id = $1 order by l.line_no`, [entryId]);

  // La contre-passation reste dans l'exercice erroné : c'est là que l'écriture
  // a été comptabilisée, c'est là qu'elle doit être annulée.
  const { reversalId } = await reverseEntry(c, entryId);

  const { rows: j } = await c.query('select id from journals where dossier_id=$1 and code=$2 limit 1', [dossierId, e.jcode]);
  const { id: brouillonId } = await postEntry(c, {
    dossierId, fiscalYearId: cible[0].id, journalId: j[0]?.id ?? e.journal_id, entryDate: e.d,
    description: `${e.description} (réaffecté depuis « ${e.exercice} »)`,
    source: e.source, status: 'draft', createdBy: userId,
    lines: lignes.map((l: any) => ({
      accountCode: l.account_code,
      debit: Number(l.amount_debit) || undefined,
      credit: Number(l.amount_credit) || undefined,
      label: l.label ?? undefined,
      counterpartyId: l.counterparty_id ?? undefined,
      analyticAxis: l.analytic_axis ?? undefined,
    })),
  });

  const montant = r2(lignes.reduce((s: number, l: any) => s + Number(l.amount_debit), 0));
  await recordAudit(c, {
    dossierId, action: 'reclassement.exercice', entity: 'entry', entityId: entryId,
    detail: { extourneId: reversalId, brouillonId, de: e.exercice, vers: cible[0].label, montant },
  });
  return { extourneId: reversalId, brouillonId, exercice: cible[0].label, montant };
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
