import type { Client } from '../db.js';
import { dossierDashboard } from './dossierdashboard.js';
import { upcomingDeadlines } from './fiscalcalendar.js';
import * as acc from './accounting.js';

// ============================================================================
// Alertes intelligentes : synthèse priorisée de ce qui nécessite l'attention
// du dirigeant (trésorerie, créances, fiscalité, brouillons, échéances). Lecture
// seule — recompose des signaux déjà calculés ailleurs. Alimente la proactivité
// de Lexa et, à terme, l'agent nocturne.
// ============================================================================

export type Niveau = 'haute' | 'moyenne' | 'info';
export interface Alerte {
  niveau: Niveau; categorie: string; titre: string;
  detail?: string; montant?: number; echeance?: string; onglet?: string;
}

const RANK: Record<Niveau, number> = { haute: 0, moyenne: 1, info: 2 };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysUntil = (d: string) => Math.ceil((new Date(d + 'T00:00:00Z').getTime() - Date.now()) / 86400000);

export async function dossierAlerts(c: Client, dossierId: string, fiscalYearId?: string): Promise<{
  dossierId: string; devise: string; genereLe: string;
  resume: { haute: number; moyenne: number; info: number; total: number };
  alertes: Alerte[];
}> {
  const { rows: dr } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = dr[0]?.j ?? {};
  const devise = d.base_currency ?? 'XOF';
  const alertes: Alerte[] = [];

  // --- Signaux du tableau de bord du dossier (trésorerie, TVA, créances…) ---
  try {
    const dash: any = await dossierDashboard(c, dossierId, fiscalYearId);
    const k = dash.kpis ?? {};
    if (k.tresorerie < 0) alertes.push({ niveau: 'haute', categorie: 'tresorerie', titre: 'Trésorerie négative', detail: 'Le solde des comptes de trésorerie (5) est négatif.', montant: Math.round(k.tresorerie), onglet: 'saisie' });
    else if (k.tresorerie >= 0 && k.dettesFrs > 0 && k.tresorerie < k.dettesFrs) alertes.push({ niveau: 'moyenne', categorie: 'tresorerie', titre: 'Trésorerie inférieure aux dettes fournisseurs', detail: 'La trésorerie disponible ne couvre pas les dettes fournisseurs en cours.', montant: Math.round(k.tresorerie), onglet: 'tiers' });

    if (dash.aged?.overdue90 > 0) alertes.push({ niveau: 'haute', categorie: 'creances', titre: 'Créances anciennes (> 90 jours)', detail: 'Créances clients échues depuis plus de 90 jours — relance recommandée.', montant: Math.round(dash.aged.overdue90), onglet: 'tiers' });

    const vat = dash.vat ?? {};
    if (vat.netDue > 0) alertes.push({ niveau: 'moyenne', categorie: 'tva', titre: 'TVA à déclarer et payer', detail: `Période ${vat.period ?? ''}.`, montant: Math.round(vat.netDue), echeance: nextVatDeadline(), onglet: 'fiscalite' });

    if (dash.activity?.drafts > 0) alertes.push({ niveau: 'moyenne', categorie: 'saisie', titre: `${dash.activity.drafts} écriture(s) en brouillon`, detail: 'Des écritures attendent d\'être validées (elles ne sont pas au grand livre).', onglet: 'saisie' });

    if (k.resultat < 0) alertes.push({ niveau: 'info', categorie: 'resultat', titre: 'Résultat déficitaire', detail: 'Le résultat cumulé de l\'exercice est négatif.', montant: Math.round(k.resultat), onglet: 'etats' });
  } catch { /* dashboard indisponible : on continue avec les autres sources */ }

  // --- Échéances fiscales/sociales proches ---
  try {
    let fyEnd: string | null = null;
    try { const fys = await acc.listFiscalYears(c, dossierId); const openFy = fys.find((f: any) => f.status && f.status !== 'closed') ?? fys[fys.length - 1]; fyEnd = openFy?.end_date ?? null; } catch { /* ignore */ }
    const deadlines = upcomingDeadlines({ regimeFiscal: d.regime_fiscal, accountingSystem: d.accounting_system, fiscalYearEnd: fyEnd, horizonDays: 20 });
    for (const dl of deadlines) {
      const j = daysUntil(dl.dueDate);
      if (j < 0 || j > 15) continue; // seulement les échéances imminentes
      alertes.push({ niveau: j <= 5 ? 'haute' : 'moyenne', categorie: `echeance_${dl.category}`, titre: dl.label, detail: j <= 0 ? "Échéance aujourd'hui." : `Dans ${j} jour(s).`, echeance: dl.dueDate, onglet: 'fiscalite' });
    }
  } catch { /* calendrier indisponible */ }

  alertes.sort((a, b) => RANK[a.niveau] - RANK[b.niveau] || (a.echeance ?? '').localeCompare(b.echeance ?? ''));
  const resume = {
    haute: alertes.filter((a) => a.niveau === 'haute').length,
    moyenne: alertes.filter((a) => a.niveau === 'moyenne').length,
    info: alertes.filter((a) => a.niveau === 'info').length,
    total: alertes.length,
  };
  return { dossierId, devise, genereLe: new Date().toISOString(), resume, alertes };
}

// Échéance TVA du régime réel : le 15 du mois suivant.
function nextVatDeadline(): string {
  const now = new Date();
  return iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15)));
}
