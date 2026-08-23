import type { Client } from '../db.js';
import { recordAudit } from './audit.js';
import { createAxe, createSection, listAxes, resolveAxe } from './analytic.js';

// ============================================================================
// ASSISTANT DE MISE EN PLACE ANALYTIQUE.
//
// Créer une comptabilité analytique à la main, c'est vingt formulaires et une
// notion à comprendre avant de commencer (axe ≠ section). Le vrai risque n'est
// pas la lenteur : c'est que le module reste VIDE. On crée les sections, on ne
// ventile jamais, et six mois plus tard le résultat analytique n'existe pas.
//
// D'où trois temps : proposer une structure, la créer d'un coup, puis ventiler
// l'existant. Le troisième est le seul qui décide de la réussite.
//
// UNE CONTRAINTE GOUVERNE TOUT LE RESTE.
//
// Les lignes d'une écriture comptabilisée sont IMMUABLES (trigger
// `protect_posted_lines`). `entry_lines.analytic_axis` — l'axe principal — vit
// à l'intérieur du grand livre : on ne peut donc PAS le renseigner après coup.
// Ventiler l'historique sur l'axe principal supposerait de contre-passer et de
// réécrire chaque écriture ; personne ne fait cela pour de l'information de
// gestion.
//
// Les axes SECONDAIRES, eux, vivent dans une table de jointure qui n'appartient
// pas au grand livre. Ils se ventilent rétroactivement sans toucher à une seule
// écriture. C'est ce qui rend la structure multi-axes utile bien au-delà du
// confort : c'est le seul chemin praticable pour un dossier déjà tenu.
//
// COMMENT LES SUGGESTIONS SONT FAITES.
//
// Nova ne devine pas. Deux mécanismes, tous deux explicables :
//   · une RÈGLE que l'utilisateur écrit (« tout le compte 706 → SERVICES »),
//     dont l'effet exact est chiffré avant d'être appliqué ;
//   · un APPRENTISSAGE du dossier lui-même : quand des lignes comparables sont
//     déjà ventilées, la section majoritaire est proposée, avec le nombre de
//     précédents qui la soutiennent. Jamais un modèle, jamais une intuition.
// ============================================================================

const r2 = (n: number) => Math.round(n * 100) / 100;

// --- 1) Modèles par activité -------------------------------------------------

export interface ModeleSection { code: string; label: string }
export interface ModeleAxe {
  code: string; label: string;
  /** Vide quand les sections sont propres à l'entreprise (chantiers, véhicules). */
  sections: ModeleSection[];
  aide: string;
}
export interface ModeleActivite {
  cle: string; label: string; description: string; axes: ModeleAxe[];
}

// Les sections ne sont proposées que lorsqu'elles sont GÉNÉRIQUES. Inventer des
// noms de chantiers ou d'agences donnerait une structure d'apparence complète
// qu'il faudrait entièrement refaire — pire que de la laisser à remplir.
export const MODELES: ModeleActivite[] = [
  {
    cle: 'commerce', label: 'Commerce / distribution',
    description: 'Plusieurs points de vente, avec du négoce et parfois du service.',
    axes: [
      { code: 'PDV', label: 'Point de vente', sections: [], aide: 'Une section par boutique ou dépôt : Cocody, Yopougon, Bouaké…' },
      { code: 'ACTIVITE', label: 'Activité', aide: "Ce que l'on vend, indépendamment du lieu.", sections: [
        { code: 'NEGOCE', label: 'Négoce de marchandises' },
        { code: 'SERVICES', label: 'Prestations de services' },
      ] },
    ],
  },
  {
    cle: 'btp', label: 'BTP / travaux',
    description: 'Le résultat se joue chantier par chantier.',
    axes: [
      { code: 'CHANTIER', label: 'Chantier', sections: [], aide: 'Une section par chantier. À créer au fur et à mesure des marchés.' },
      { code: 'NATURE', label: 'Nature des travaux', aide: 'Pour comparer les métiers entre eux.', sections: [
        { code: 'GROSOEUVRE', label: 'Gros œuvre' },
        { code: 'SECONDOEUVRE', label: 'Second œuvre' },
        { code: 'ETUDES', label: 'Études et maîtrise d’œuvre' },
      ] },
    ],
  },
  {
    cle: 'services', label: 'Services / conseil',
    description: 'La rentabilité se mesure par mission ou par client.',
    axes: [
      { code: 'MISSION', label: 'Mission', sections: [], aide: 'Une section par mission ou par contrat significatif.' },
      { code: 'POLE', label: 'Pôle', aide: 'Les départements qui portent les missions.', sections: [
        { code: 'CONSEIL', label: 'Conseil' },
        { code: 'FORMATION', label: 'Formation' },
        { code: 'SUPPORT', label: 'Support et maintenance' },
      ] },
    ],
  },
  {
    cle: 'transport', label: 'Transport / logistique',
    description: 'Le coût se suit véhicule par véhicule.',
    axes: [
      { code: 'VEHICULE', label: 'Véhicule', sections: [], aide: 'Une section par véhicule, nommée par son immatriculation.' },
      { code: 'LIGNE', label: 'Ligne / destination', sections: [], aide: 'Les trajets réguliers, si vous en avez.' },
    ],
  },
  {
    cle: 'agro', label: 'Agriculture / agro-industrie',
    description: 'Les cycles ne suivent pas l’exercice comptable.',
    axes: [
      { code: 'CAMPAGNE', label: 'Campagne', sections: [], aide: 'Une section par campagne : 2025-2026, 2026-2027…' },
      { code: 'PRODUIT', label: 'Produit', sections: [], aide: 'Cacao, hévéa, anacarde… selon vos filières.' },
    ],
  },
  {
    cle: 'general', label: 'Structure simple',
    description: 'Un seul découpage, par activité. Le plus courant.',
    axes: [
      { code: 'ACTIVITE', label: 'Activité', sections: [], aide: 'Vos grandes activités, telles que vous les pilotez.' },
    ],
  },
];

export function modelesActivite(): ModeleActivite[] { return MODELES; }

// --- 2) Création en une passe ------------------------------------------------

export interface AxeAcreer { code: string; label: string; sections: ModeleSection[] }

/**
 * Crée axes et sections en une fois. IDEMPOTENT : ce qui existe déjà est
 * ignoré, pas dupliqué ni écrasé — on doit pouvoir relancer l'assistant sans
 * craindre de casser ce qui a été ajusté à la main.
 *
 * Le premier axe demandé prend la place de l'axe PRINCIPAL s'il est encore
 * vierge : c'est le seul moment où on peut le nommer utilement, puisqu'il est
 * créé d'office à l'ouverture du dossier.
 */
export async function appliquerModele(
  c: Client, dossierId: string, axes: AxeAcreer[], userId?: string,
): Promise<{ axesCrees: string[]; sectionsCreees: string[]; ignores: string[]; principalRenomme: string | null }> {
  if (!axes?.length) throw new Error('Aucun axe à créer.');
  const existants = await listAxes(c, dossierId);
  const principal = existants.find((a) => a.isPrimary);

  const axesCrees: string[] = [];
  const sectionsCreees: string[] = [];
  const ignores: string[] = [];
  let principalRenomme: string | null = null;

  for (const [i, a] of axes.entries()) {
    const code = String(a.code ?? '').trim().toUpperCase();
    const label = String(a.label ?? '').trim();
    if (!code || !label) throw new Error('Chaque axe doit avoir un code et un intitulé.');

    let axeCode = code;
    const deja = existants.find((x) => x.code === code);
    if (deja) {
      ignores.push(`axe ${code} (déjà présent)`);
    } else if (i === 0 && principal && principal.sections === 0) {
      // L'axe principal existe mais n'a jamais servi : on le nomme au lieu d'en
      // créer un de plus, sinon le dossier garde un « Section analytique » vide
      // à côté du vrai découpage.
      await c.query('update analytic_axes set code=$3, label=$4 where dossier_id=$1 and id=$2',
        [dossierId, principal.id, code, label]);
      principalRenomme = code;
      axesCrees.push(code);
    } else {
      await createAxe(c, dossierId, code, label);
      axesCrees.push(code);
    }

    for (const s of a.sections ?? []) {
      const sc = String(s.code ?? '').trim().toUpperCase();
      if (!sc || !s.label?.trim()) continue;
      try {
        await createSection(c, dossierId, sc, s.label.trim(), axeCode);
        sectionsCreees.push(sc);
      } catch (e: any) {
        // On n'avale QUE le doublon — c'est le cas normal quand on rejoue
        // l'assistant. Toute autre erreur (axe introuvable, intitulé vide)
        // doit remonter : la déguiser en « déjà présente » ferait croire à
        // une structure complète alors qu'il y manque des sections.
        if (!/existe déjà/i.test(String(e?.message ?? ''))) throw e;
        ignores.push(`section ${sc} (déjà présente)`);
      }
    }
  }

  await recordAudit(c, {
    dossierId, action: 'analytique.modele_applique', entity: 'analytic_axes',
    detail: { axesCrees, sectionsCreees, ignores, principalRenomme, par: userId ?? null },
  });
  return { axesCrees, sectionsCreees, ignores, principalRenomme };
}

// --- 3) État de la ventilation ----------------------------------------------

export interface EtatVentilation {
  axe: { id: string; code: string; label: string; isPrimary: boolean };
  ventilables: number;      // lignes de gestion (classes 6/7) de la période
  ventilees: number;
  nonVentilees: number;
  montantNonVentile: number;
  /** L'axe principal ne se ventile pas après coup : le grand livre est immuable. */
  retroactif: boolean;
  message: string;
}

export async function etatVentilation(
  c: Client, dossierId: string, axis?: string, fiscalYearId?: string,
): Promise<EtatVentilation> {
  const a = await resolveAxe(c, dossierId, axis);
  const params: any[] = [dossierId, a.id];
  let filtre = '';
  if (fiscalYearId) { params.push(fiscalYearId); filtre = ` and e.fiscal_year_id = $${params.length}`; }

  const { rows } = await c.query(
    `select count(*)::int as total,
            count(*) filter (where ${a.isPrimary ? "coalesce(l.analytic_axis,'') <> ''" : 'ela.entry_line_id is not null'})::int as ventilees,
            coalesce(sum(l.amount_credit - l.amount_debit)
                     filter (where ${a.isPrimary ? "coalesce(l.analytic_axis,'') = ''" : 'ela.entry_line_id is null'}), 0) as montant
       from entry_lines l
       join entries e on e.id = l.entry_id and e.status = 'posted'
       join accounts acc on acc.id = l.account_id and acc.class_no in (6,7)
       left join entry_line_analytics ela on ela.entry_line_id = l.id and ela.axis_id = $2
      where l.dossier_id = $1${filtre}`, params);

  const total = Number(rows[0]?.total ?? 0);
  const ventilees = Number(rows[0]?.ventilees ?? 0);
  return {
    axe: { id: a.id, code: a.code, label: a.label, isPrimary: a.isPrimary },
    ventilables: total, ventilees, nonVentilees: total - ventilees,
    montantNonVentile: r2(Number(rows[0]?.montant ?? 0)),
    retroactif: !a.isPrimary,
    message: a.isPrimary
      ? "L'axe principal est inscrit dans l'écriture elle-même, et une écriture comptabilisée est immuable : il ne se ventile qu'à la saisie. Pour rattraper l'historique, utilisez un axe secondaire."
      : "Cet axe vit hors du grand livre : il se ventile rétroactivement, sans modifier aucune écriture.",
  };
}

// --- 4) Règle → aperçu → application ----------------------------------------

export interface RegleVentilation {
  axe: string;
  section: string;
  /** Préfixes de comptes (ex. « 706 » prend 706, 7061…). */
  comptes?: string[];
  /** Identifiants de tiers. */
  tiers?: string[];
  /** Codes journaux. */
  journaux?: string[];
}

function clauseRegle(regle: RegleVentilation, params: any[], axeId: string, fiscalYearId?: string): string {
  params.push(axeId);
  let w = `l.dossier_id = $1 and e.status = 'posted' and acc.class_no in (6,7)
           and ela.entry_line_id is null`;
  if (fiscalYearId) { params.push(fiscalYearId); w += ` and e.fiscal_year_id = $${params.length}`; }
  const ors: string[] = [];
  if (regle.comptes?.length) {
    params.push(regle.comptes.map((x) => String(x).trim()).filter(Boolean));
    ors.push(`exists (select 1 from unnest($${params.length}::text[]) p where acc.account_code like p || '%')`);
  }
  if (regle.tiers?.length) { params.push(regle.tiers); ors.push(`l.counterparty_id = any($${params.length}::uuid[])`); }
  if (regle.journaux?.length) { params.push(regle.journaux); ors.push(`j.code = any($${params.length}::text[])`); }
  if (!ors.length) throw new Error('Une règle doit porter sur au moins un compte, un tiers ou un journal — sinon elle ventilerait tout.');
  return `${w} and (${ors.join(' or ')})`;
}

export interface ApercuVentilation {
  nb: number; montant: number;
  exemples: { date: string; compte: string; libelle: string; montant: number }[];
}

export async function apercuVentilation(
  c: Client, dossierId: string, regle: RegleVentilation, fiscalYearId?: string,
): Promise<ApercuVentilation> {
  const a = await resolveAxe(c, dossierId, regle.axe);
  if (a.isPrimary) throw new Error("L'axe principal ne se ventile pas après coup : les écritures comptabilisées sont immuables. Choisissez un axe secondaire.");
  const params: any[] = [dossierId];
  const where = clauseRegle(regle, params, a.id, fiscalYearId);

  const { rows } = await c.query(
    `select count(*)::int as nb, coalesce(sum(l.amount_credit - l.amount_debit), 0) as montant
       from entry_lines l
       join entries e on e.id = l.entry_id
       join journals j on j.id = e.journal_id
       join accounts acc on acc.id = l.account_id
       left join entry_line_analytics ela on ela.entry_line_id = l.id and ela.axis_id = $2
      where ${where}`, params);

  const { rows: ex } = await c.query(
    `select to_char(e.entry_date,'YYYY-MM-DD') as date, acc.account_code as compte,
            coalesce(l.label, e.description) as libelle,
            (l.amount_credit - l.amount_debit) as montant
       from entry_lines l
       join entries e on e.id = l.entry_id
       join journals j on j.id = e.journal_id
       join accounts acc on acc.id = l.account_id
       left join entry_line_analytics ela on ela.entry_line_id = l.id and ela.axis_id = $2
      where ${where}
      order by e.entry_date desc limit 8`, params);

  return {
    nb: Number(rows[0]?.nb ?? 0), montant: r2(Number(rows[0]?.montant ?? 0)),
    exemples: ex.map((r: any) => ({ date: r.date, compte: r.compte, libelle: r.libelle, montant: r2(Number(r.montant)) })),
  };
}

export async function appliquerVentilation(
  c: Client, dossierId: string, regle: RegleVentilation, fiscalYearId?: string,
): Promise<{ ventilees: number }> {
  const a = await resolveAxe(c, dossierId, regle.axe);
  if (a.isPrimary) throw new Error("L'axe principal ne se ventile pas après coup : les écritures comptabilisées sont immuables. Choisissez un axe secondaire.");
  const { rows: s } = await c.query(
    'select id, code from analytic_sections where dossier_id=$1 and axis_id=$2 and code=$3',
    [dossierId, a.id, String(regle.section ?? '').trim().toUpperCase()]);
  if (!s[0]) throw new Error(`La section « ${regle.section} » n'appartient pas à l'axe ${a.code}.`);

  const params: any[] = [dossierId];
  const where = clauseRegle(regle, params, a.id, fiscalYearId);
  params.push(s[0].id);

  const { rowCount } = await c.query(
    `insert into entry_line_analytics (entry_line_id, dossier_id, axis_id, section_id)
     select l.id, l.dossier_id, $2, $${params.length}
       from entry_lines l
       join entries e on e.id = l.entry_id
       join journals j on j.id = e.journal_id
       join accounts acc on acc.id = l.account_id
       left join entry_line_analytics ela on ela.entry_line_id = l.id and ela.axis_id = $2
      where ${where}
     on conflict (entry_line_id, axis_id) do nothing`, params);

  await recordAudit(c, {
    dossierId, action: 'analytique.ventilation_masse', entity: 'entry_line_analytics',
    detail: { axe: a.code, section: s[0].code, lignes: rowCount ?? 0, regle },
  });
  return { ventilees: rowCount ?? 0 };
}

// --- 5) Suggestions apprises du dossier lui-même ----------------------------

export interface SuggestionVentilation {
  compte: string; intitule: string;
  section: string; sectionLabel: string;
  precedents: number;       // lignes comparables déjà ventilées ainsi
  concernees: number;       // lignes non ventilées que la règle toucherait
  confiance: number;        // part du majoritaire parmi les précédents (0-1)
}

/**
 * Pour chaque compte encore non ventilé, la section MAJORITAIRE parmi les
 * lignes du même compte déjà ventilées. Ce n'est pas une intuition : c'est la
 * pratique du dossier, et le nombre de précédents est rendu avec la
 * proposition pour que l'utilisateur juge sur pièce.
 *
 * Rien n'est proposé sans au moins deux précédents et une majorité franche —
 * une seule occurrence ne fait pas une habitude.
 */
export async function suggestionsVentilation(
  c: Client, dossierId: string, axis: string, fiscalYearId?: string,
): Promise<SuggestionVentilation[]> {
  const a = await resolveAxe(c, dossierId, axis);
  if (a.isPrimary) return [];
  const params: any[] = [dossierId, a.id];
  let filtre = '';
  if (fiscalYearId) { params.push(fiscalYearId); filtre = ` and e.fiscal_year_id = $${params.length}`; }

  const { rows } = await c.query(
    `with lignes as (
       select acc.account_code, acc.label as intitule, ela.section_id, l.id as line_id
         from entry_lines l
         join entries e on e.id = l.entry_id and e.status = 'posted'
         join accounts acc on acc.id = l.account_id and acc.class_no in (6,7)
         left join entry_line_analytics ela on ela.entry_line_id = l.id and ela.axis_id = $2
        where l.dossier_id = $1${filtre}
     ),
     connues as (
       select account_code, section_id, count(*)::int as n
         from lignes where section_id is not null
        group by account_code, section_id
     ),
     majoritaire as (
       select distinct on (account_code) account_code, section_id, n,
              (select sum(n) from connues c2 where c2.account_code = connues.account_code)::int as total
         from connues order by account_code, n desc
     ),
     restantes as (
       select account_code, max(intitule) as intitule, count(*)::int as nb
         from lignes where section_id is null group by account_code
     )
     select r.account_code, r.intitule, r.nb as concernees,
            m.n as precedents, m.total, s.code as section, s.label as section_label
       from restantes r
       join majoritaire m on m.account_code = r.account_code
       join analytic_sections s on s.id = m.section_id
      where m.n >= 2 and m.n::numeric / m.total >= 0.7
      order by r.nb desc`, params);

  return rows.map((r: any) => ({
    compte: r.account_code, intitule: r.intitule ?? '',
    section: r.section, sectionLabel: r.section_label,
    precedents: Number(r.precedents), concernees: Number(r.concernees),
    confiance: r2(Number(r.precedents) / Number(r.total)),
  }));
}
