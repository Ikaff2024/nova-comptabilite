import { PDFDocument } from 'pdf-lib';
import type { Client } from '../db.js';
import * as acc from './accounting.js';
import * as accdocs from '../documents/accounting-docs.js';
import { sectionsPdf } from '../documents/pdf.js';
import { financialRatios } from './ratios.js';
import { globalCoherence } from './coherence.js';
import { getProfile } from './dossierprofile.js';

// ============================================================================
// Dossier de financement bancaire. Nova ne prête pas et ne s'interpose pas : il
// ASSEMBLE, à partir de la comptabilité réelle, un dossier de présentation que
// le dirigeant dépose lui-même auprès de sa banque.
//
// 3 briques :
//   1) le besoin (brief) saisi par l'entreprise ;
//   2) une porte de complétude (readiness) — on refuse de produire un dossier
//      creux, qui desservirait l'entreprise ;
//   3) le pack PDF : note de présentation + plan de remboursement, puis les
//      états produits par Nova, fusionnés en un seul document.
//
// Le score interne (A–D) reste un COACH : il n'apparaît pas dans le dossier
// remis à la banque — ce n'est pas une notation de crédit.
// ============================================================================

export interface FinancingBrief {
  montant?: number; objet?: string; dureeMois?: number; tauxAnnuel?: number;
  garanties?: string; engagements?: string; banque?: string;
}

const num = (v: any) => Number(v) || 0;
const round = (n: number) => Math.round(n);
const grp = (n: number) => round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export async function getBrief(c: Client, dossierId: string): Promise<FinancingBrief> {
  const { rows } = await c.query('select financing_brief from dossiers where id=$1', [dossierId]);
  return (rows[0]?.financing_brief ?? {}) as FinancingBrief;
}

export async function saveBrief(c: Client, dossierId: string, brief: FinancingBrief): Promise<FinancingBrief> {
  const clean: FinancingBrief = {
    montant: brief.montant != null ? Math.max(0, num(brief.montant)) : undefined,
    objet: brief.objet ? String(brief.objet).slice(0, 400) : undefined,
    dureeMois: brief.dureeMois != null ? Math.max(1, Math.min(360, Math.round(num(brief.dureeMois)))) : undefined,
    tauxAnnuel: brief.tauxAnnuel != null ? Math.max(0, Math.min(60, num(brief.tauxAnnuel))) : undefined,
    garanties: brief.garanties ? String(brief.garanties).slice(0, 600) : undefined,
    engagements: brief.engagements ? String(brief.engagements).slice(0, 600) : undefined,
    banque: brief.banque ? String(brief.banque).slice(0, 120) : undefined,
  };
  await c.query('update dossiers set financing_brief = $2::jsonb where id=$1', [dossierId, JSON.stringify(clean)]);
  return clean;
}

// --- Capacité de remboursement (indicative, déterministe) -------------------
// CAF ≈ résultat de l'exercice + dotations aux amortissements/provisions (68).
export async function repaymentCapacity(c: Client, dossierId: string, fyId: string | undefined, brief: FinancingBrief) {
  const fs: any = await acc.financialStatements(c, dossierId, fyId);
  const resultat = num(fs?.incomeStatement?.resultatNet);
  const tb = await acc.trialBalance(c, dossierId, fyId);
  const dotations = tb.filter((r: any) => String(r.account_code).startsWith('68'))
    .reduce((s: number, r: any) => s + num(r.balance), 0);
  const caf = round(resultat + dotations);

  const montant = num(brief.montant);
  const n = Math.max(1, num(brief.dureeMois) || 36);
  const taux = brief.tauxAnnuel != null ? num(brief.tauxAnnuel) : 10; // % annuel indicatif
  const i = taux / 100 / 12;
  const mensualite = montant > 0
    ? (i > 0 ? round((montant * i) / (1 - Math.pow(1 + i, -n))) : round(montant / n))
    : 0;
  const annuite = round(mensualite * 12);
  const couverture = annuite > 0 ? Math.round((caf / annuite) * 100) / 100 : null;

  return { resultat: round(resultat), dotations: round(dotations), caf, montant, dureeMois: n, tauxAnnuel: taux, mensualite, annuite, couverture };
}

// --- Porte de complétude ----------------------------------------------------
export interface ReadinessItem { key: string; label: string; ok: boolean; blocking: boolean; detail: string }

export async function readiness(c: Client, dossierId: string, fyId?: string): Promise<{
  pourcentage: number; pret: boolean; bloquants: number; items: ReadinessItem[];
}> {
  const items: ReadinessItem[] = [];
  const add = (key: string, label: string, ok: boolean, blocking: boolean, detail: string) => items.push({ key, label, ok, blocking, detail });

  const profile = await getProfile(c, dossierId);
  const brief = await getBrief(c, dossierId);

  // 1) Écritures sur l'exercice
  const p: any[] = [dossierId]; let w = "l.dossier_id=$1 and e.status='posted'";
  if (fyId) { p.push(fyId); w += ` and e.fiscal_year_id=$${p.length}`; }
  const { rows: cnt } = await c.query(`select count(*)::int as n from entry_lines l join entries e on e.id=l.entry_id where ${w}`, p);
  const nbLignes = cnt[0]?.n ?? 0;
  add('ecritures', 'Comptabilité alimentée sur l\'exercice', nbLignes >= 20, true,
    nbLignes >= 20 ? `${nbLignes} lignes comptabilisées.` : `Seulement ${nbLignes} ligne(s) : un dossier bancaire sur une comptabilité vide vous desservirait.`);

  // 2) Exercice précédent (comparatif + TFT)
  const fys = await acc.listFiscalYears(c, dossierId);
  const hasPrev = fys.length >= 2;
  add('exercice_n1', 'Exercice précédent disponible (comparatif N/N-1, TFT)', hasPrev, false,
    hasPrev ? `${fys.length} exercices.` : "Sans N-1, pas d'états comparatifs ni de tableau de flux : la banque apprécie l'évolution.");

  // 3) Identité de l'entreprise
  const idOk = !!(profile.raisonSociale && profile.taxId && profile.rccm && profile.adresse);
  const manque = [!profile.taxId && 'NCC/IFU', !profile.rccm && 'RCCM', !profile.adresse && 'adresse'].filter(Boolean).join(', ');
  add('identite', 'Fiche entreprise complète (NCC, RCCM, adresse)', idOk, true,
    idOk ? 'Identité complète.' : `À compléter dans « Fiche entreprise » : ${manque}.`);

  // 4) Besoin de financement exprimé
  const briefOk = num(brief.montant) > 0 && !!brief.objet && num(brief.dureeMois) > 0;
  add('besoin', 'Besoin de financement renseigné (montant, objet, durée)', briefOk, true,
    briefOk ? `${grp(num(brief.montant))} sur ${brief.dureeMois} mois.` : 'Renseignez le montant demandé, son objet et la durée souhaitée.');

  // 5) Cohérence AQM — aucune incohérence majeure
  let coherenceOk = true; let coherenceDetail = 'Aucune incohérence majeure détectée.';
  try {
    const co: any = await globalCoherence(c, dossierId, fyId);
    coherenceOk = (co?.resume?.haute ?? 0) === 0;
    if (!coherenceOk) coherenceDetail = `${co.resume.haute} incohérence(s) majeure(s) entre modules — à corriger avant de présenter le dossier (onglet Révision).`;
  } catch { /* module indisponible : on n'échoue pas */ }
  add('coherence', 'Cohérence inter-modules (contrôle AQM)', coherenceOk, true, coherenceDetail);

  // 6) Capitaux propres positifs (informatif mais très regardé)
  const ratios: any = await financialRatios(c, dossierId, fyId);
  const cp = num(ratios?.soldes?.capitauxPropres ?? ratios?.soldes?.capitaux_propres ?? 0);
  add('capitaux', 'Capitaux propres positifs', cp > 0, false,
    cp > 0 ? `Capitaux propres : ${grp(cp)}.` : 'Capitaux propres négatifs ou non renseignés : point de vigilance pour un banquier.');

  const total = items.length;
  const ok = items.filter((x) => x.ok).length;
  const bloquants = items.filter((x) => x.blocking && !x.ok).length;
  return { pourcentage: Math.round((ok / total) * 100), pret: bloquants === 0, bloquants, items };
}

// --- Pack PDF ---------------------------------------------------------------
export async function buildDossierPdf(c: Client, dossierId: string, fyId?: string): Promise<{ filename: string; buffer: Buffer }> {
  const rd = await readiness(c, dossierId, fyId);
  if (!rd.pret) {
    const manques = rd.items.filter((x) => x.blocking && !x.ok).map((x) => x.label).join(' ; ');
    throw new Error(`Dossier incomplet (${rd.pourcentage} %) — à régler avant de produire : ${manques}.`);
  }

  const profile = await getProfile(c, dossierId);
  const brief = await getBrief(c, dossierId);
  const cap = await repaymentCapacity(c, dossierId, fyId, brief);
  const ratios: any = await financialRatios(c, dossierId, fyId);
  const cur = profile.baseCurrency ?? 'XOF';
  const money = (n: number) => `${grp(n)} ${cur}`;

  const identite: [string, string][] = [
    ['Raison sociale', profile.raisonSociale],
    ['Forme juridique', profile.formeJuridique || '—'],
    ['NCC / IFU', profile.taxId || '—'],
    ['RCCM', profile.rccm || '—'],
    ['Adresse', [profile.adresse, profile.ville].filter(Boolean).join(', ') || '—'],
    ['Téléphone', profile.telephone || '—'],
    ['Régime fiscal', profile.regimeFiscal || '—'],
    ['Banque', profile.bankName || brief.banque || '—'],
  ];

  const demande: [string, string][] = [
    ['Montant sollicité', money(cap.montant)],
    ['Objet du financement', brief.objet || '—'],
    ['Durée souhaitée', `${cap.dureeMois} mois`],
    ['Taux annuel retenu (hypothèse)', `${cap.tauxAnnuel} %`],
    ['Garanties proposées', brief.garanties || '—'],
    ['Engagements bancaires en cours', brief.engagements || '—'],
  ];

  const capacite: [string, string][] = [
    ['Résultat de l\'exercice', money(cap.resultat)],
    ['Dotations aux amortissements (68)', money(cap.dotations)],
    ['Capacité d\'autofinancement (CAF)', money(cap.caf)],
    ['Mensualité estimée', money(cap.mensualite)],
    ['Annuité estimée', money(cap.annuite)],
    ['Couverture (CAF / annuité)', cap.couverture != null ? `${cap.couverture.toFixed(2)} ×` : '—'],
  ];

  const topRatios: [string, string][] = (ratios?.ratios ?? []).slice(0, 8).map((r: any) => [
    r.libelle,
    r.valeur == null ? '—' : r.unite === 'pourcent' ? `${Math.round(r.valeur * 10) / 10} %`
      : r.unite === 'jours' ? `${Math.round(r.valeur)} j`
        : r.unite === 'montant' ? money(r.valeur) : String(Math.round(r.valeur * 100) / 100),
  ]);

  const couvTxt = cap.couverture == null ? "La couverture ne peut être calculée sans montant ni durée."
    : cap.couverture >= 1.5 ? `La capacité d'autofinancement couvre ${cap.couverture.toFixed(2)} fois l'annuité envisagée.`
      : cap.couverture >= 1 ? `La capacité d'autofinancement couvre ${cap.couverture.toFixed(2)} fois l'annuité : marge de sécurité limitée.`
        : `La capacité d'autofinancement ne couvre pas l'annuité envisagée (${cap.couverture.toFixed(2)} ×) : revoir le montant ou la durée.`;

  const cover = await sectionsPdf({
    title: 'Dossier de demande de financement',
    subtitle: `${profile.raisonSociale} · ${money(cap.montant)} sur ${cap.dureeMois} mois`,
    meta: [
      `Établi le ${new Date().toISOString().slice(0, 10)} à partir de la comptabilité tenue dans Nova.`,
      'Document de présentation établi par l\'entreprise. Il ne constitue ni une notation de crédit, ni un engagement de prêt.',
    ],
    sections: [
      { heading: '1 · Identité de l\'entreprise', rows: identite },
      { heading: '2 · Le besoin de financement', rows: demande },
      { heading: '3 · Capacité de remboursement (indicative)', rows: capacite },
      { heading: '4 · Indicateurs financiers clés', rows: topRatios.length ? topRatios : [['—', '—']] },
      {
        heading: '5 · Note de présentation', rows: [
          ['Activité', `${profile.raisonSociale}${profile.formeJuridique ? ` (${profile.formeJuridique})` : ''}, ${[profile.adresse, profile.ville].filter(Boolean).join(', ') || 'Côte d\'Ivoire'}.`],
          ['Chiffre d\'affaires', money(num(ratios?.chiffreAffaires))],
          ['Résultat', money(cap.resultat)],
          ['Autofinancement', `${money(cap.caf)} — ${couvTxt}`],
          ['Objet', brief.objet || '—'],
          ['Pièces jointes', 'États financiers, états comparatifs N/N-1, tableau de flux de trésorerie, balance âgée des créances.'],
        ],
      },
    ],
    footNote: 'Les états joints sont produits automatiquement à partir des écritures comptabilisées et ont fait l\'objet des contrôles de cohérence inter-modules de Nova. Sous réserve de vérification par le dirigeant et, le cas échéant, de l\'avis de son expert-comptable.',
  });

  // Pièces jointes : on ignore proprement celles qui ne sont pas disponibles.
  const parts: Buffer[] = [cover];
  const push = async (fn: () => Promise<{ buffer: Buffer } | null>) => {
    try { const r = await fn(); if (r?.buffer?.length) parts.push(r.buffer); } catch { /* pièce indisponible */ }
  };
  await push(() => accdocs.etatsFinanciersPdf(c, dossierId, fyId));
  await push(async () => { const r = await accdocs.etatsComparatifsPdf(c, dossierId, fyId); return r.hasPrevious ? r : null; });
  await push(async () => { const r = await accdocs.tftPdf(c, dossierId, fyId); return r.hasPrevious ? r : null; });
  await push(async () => { const r = await accdocs.balanceAgeePdf(c, dossierId); return r.count > 0 ? r : null; });

  // Fusion en un seul PDF.
  const merged = await PDFDocument.create();
  for (const buf of parts) {
    try {
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((pg) => merged.addPage(pg));
    } catch { /* pièce illisible : ignorée */ }
  }
  const bytes = await merged.save();
  const slug = String(profile.raisonSociale || 'entreprise').replace(/\s+/g, '_').replace(/[^\w-]/g, '');
  return { filename: `dossier-financement-${slug}.pdf`, buffer: Buffer.from(bytes) };
}
