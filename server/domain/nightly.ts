import type { Client } from '../db.js';
import { dossierAlerts } from './alerts.js';
import { globalCoherence } from './coherence.js';
import { rhAlerts } from './payrollrh.js';
import { listRequests } from './leave.js';
import { listAssets } from './assets.js';
import { cashForecast } from './forecast.js';
import { fiscalAdvisor } from './fiscaladvisor.js';
import { behaviorSignals } from './behavior.js';
import { anomaliesExercices } from './accounting.js';
import { sendEmail, emailEnabled } from '../email/provider.js';

// ============================================================================
// Veille nocturne de Lexa. Recompose, de façon DÉTERMINISTE, ce qui mérite
// l'attention du dirigeant : elle réutilise les moteurs existants plutôt que de
// réinventer des règles (alertes du dossier, cohérence inter-modules AQM,
// dotations dues, alertes légales RH, point bas de trésorerie).
//
// Elle ALERTE, elle n'agit pas : aucune écriture comptable n'est produite ici.
// ============================================================================

export type Niveau = 'haute' | 'moyenne' | 'info';
export type Etat = 'nouveau' | 'aggrave' | 'ameliore' | 'stable' | 'resolu';

export interface Insight {
  niveau: Niveau; categorie: string; titre: string; detail?: string;
  montant?: number; echeance?: string; onglet?: string;
  /** Comparé au digest précédent — c'est ce qui distingue une alerte à lire
   *  d'une alerte déjà vue hier. Sans ça, le même mail chaque matin finit
   *  filtré, et les points qui bougent vraiment se noient avec le reste. */
  etat?: Etat;
  /** Variation du montant depuis le digest précédent. */
  variation?: number;
  /** Ce qui explique le montant, CALCULÉ depuis les données — jamais deviné. */
  causes?: { libelle: string; montant: number }[];
}

/** Fiabilité des chiffres : un digest calculé sur une comptabilité douteuse doit
 *  le dire, sinon il donne à des montants faux l'autorité du chiffre précis. */
export interface Fiabilite { fiable: boolean; motifs: string[] }

const RANK: Record<Niveau, number> = { haute: 0, moyenne: 1, info: 2 };
const round = (n: number) => Math.round(Number(n) || 0);

// Clé d'identité d'un signal entre deux jours. Les nombres du titre sont
// neutralisés : « 3 demande(s) de congés à valider » et « 4 demande(s)… » sont
// le même point qui a bougé, pas deux points différents.
const cle = (i: { categorie: string; titre: string }) =>
  `${i.categorie}|${i.titre.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()}`;

// Compare le digest du jour au précédent. Un montant qui s'aggrave n'est pas
// une nouvelle alerte, et un point disparu mérite d'être annoncé : c'est la
// seule preuve visible que traiter les alertes sert à quelque chose.
export function comparer(items: Insight[], precedents: Insight[]): { items: Insight[]; resolus: Insight[] } {
  const avant = new Map(precedents.map((p) => [cle(p), p]));
  const pire = (i: Insight, p: Insight) => {
    // « Pire » se lit selon le sens du montant : une trésorerie qui descend et
    // une dette qui monte s'aggravent toutes deux, en s'éloignant de zéro.
    if (i.montant == null || p.montant == null) return 0;
    return Math.abs(i.montant) - Math.abs(p.montant);
  };
  const sortie = items.map((i) => {
    const p = avant.get(cle(i));
    if (!p) return { ...i, etat: 'nouveau' as Etat };
    const d = pire(i, p);
    const variation = i.montant != null && p.montant != null ? round(i.montant - p.montant) : undefined;
    if (Math.abs(d) < 0.5) return { ...i, etat: 'stable' as Etat, variation };
    return { ...i, etat: (d > 0 ? 'aggrave' : 'ameliore') as Etat, variation };
  });
  const encore = new Set(items.map(cle));
  const resolus = precedents.filter((p) => !encore.has(cle(p))).map((p) => ({ ...p, etat: 'resolu' as Etat }));
  return { items: sortie, resolus };
}

// Les chiffres qui suivent valent ce que vaut la comptabilité qui les porte.
// Une écriture rattachée au mauvais exercice, un exercice mal borné, et toute
// lecture filtrée par exercice devient trompeuse — sans que rien ne l'indique.
// Le digest le dit avant d'annoncer des montants au franc près.
async function verifierFiabilite(c: Client, dossierId: string): Promise<Fiabilite> {
  const motifs: string[] = [];
  try {
    const an = await anomaliesExercices(c, dossierId);
    for (const d of an.dureesAnormales) motifs.push(`l'exercice « ${d.exercice} » couvre ${d.mois} mois`);
    for (const x of an.chevauchements) motifs.push(`« ${x.a} » et « ${x.b} » se chevauchent`);
    for (const h of an.ecrituresHorsBornes) {
      motifs.push(`${h.nb} écriture(s) rattachée(s) à « ${h.exercice} » sont datées hors de ses bornes`);
    }
  } catch { /* la fiabilité ne doit jamais empêcher le digest */ }
  return { fiable: motifs.length === 0, motifs };
}

export async function computeDigest(c: Client, dossierId: string, fiscalYearId?: string): Promise<{
  resume: { haute: number; moyenne: number; info: number; total: number };
  items: Insight[]; fiabilite: Fiabilite;
}> {
  const items: Insight[] = [];
  const push = (i: Insight) => items.push(i);
  // Chaque source est isolée : un moteur indisponible ne doit pas priver le
  // dirigeant des autres signaux.
  const safe = async (fn: () => Promise<void>) => { try { await fn(); } catch { /* source ignorée */ } };

  // 1) Alertes du dossier (trésorerie, créances, TVA, brouillons, échéances).
  await safe(async () => {
    const a: any = await dossierAlerts(c, dossierId, fiscalYearId);
    for (const x of a.alertes ?? []) push({ niveau: x.niveau, categorie: x.categorie, titre: x.titre, detail: x.detail, montant: x.montant, echeance: x.echeance, onglet: x.onglet });
  });

  // 2) Cohérence inter-modules (AQM 2.0) — incohérences réelles seulement.
  await safe(async () => {
    const co: any = await globalCoherence(c, dossierId, fiscalYearId);
    for (const chk of co.controles ?? []) {
      if (chk.niveau === 'ok') continue;
      push({ niveau: chk.niveau === 'info' ? 'info' : chk.niveau, categorie: 'coherence', titre: chk.libelle, detail: chk.explication, montant: chk.ecart || undefined, onglet: 'revision' });
    }
  });

  // 3) Dotations aux amortissements dues.
  await safe(async () => {
    const assets: any[] = await listAssets(c, dossierId);
    const due = round(assets.reduce((s, a) => s + (a.status === 'disposed' ? 0 : Number(a.pendingAmount) || 0), 0));
    if (due > 0) push({ niveau: 'moyenne', categorie: 'immobilisations', titre: 'Dotations aux amortissements à comptabiliser', detail: 'Des dotations sont dues à ce jour et ne sont pas encore passées.', montant: due, onglet: 'immos' });
  });

  // 4) Alertes légales RH (fins de CDD, fins de période d'essai).
  await safe(async () => {
    const rh: any = await rhAlerts(c, dossierId);
    for (const a of rh.alertes ?? []) push({ niveau: a.niveau, categorie: 'rh', titre: a.categorie, detail: a.message, echeance: a.date, onglet: 'paie' });
  });

  // 4b) Demandes de congés en attente de validation.
  await safe(async () => {
    const att = (await listRequests(c, dossierId, 'en_attente')) as any[];
    if (att.length > 0) push({ niveau: 'moyenne', categorie: 'rh', titre: `${att.length} demande(s) de congés à valider`, detail: att.slice(0, 3).map((d) => `${d.nom} ${d.prenoms} (${d.jours} j)`).join(', '), onglet: 'paie' });
  });

  // 4c) Conseils fiscaux marquants (vigilance uniquement, pas d'info).
  await safe(async () => {
    const fa: any = await fiscalAdvisor(c, dossierId, fiscalYearId);
    for (const co of fa.conseils ?? []) { if (co.niveau === 'info') continue; push({ niveau: co.niveau, categorie: 'fiscal', titre: co.titre, detail: co.detail, montant: co.montant, onglet: 'fiscalite' }); }
  });

  // 4d) Détection comportementale (écarts aux habitudes).
  await safe(async () => {
    const b: any = await behaviorSignals(c, dossierId);
    for (const s of b.signaux ?? []) push({ niveau: s.niveau, categorie: 'habitude', titre: s.titre, detail: s.detail, onglet: 'saisie' });
  });

  // 5) Point bas de trésorerie projeté, avec ce qui le creuse.
  await safe(async () => {
    const f: any = await cashForecast(c, dossierId, { horizonWeeks: 13 });
    if (f && Number(f.minBalance) < 0) {
      // Les causes sont EXTRAITES des flux projetés — les trois plus gros
      // décaissements attendus d'ici le point bas. On ne les devine pas : une
      // cause plausible mais fausse, envoyée chaque matin, coûte plus cher que
      // pas de cause du tout.
      const causes = (f.events ?? [])
        .filter((e: any) => Number(e.amount) < 0 && (!f.minWeek || e.date <= f.minWeek))
        .sort((a: any, b: any) => Number(a.amount) - Number(b.amount))
        .slice(0, 3)
        .map((e: any) => ({ libelle: String(e.label ?? '').slice(0, 60), montant: round(e.amount) }));
      push({
        niveau: 'haute', categorie: 'previsionnel', titre: 'Trésorerie projetée négative',
        detail: `Le solde projeté devient négatif${f.minWeek ? ` (semaine du ${f.minWeek})` : ''} sur les 13 prochaines semaines.`,
        montant: round(f.minBalance), onglet: 'previsionnel',
        causes: causes.length ? causes : undefined,
      });
    }
  });

  // 6) Fiabilité de l'assiette. Signalée en tête, et comme point à traiter :
  // tant qu'elle n'est pas rétablie, les montants ci-dessus restent indicatifs.
  const fiabilite = await verifierFiabilite(c, dossierId);
  if (!fiabilite.fiable) {
    push({
      niveau: 'haute', categorie: 'fiabilite', titre: 'Comptabilité à fiabiliser avant de lire les montants',
      detail: `${fiabilite.motifs[0]}${fiabilite.motifs.length > 1 ? `, et ${fiabilite.motifs.length - 1} autre(s) point(s)` : ''}. Les chiffres de cette veille en dépendent.`,
      onglet: 'revision',
    });
  }

  items.sort((a, b) => RANK[a.niveau] - RANK[b.niveau] || (a.echeance ?? '').localeCompare(b.echeance ?? ''));
  const resume = {
    haute: items.filter((x) => x.niveau === 'haute').length,
    moyenne: items.filter((x) => x.niveau === 'moyenne').length,
    info: items.filter((x) => x.niveau === 'info').length,
    total: items.length,
  };
  return { resume, items, fiabilite };
}

// L'objet doit porter le risque, pas son décompte. « 5 points à traiter » ne
// dit rien ; « trésorerie à -735 683 » fait ouvrir le message.
function objet(nom: string, items: Insight[], resume: any, cur: string): string {
  const majeur = items.find((i) => i.niveau === 'haute') ?? items[0];
  if (!majeur) return `Veille Nova — ${nom}`;
  const chiffre = majeur.montant != null ? ` ${grp(majeur.montant)} ${cur}` : '';
  const reste = resume.haute + resume.moyenne - 1;
  return `Nova — ${majeur.titre}${chiffre}${reste > 0 ? ` (+${reste} autre${reste > 1 ? 's' : ''})` : ''} — ${nom}`;
}

// Faut-il écrire ce matin ? Un mail identique à celui d'hier n'est pas lu : il
// apprend au destinataire à ne plus ouvrir les suivants. On n'écrit donc que
// lorsque quelque chose a BOUGÉ — ou une fois par semaine, pour que le silence
// ne se confonde pas avec une panne.
export function doitEnvoyer(items: Insight[], resolus: Insight[], jour = new Date()): { envoyer: boolean; motif: string } {
  const aTraiter = items.filter((i) => i.niveau !== 'info');
  if (aTraiter.length === 0 && resolus.length === 0) return { envoyer: false, motif: 'rien à signaler' };
  const bouge = aTraiter.filter((i) => i.etat === 'nouveau' || i.etat === 'aggrave');
  if (bouge.length > 0) return { envoyer: true, motif: `${bouge.length} point(s) nouveau(x) ou aggravé(s)` };
  if (resolus.length > 0) return { envoyer: true, motif: `${resolus.length} point(s) résolu(s)` };
  if (jour.getDay() === 1) return { envoyer: true, motif: 'récapitulatif hebdomadaire' };
  return { envoyer: false, motif: 'situation inchangée depuis hier' };
}

// Calcule, compare au précédent, enregistre, et n'écrit que si ça vaut la peine.
export async function runForDossier(c: Client, dossierId: string, opts: { notifyTo?: string; forcerEnvoi?: boolean } = {}): Promise<{
  resume: any; items: Insight[]; resolus: Insight[]; fiabilite: Fiabilite; notified: string | null; motif: string;
}> {
  const brut = await computeDigest(c, dossierId);
  const precedent = await latestDigest(c, dossierId);
  const { items, resolus } = comparer(brut.items, (precedent?.items as Insight[]) ?? []);
  const { resume, fiabilite } = brut;

  const { rows: dr } = await c.query('select raison_sociale, base_currency from dossiers where id=$1', [dossierId]);
  const nom = dr[0]?.raison_sociale ?? 'votre dossier';
  const cur = dr[0]?.base_currency ?? 'XOF';

  const decision = doitEnvoyer(items, resolus);
  let notified: string | null = null;
  if (opts.notifyTo && emailEnabled() && (decision.envoyer || opts.forcerEnvoi)) {
    try {
      await sendEmail({
        to: opts.notifyTo, subject: objet(nom, items, resume, cur),
        html: digestHtml(nom, resume, items, cur, { resolus, fiabilite }),
      });
      notified = opts.notifyTo;
    } catch { /* l'échec d'envoi ne doit pas perdre le digest */ }
  }

  await c.query(
    'insert into agent_insights(dossier_id, resume, items, notified_to) values ($1,$2::jsonb,$3::jsonb,$4)',
    [dossierId, JSON.stringify(resume), JSON.stringify(items), notified]);
  return { resume, items, resolus, fiabilite, notified, motif: decision.motif };
}

export async function latestDigest(c: Client, dossierId: string): Promise<any | null> {
  const { rows } = await c.query(
    `select to_char(generated_at,'YYYY-MM-DD"T"HH24:MI:SS') as generated_at, resume, items, notified_to
       from agent_insights where dossier_id=$1 order by generated_at desc limit 1`, [dossierId]);
  return rows[0] ?? null;
}

export async function setEnabled(c: Client, dossierId: string, enabled: boolean): Promise<void> {
  await c.query('update dossiers set nightly_digest=$2 where id=$1', [dossierId, !!enabled]);
}

export async function isEnabled(c: Client, dossierId: string): Promise<boolean> {
  const { rows } = await c.query('select coalesce(nightly_digest,false) as e from dossiers where id=$1', [dossierId]);
  return !!rows[0]?.e;
}

const esc = (s: string) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch] as string));
const grp = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const COLOR: Record<Niveau, string> = { haute: '#e11d48', moyenne: '#b45309', info: '#0369a1' };

// Ce que l'état vaut à l'œil : c'est la première chose que le lecteur cherche
// après trois jours d'abonnement — « qu'est-ce qui a changé depuis hier ».
const ETAT_LIB: Record<Etat, { texte: string; couleur: string }> = {
  nouveau: { texte: 'NOUVEAU', couleur: '#b91c1c' },
  aggrave: { texte: 'AGGRAVÉ', couleur: '#c2410c' },
  ameliore: { texte: 'EN AMÉLIORATION', couleur: '#047857' },
  stable: { texte: 'déjà signalé', couleur: '#71717a' },
  resolu: { texte: 'RÉSOLU', couleur: '#047857' },
};

export function digestHtml(
  nom: string, resume: any, items: Insight[], cur: string,
  extra: { resolus?: Insight[]; fiabilite?: Fiabilite } = {},
): string {
  const montant = (n?: number) => (n != null ? `${grp(n)} ${cur}` : '');
  const badge = (i: Insight) => {
    if (!i.etat) return '';
    const e = ETAT_LIB[i.etat];
    const delta = i.variation && Math.abs(i.variation) > 0.5
      ? ` de ${grp(Math.abs(i.variation))} ${cur}` : '';
    return `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:9px;background:${e.couleur}1a;color:${e.couleur};font-size:11px;font-weight:600">${e.texte}${i.etat === 'aggrave' || i.etat === 'ameliore' ? delta : ''}</span>`;
  };
  const ligne = (i: Insight) => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap;color:${COLOR[i.niveau]};font-weight:600;font-size:12px;vertical-align:top">${i.niveau.toUpperCase()}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">
      <div style="font-weight:600;color:#111">${esc(i.titre)}${badge(i)}</div>
      ${i.detail ? `<div style="color:#555;font-size:13px">${esc(i.detail)}</div>` : ''}
      ${i.echeance ? `<div style="color:#777;font-size:12px">Échéance : ${esc(i.echeance)}</div>` : ''}
      ${i.causes?.length ? `<div style="color:#777;font-size:12px;margin-top:3px">Ce qui pèse le plus : ${i.causes.map((x) => `${esc(x.libelle)} (${montant(x.montant)})`).join(' · ')}</div>` : ''}
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-family:monospace;vertical-align:top">${montant(i.montant)}</td>
  </tr>`;

  const top = items.filter((i) => i.niveau !== 'info').slice(0, 15);
  const nouveaux = top.filter((i) => i.etat === 'nouveau' || i.etat === 'aggrave').length;
  const resolus = extra.resolus ?? [];
  const f = extra.fiabilite;

  // Le bandeau de fiabilité passe AVANT les chiffres : annoncer un point bas au
  // franc près sur une comptabilité douteuse, c'est prêter à des montants faux
  // l'autorité de la précision.
  const bandeau = f && !f.fiable
    ? `<div style="border:1px solid #fbbf24;background:#fffbeb;border-radius:8px;padding:10px 12px;margin:0 0 14px">
         <div style="font-weight:600;color:#92400e">Chiffres à prendre avec réserve</div>
         <div style="color:#92400e;font-size:13px">${esc(f.motifs.slice(0, 3).join(' ; '))}. Les montants ci-dessous en dépendent — à fiabiliser dans l'onglet Révision.</div>
       </div>` : '';

  const blocResolus = resolus.length
    ? `<p style="color:#047857;font-size:13px;margin-top:14px">Réglé depuis hier : ${resolus.slice(0, 5).map((r) => esc(r.titre)).join(' · ')}${resolus.length > 5 ? ` (+${resolus.length - 5})` : ''}.</p>`
    : '';

  const chapeau = nouveaux > 0
    ? `${nouveaux} point(s) nouveau(x) ou aggravé(s) depuis hier, sur ${resume.haute} prioritaire(s) et ${resume.moyenne} à surveiller.`
    : `Rien de nouveau depuis hier : ${resume.haute} point(s) prioritaire(s) et ${resume.moyenne} à surveiller, déjà signalés.`;

  const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#18181b">
    <h2 style="color:#047857;margin:0 0 4px">Veille de Lexa — ${esc(nom)}</h2>
    <p style="color:#555;margin:0 0 14px">${chapeau}</p>
    ${bandeau}
    <table style="border-collapse:collapse;width:100%">${top.map(ligne).join('')}</table>
    ${blocResolus}
    <p style="color:#888;font-size:12px;margin-top:16px">Analyse produite le ${date} à partir des écritures comptabilisées. Lexa signale, elle ne comptabilise rien d'elle-même. Ouvrez Nova pour traiter ces points.</p>
  </div>`;
}
