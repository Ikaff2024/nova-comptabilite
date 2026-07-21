import type { Client } from '../db.js';
import { dossierAlerts } from './alerts.js';
import { globalCoherence } from './coherence.js';
import { rhAlerts } from './payrollrh.js';
import { listRequests } from './leave.js';
import { listAssets } from './assets.js';
import { cashForecast } from './forecast.js';
import { fiscalAdvisor } from './fiscaladvisor.js';
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
export interface Insight {
  niveau: Niveau; categorie: string; titre: string; detail?: string;
  montant?: number; echeance?: string; onglet?: string;
}

const RANK: Record<Niveau, number> = { haute: 0, moyenne: 1, info: 2 };
const round = (n: number) => Math.round(Number(n) || 0);

export async function computeDigest(c: Client, dossierId: string, fiscalYearId?: string): Promise<{
  resume: { haute: number; moyenne: number; info: number; total: number }; items: Insight[];
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

  // 5) Point bas de trésorerie projeté.
  await safe(async () => {
    const f: any = await cashForecast(c, dossierId, { horizonWeeks: 13 });
    if (f && Number(f.minBalance) < 0) {
      push({ niveau: 'haute', categorie: 'previsionnel', titre: 'Trésorerie projetée négative', detail: `Le solde projeté devient négatif${f.minWeek ? ` (semaine du ${f.minWeek})` : ''} sur les 13 prochaines semaines.`, montant: round(f.minBalance), onglet: 'previsionnel' });
    }
  });

  items.sort((a, b) => RANK[a.niveau] - RANK[b.niveau] || (a.echeance ?? '').localeCompare(b.echeance ?? ''));
  const resume = {
    haute: items.filter((x) => x.niveau === 'haute').length,
    moyenne: items.filter((x) => x.niveau === 'moyenne').length,
    info: items.filter((x) => x.niveau === 'info').length,
    total: items.length,
  };
  return { resume, items };
}

// Calcule, enregistre, et pousse par email si demandé et si le canal existe.
export async function runForDossier(c: Client, dossierId: string, opts: { notifyTo?: string } = {}): Promise<{
  resume: any; items: Insight[]; notified: string | null;
}> {
  const { resume, items } = await computeDigest(c, dossierId);
  const { rows: dr } = await c.query('select raison_sociale, base_currency from dossiers where id=$1', [dossierId]);
  const nom = dr[0]?.raison_sociale ?? 'votre dossier';
  const cur = dr[0]?.base_currency ?? 'XOF';

  let notified: string | null = null;
  // On n'écrit un email que s'il y a quelque chose à dire : pas de bruit.
  if (opts.notifyTo && emailEnabled() && (resume.haute + resume.moyenne) > 0) {
    try {
      await sendEmail({ to: opts.notifyTo, subject: `Veille Nova — ${nom} : ${resume.haute + resume.moyenne} point(s) à traiter`, html: digestHtml(nom, resume, items, cur) });
      notified = opts.notifyTo;
    } catch { /* l'échec d'envoi ne doit pas perdre le digest */ }
  }

  await c.query(
    'insert into agent_insights(dossier_id, resume, items, notified_to) values ($1,$2::jsonb,$3::jsonb,$4)',
    [dossierId, JSON.stringify(resume), JSON.stringify(items), notified]);
  return { resume, items, notified };
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

export function digestHtml(nom: string, resume: any, items: Insight[], cur: string): string {
  const ligne = (i: Insight) => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap;color:${COLOR[i.niveau]};font-weight:600;font-size:12px">${i.niveau.toUpperCase()}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">
      <div style="font-weight:600;color:#111">${esc(i.titre)}</div>
      ${i.detail ? `<div style="color:#555;font-size:13px">${esc(i.detail)}</div>` : ''}
      ${i.echeance ? `<div style="color:#777;font-size:12px">Échéance : ${esc(i.echeance)}</div>` : ''}
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-family:monospace">${i.montant != null ? `${grp(i.montant)} ${cur}` : ''}</td>
  </tr>`;
  const top = items.filter((i) => i.niveau !== 'info').slice(0, 15);
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#18181b">
    <h2 style="color:#047857;margin:0 0 4px">Veille de Lexa — ${esc(nom)}</h2>
    <p style="color:#555;margin:0 0 14px">${resume.haute} point(s) prioritaire(s), ${resume.moyenne} à surveiller.</p>
    <table style="border-collapse:collapse;width:100%">${top.map(ligne).join('')}</table>
    <p style="color:#888;font-size:12px;margin-top:16px">Analyse automatique produite à partir de votre comptabilité. Lexa signale, elle ne comptabilise rien d'elle-même. Ouvrez Nova pour traiter ces points.</p>
  </div>`;
}
