import type { Client } from '../db.js';
import { listAssets } from './assets.js';

// ============================================================================
// Travaux de fin d'exercice / clôture — MOTEUR DÉTERMINISTE de contrôle du
// grand livre. Analyse l'existant et renvoie une CHECKLIST de points à traiter
// (constat + action recommandée + éventuel outil d'exécution). Lexa s'en sert
// pour proposer un PLAN étape par étape, obtenir l'accord, puis exécuter les
// actions gatées. Aucune écriture ici — pur diagnostic.
// ============================================================================

export type TaskStatus = 'a_faire' | 'attention' | 'ok';
export interface ClotureTask {
  id: string;
  titre: string;
  statut: TaskStatus;
  detail: string;
  montant?: number;
  action?: string;        // ce qu'il faut faire
  outil?: string;         // outil Lexa d'exécution (si automatisable), sinon onglet
}

const r0 = (n: number) => Math.round(n);

export async function clotureChecklist(c: Client, dossierId: string, fiscalYearId?: string): Promise<{ exercice: string | null; resultatProvisoire: number; taches: ClotureTask[]; aFaire: number }> {
  // Exercice de référence (ouvert le plus récent si non fourni).
  let fyId = fiscalYearId ?? null; let fyLabel: string | null = null;
  const { rows: fys } = await c.query("select id, label, status from fiscal_years where dossier_id=$1 order by start_date desc", [dossierId]);
  if (!fyId) { const open = fys.find((f: any) => f.status !== 'closed') ?? fys[0]; fyId = open?.id ?? null; fyLabel = open?.label ?? null; }
  else fyLabel = fys.find((f: any) => f.id === fyId)?.label ?? null;

  const taches: ClotureTask[] = [];
  const fyFilter = fyId ? 'and e.fiscal_year_id = $2' : '';
  const fyParams = fyId ? [dossierId, fyId] : [dossierId];

  // 1) Écritures en brouillon (non validées → hors grand livre).
  const { rows: dr } = await c.query(
    `select count(*)::int as n from entries e where e.dossier_id=$1 ${fyFilter} and e.status='draft'`, fyParams);
  const drafts = dr[0]?.n ?? 0;
  taches.push(drafts > 0
    ? { id: 'brouillons', titre: 'Écritures en brouillon', statut: 'a_faire', detail: `${drafts} écriture(s) en brouillon ne sont pas au grand livre.`, action: 'Valider ou supprimer ces brouillons avant la clôture.', outil: 'onglet Saisie' }
    : { id: 'brouillons', titre: 'Écritures en brouillon', statut: 'ok', detail: 'Aucun brouillon en attente.' });

  // 2) Dotations aux amortissements dues.
  try {
    const assets = await listAssets(c, dossierId);
    const dueAssets = assets.filter((a: any) => a.pending > 0);
    const totalDue = r0(dueAssets.reduce((s: number, a: any) => s + (a.pendingAmount ?? 0), 0));
    const countDue = dueAssets.reduce((s: number, a: any) => s + a.pending, 0);
    taches.push(countDue > 0
      ? { id: 'dotations', titre: 'Dotations aux amortissements', statut: 'a_faire', detail: `${countDue} dotation(s) dues sur ${dueAssets.length} immobilisation(s).`, montant: totalDue, action: 'Comptabiliser les dotations dues (681 → 28x).', outil: 'comptabiliser_dotations_dues' }
      : { id: 'dotations', titre: 'Dotations aux amortissements', statut: 'ok', detail: 'Toutes les dotations dues sont comptabilisées.' });
  } catch { /* module immobilisations indisponible */ }

  // 3) Comptes d'attente (47x) non soldés.
  const { rows: att } = await c.query(
    `select coalesce(sum(l.amount_debit - l.amount_credit),0) as solde, count(distinct a.account_code) as n
       from entry_lines l
       join entries e on e.id=l.entry_id and e.status='posted' ${fyFilter}
       join accounts a on a.id=l.account_id and a.account_code like '47%'
      where l.dossier_id=$1`, fyParams);
  const soldeAttente = r0(Number(att[0]?.solde ?? 0));
  taches.push(Math.abs(soldeAttente) > 0.5
    ? { id: 'attente', titre: "Comptes d'attente (47x)", statut: 'attention', detail: `Solde non nul sur les comptes d'attente (${att[0]?.n} compte(s)).`, montant: soldeAttente, action: 'Solder/régulariser les comptes 47x avant clôture.', outil: 'onglet Saisie' }
    : { id: 'attente', titre: "Comptes d'attente (47x)", statut: 'ok', detail: 'Comptes d\'attente soldés.' });

  // 4) Caisse (57x) créditrice — anomalie (une caisse ne peut être négative).
  const { rows: caisse } = await c.query(
    `select coalesce(sum(l.amount_debit - l.amount_credit),0) as solde
       from entry_lines l join entries e on e.id=l.entry_id and e.status='posted'
       join accounts a on a.id=l.account_id and a.account_code like '57%'
      where l.dossier_id=$1`, [dossierId]);
  const soldeCaisse = r0(Number(caisse[0]?.solde ?? 0));
  if (soldeCaisse < 0) taches.push({ id: 'caisse', titre: 'Caisse créditrice', statut: 'attention', detail: 'La caisse (57x) présente un solde créditeur, ce qui est impossible.', montant: soldeCaisse, action: 'Vérifier les mouvements de caisse (décaissements non justifiés, erreurs de saisie).', outil: 'onglet Grand livre' });

  // 5) TVA à régulariser / déclarer (443 collectée vs 445 déductible).
  const { rows: tva } = await c.query(
    `select
       coalesce(sum(l.amount_credit - l.amount_debit) filter (where a.account_code like '443%'),0) as collectee,
       coalesce(sum(l.amount_debit - l.amount_credit) filter (where a.account_code like '445%'),0) as deductible
       from entry_lines l join entries e on e.id=l.entry_id and e.status='posted' ${fyFilter}
       join accounts a on a.id=l.account_id and (a.account_code like '443%' or a.account_code like '445%')
      where l.dossier_id=$1`, fyParams);
  const tvaNet = r0(Number(tva[0]?.collectee ?? 0) - Number(tva[0]?.deductible ?? 0));
  if (Math.abs(tvaNet) > 0.5) taches.push({ id: 'tva', titre: 'TVA à régulariser', statut: 'attention', detail: tvaNet > 0 ? 'TVA nette à décaisser (collectée > déductible).' : 'Crédit de TVA (déductible > collectée) à reporter.', montant: tvaNet, action: 'Établir la déclaration de TVA et solder les comptes 443/445.', outil: 'onglet Fiscalité' });

  // 6) Créances/dettes anciennes non lettrées (+90 j) — dépréciation à envisager.
  const { rows: old } = await c.query(
    `select
       coalesce(sum(net) filter (where kind='client'),0) as creances,
       coalesce(sum(net) filter (where kind='fournisseur'),0) as dettes
     from (
       select (case when a.account_code like '41%' then 'client' else 'fournisseur' end) as kind,
              abs(l.amount_debit - l.amount_credit) as net,
              (current_date - coalesce(l.operation_date, e.entry_date)) as age
         from entry_lines l
         join entries e on e.id=l.entry_id and e.status='posted'
         join accounts a on a.id=l.account_id and (a.account_code like '41%' or a.account_code like '40%')
        where l.dossier_id=$1 and l.counterparty_id is not null
          and not exists (select 1 from lettrage_lines ll where ll.entry_line_id=l.id)
     ) x where age > 90`, [dossierId]);
  const vieilles = r0(Number(old[0]?.creances ?? 0));
  if (vieilles > 0.5) taches.push({ id: 'creances_agees', titre: 'Créances anciennes (+90 j)', statut: 'attention', detail: 'Des créances clients de plus de 90 jours restent non lettrées.', montant: vieilles, action: 'Relancer, lettrer les règlements reçus, et provisionner les créances douteuses (491).', outil: 'onglet Tiers' });

  // Résultat provisoire (produits classe 7 - charges classe 6).
  const { rows: res } = await c.query(
    `select coalesce(sum((l.amount_credit - l.amount_debit)) filter (where a.class_no=7),0) as produits,
            coalesce(sum((l.amount_debit - l.amount_credit)) filter (where a.class_no=6),0) as charges
       from entry_lines l join entries e on e.id=l.entry_id and e.status='posted' ${fyFilter}
       join accounts a on a.id=l.account_id and a.class_no in (6,7)
      where l.dossier_id=$1`, fyParams);
  const resultatProvisoire = r0(Number(res[0]?.produits ?? 0) - Number(res[0]?.charges ?? 0));

  const aFaire = taches.filter((t) => t.statut !== 'ok').length;
  return { exercice: fyLabel, resultatProvisoire, taches, aFaire };
}
