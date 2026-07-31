import type { Client } from '../db.js';
import { recordAudit } from './audit.js';

// ============================================================================
// RÉMUNÉRATION VARIABLE — tâche et commission — et IMPORT DU POINTAGE.
//
// Deux manques qui tenaient au même défaut : Nova ne savait payer qu'au forfait
// mensuel. Tout le reste se tapait en « prime exceptionnelle », un montant sans
// sa base — donc invérifiable sur le bulletin, et à recalculer à la main chaque
// mois.
//
// Ici, la BASE fait foi et le montant en dérive : quantité × prix unitaire pour
// une tâche, taux × assiette pour une commission. C'est ce qui rend le bulletin
// justifiable, et c'est la seule façon de pouvoir répondre « pourquoi ce
// montant ? » six mois plus tard.
//
// La commission se calcule sur le CA RÉEL tiré de la comptabilité — Nova tient
// les deux, la paie et les livres. Un logiciel de paie seul devrait le ressaisir.
// ============================================================================

const r2 = (n: number) => Math.round(Number(n) * 100) / 100;
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// --- Import du pointage ------------------------------------------------------
// Le pointage se saisissait jour par jour : un mois pour vingt salariés, c'est
// plus de quatre cents saisies. Le module existait donc sans servir.

export interface LignePointage {
  ligne: number; matricule: string; jour: string;
  heuresJour: number; heuresNuit: number; ferie: boolean;
  employeeId?: string; nom?: string; erreur?: string;
}

export interface AnalysePointage {
  lignes: LignePointage[];
  valides: number; rejetees: number; remplacees: number;
  totalHeures: number;
  periode: { debut: string; fin: string } | null;
}

// Colonnes acceptées, dans l'ordre : matricule ; date ; heures jour ; heures
// nuit ; férié. Le séparateur est deviné — un export Excel francophone sort en
// point-virgule, un export anglo-saxon en virgule.
export function parsePointageCsv(csv: string): LignePointage[] {
  const lignes = String(csv ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (!lignes.length) return [];
  const sep = (lignes[0].match(/;/g)?.length ?? 0) >= (lignes[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const entete = /matricule/i.test(lignes[0]) ? 1 : 0;

  return lignes.slice(entete).map((l, i) => {
    const ch = l.split(sep).map((x) => x.trim().replace(/^"|"$/g, ''));
    const jour = normaliseJour(ch[1] ?? '');
    const ferie = /^(1|oui|o|true|vrai|x)$/i.test(ch[4] ?? '');
    return {
      ligne: i + 1 + entete,
      matricule: ch[0] ?? '',
      jour,
      heuresJour: num((ch[2] ?? '').replace(',', '.')),
      heuresNuit: num((ch[3] ?? '').replace(',', '.')),
      ferie,
    };
  });
}

// Accepte AAAA-MM-JJ et JJ/MM/AAAA : les deux circulent, et refuser la seconde
// ferait buter l'utilisateur sur son propre export.
function normaliseJour(v: string): string {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

export async function analyserPointage(c: Client, dossierId: string, csv: string): Promise<AnalysePointage> {
  const brut = parsePointageCsv(csv);
  const { rows: emps } = await c.query(
    'select id, matricule, nom, prenoms from payroll_employees where dossier_id=$1', [dossierId]);
  const parMatricule = new Map(emps.map((e: any) => [String(e.matricule).toLowerCase().trim(), e]));

  // Les couples déjà présents seront REMPLACÉS, pas ajoutés : réimporter un mois
  // corrigé ne doit pas doubler les heures.
  const { rows: existants } = await c.query(
    "select employee_id, to_char(jour,'YYYY-MM-DD') as jour from payroll_time_entries where dossier_id=$1", [dossierId]);
  const deja = new Set(existants.map((r: any) => `${r.employee_id}|${r.jour}`));

  const vus = new Set<string>();
  const lignes = brut.map((l) => {
    const e = parMatricule.get(l.matricule.toLowerCase());
    if (!l.matricule) return { ...l, erreur: 'matricule absent' };
    if (!e) return { ...l, erreur: `matricule « ${l.matricule} » inconnu` };
    if (!l.jour) return { ...l, erreur: 'date illisible (attendu AAAA-MM-JJ ou JJ/MM/AAAA)' };
    if (l.heuresJour < 0 || l.heuresNuit < 0) return { ...l, erreur: 'heures négatives' };
    if (l.heuresJour + l.heuresNuit > 24) return { ...l, erreur: `${l.heuresJour + l.heuresNuit} h sur une journée` };
    if (l.heuresJour + l.heuresNuit === 0) return { ...l, erreur: 'aucune heure' };
    const k = `${e.id}|${l.jour}`;
    if (vus.has(k)) return { ...l, erreur: 'ligne en double dans le fichier' };
    vus.add(k);
    return { ...l, employeeId: e.id, nom: `${e.nom} ${e.prenoms}`.trim() };
  });

  const valides = lignes.filter((l) => !l.erreur);
  const jours = valides.map((l) => l.jour).sort();
  return {
    lignes,
    valides: valides.length,
    rejetees: lignes.length - valides.length,
    remplacees: valides.filter((l) => deja.has(`${l.employeeId}|${l.jour}`)).length,
    totalHeures: r2(valides.reduce((s, l) => s + l.heuresJour + l.heuresNuit, 0)),
    periode: jours.length ? { debut: jours[0], fin: jours[jours.length - 1] } : null,
  };
}

export async function importerPointage(
  c: Client, dossierId: string, csv: string, userId?: string,
): Promise<{ importees: number; remplacees: number; rejetees: number }> {
  const a = await analyserPointage(c, dossierId, csv);
  const valides = a.lignes.filter((l) => !l.erreur && l.employeeId);
  if (!valides.length) throw new Error("Aucune ligne exploitable : vérifiez les matricules et les dates.");

  for (const l of valides) {
    await c.query(
      `insert into payroll_time_entries(dossier_id, employee_id, jour, heures_jour, heures_nuit, ferie)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (dossier_id, employee_id, jour)
       do update set heures_jour=$4, heures_nuit=$5, ferie=$6`,
      [dossierId, l.employeeId, l.jour, l.heuresJour, l.heuresNuit, l.ferie]);
  }
  await recordAudit(c, {
    dossierId, action: 'payroll.pointage_imported', entity: 'payroll_time_entries',
    detail: { importees: valides.length, remplacees: a.remplacees, rejetees: a.rejetees, periode: a.periode },
  });
  return { importees: valides.length, remplacees: a.remplacees, rejetees: a.rejetees };
}

// --- Chiffre d'affaires d'un vendeur ----------------------------------------
// Net des avoirs : un avoir annule la vente, donc la commission qu'elle a
// portée. Le lien avoir → facture d'origine n'existe qu'au niveau du document,
// c'est pourquoi le vendeur est porté par la facture et non par l'écriture.

export interface CaVendeur {
  total: number;
  base: 'facture' | 'encaisse';
  factures: { id: string; numero: string; date: string; client: string | null; montant: number; sens: 'facture' | 'avoir' }[];
}

export async function caDuVendeur(
  c: Client, dossierId: string, employeeId: string,
  from: string, to: string, base: 'facture' | 'encaisse' = 'facture',
): Promise<CaVendeur> {
  // CA facturé : toute facture émise sur la période. CA encaissé : seules
  // celles réglées. Les deux se pratiquent — la seconde protège la trésorerie,
  // puisqu'on ne commissionne pas sur un impayé.
  const filtreStatut = base === 'encaisse' ? "and i.status = 'paid'" : "and i.status <> 'draft'";
  const { rows } = await c.query(
    `select i.id, i.number as numero, to_char(i.invoice_date,'YYYY-MM-DD') as date,
            cp.name as client, i.doc_type, coalesce(i.total_ht, 0) as montant
       from invoices i
       left join counterparties cp on cp.id = i.counterparty_id
      where i.dossier_id = $1 and i.vendeur_id = $2
        and i.invoice_date between $3::date and $4::date ${filtreStatut}
        -- Un DEVIS n'est pas du chiffre d'affaires : il n'engage personne et
        -- peut ne jamais devenir une vente. Une facture annulée non plus.
        and i.doc_type in ('invoice', 'credit_note')
        and i.status <> 'cancelled'
      order by i.invoice_date, i.number`,
    [dossierId, employeeId, from, to]);

  const factures = rows.map((r: any) => {
    const avoir = r.doc_type === 'credit_note';
    return {
      id: r.id, numero: r.numero, date: r.date, client: r.client,
      montant: r2(avoir ? -Math.abs(Number(r.montant)) : Number(r.montant)),
      sens: (avoir ? 'avoir' : 'facture') as 'facture' | 'avoir',
    };
  });
  return { total: r2(factures.reduce((s, f) => s + f.montant, 0)), base, factures };
}

// --- Éléments variables du mois ---------------------------------------------

export interface ElementVariableInput {
  employeeId: string; annee: number; mois: number; // mois 0-11
  type: 'tache' | 'commission';
  libelle: string;
  quantite?: number; prixUnitaire?: number;
  taux?: number; baseCa?: 'facture' | 'encaisse';
  periodeDebut?: string; periodeFin?: string;
  note?: string;
}

export async function listerElements(c: Client, dossierId: string, annee: number, mois: number): Promise<any[]> {
  const { rows } = await c.query(
    `select v.*, e.nom, e.prenoms, e.matricule
       from payroll_variable_pay v
       join payroll_employees e on e.id = v.employee_id
      where v.dossier_id=$1 and v.period_year=$2 and v.period_month=$3
      order by e.nom, v.created_at`, [dossierId, annee, mois]);
  return rows.map((r: any) => ({
    id: r.id, employeeId: r.employee_id, salarie: `${r.nom} ${r.prenoms}`.trim(), matricule: r.matricule,
    type: r.type, libelle: r.libelle,
    quantite: r.quantite == null ? null : Number(r.quantite),
    prixUnitaire: r.prix_unitaire == null ? null : Number(r.prix_unitaire),
    taux: r.taux == null ? null : Number(r.taux),
    assiette: r.assiette == null ? null : Number(r.assiette),
    baseCa: r.base_ca ?? undefined,
    periodeDebut: r.periode_debut ?? undefined, periodeFin: r.periode_fin ?? undefined,
    montant: Number(r.montant), note: r.note,
    // La base lisible : c'est elle qui justifie le montant sur le bulletin.
    justification: r.type === 'tache'
      ? `${Number(r.quantite)} × ${Number(r.prix_unitaire)}`
      : `${Number(r.taux)} % de ${Number(r.assiette ?? 0)}`,
  }));
}

export async function ajouterElement(
  c: Client, dossierId: string, input: ElementVariableInput, userId?: string,
): Promise<{ id: string; montant: number; assiette?: number }> {
  if (!input.libelle?.trim()) throw new Error('Libellé requis : sans lui, la ligne est inexploitable sur un bulletin.');
  if (!input.employeeId) throw new Error('Salarié requis.');
  const mois = Number(input.mois);
  if (!(mois >= 0 && mois <= 11)) throw new Error('Mois invalide (0 = janvier).');

  let montant = 0, assiette: number | null = null;

  if (input.type === 'tache') {
    const q = num(input.quantite), pu = num(input.prixUnitaire);
    if (!(q > 0)) throw new Error('Quantité requise et strictement positive.');
    if (!(pu > 0)) throw new Error('Prix unitaire requis et strictement positif.');
    montant = r2(q * pu);
  } else {
    const taux = num(input.taux);
    if (!(taux > 0)) throw new Error('Taux de commission requis et strictement positif.');
    if (taux > 100) throw new Error(`Taux de ${taux} % : au-delà de 100 %, la commission dépasserait le chiffre d'affaires.`);
    const debut = input.periodeDebut, fin = input.periodeFin;
    if (!debut || !fin) throw new Error('Période de référence requise pour une commission (début et fin).');
    const ca = await caDuVendeur(c, dossierId, input.employeeId, debut, fin, input.baseCa ?? 'facture');
    assiette = ca.total;
    montant = r2((ca.total * taux) / 100);
    if (montant < 0) throw new Error(`Chiffre d'affaires net négatif sur la période (${ca.total}) : les avoirs dépassent les factures. À vérifier avant de commissionner.`);
  }

  const { rows } = await c.query(
    `insert into payroll_variable_pay(dossier_id, employee_id, period_year, period_month, type, libelle,
       quantite, prix_unitaire, taux, assiette, base_ca, periode_debut, periode_fin, montant, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [dossierId, input.employeeId, Number(input.annee), mois, input.type, input.libelle.trim(),
     input.type === 'tache' ? num(input.quantite) : null,
     input.type === 'tache' ? num(input.prixUnitaire) : null,
     input.type === 'commission' ? num(input.taux) : null,
     assiette, input.type === 'commission' ? (input.baseCa ?? 'facture') : null,
     input.periodeDebut ?? null, input.periodeFin ?? null,
     montant, input.note ?? null, userId ?? null]);

  await recordAudit(c, {
    dossierId, action: 'payroll.variable_added', entity: 'payroll_variable_pay', entityId: rows[0].id,
    detail: { type: input.type, libelle: input.libelle, montant, assiette },
  });
  return { id: rows[0].id, montant, assiette: assiette ?? undefined };
}

export async function supprimerElement(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from payroll_variable_pay where dossier_id=$1 and id=$2', [dossierId, id]);
}

/** Total par salarié pour un mois — ce que la paie doit ajouter au brut. */
export async function variableParSalarie(
  c: Client, dossierId: string, annee: number, mois: number,
): Promise<Map<string, { total: number; detail: { type: string; libelle: string; montant: number; justification: string }[] }>> {
  const out = new Map<string, { total: number; detail: any[] }>();
  const { rows } = await c.query(
    `select employee_id, type, libelle, montant, quantite, prix_unitaire, taux, assiette
       from payroll_variable_pay where dossier_id=$1 and period_year=$2 and period_month=$3`,
    [dossierId, annee, mois]);
  for (const r of rows) {
    const e = out.get(r.employee_id) ?? { total: 0, detail: [] };
    e.total = r2(e.total + Number(r.montant));
    e.detail.push({
      type: r.type, libelle: r.libelle, montant: Number(r.montant),
      justification: r.type === 'tache'
        ? `${Number(r.quantite)} × ${Number(r.prix_unitaire)}`
        : `${Number(r.taux)} % de ${Number(r.assiette ?? 0)}`,
    });
    out.set(r.employee_id, e);
  }
  return out;
}
