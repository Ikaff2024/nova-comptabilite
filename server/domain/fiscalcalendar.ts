// ============================================================================
// Échéancier fiscal & social (Côte d'Ivoire) dérivé du régime fiscal du dossier.
// ⚠️ Dates indicatives À ATTESTER (versionnées ici) : déclarations mensuelles
// dues le 15 du mois suivant ; DSF (états financiers) annuelle. Sert la veille
// proactive de Lexa (contexte + outil + agent nocturne).
// ============================================================================

export const FISCAL_CALENDAR_VERSION = 'CI-2024.1';
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface Deadline { label: string; dueDate: string; category: 'tva' | 'salaires' | 'cnps' | 'dsf' | 'synthetique'; note?: string }

export interface CalendarOpts { regimeFiscal?: string | null; accountingSystem?: string | null; fiscalYearEnd?: string | null; from?: Date; horizonDays?: number }

// Échéances à venir (et fraîchement passées) dans la fenêtre demandée, triées par date.
export function upcomingDeadlines(opts: CalendarOpts): Deadline[] {
  const from = opts.from ?? new Date();
  const horizon = opts.horizonDays ?? 75;
  const lo = new Date(from); lo.setDate(lo.getDate() - 5);          // tolère une échéance juste passée
  const hi = new Date(from); hi.setDate(hi.getDate() + horizon);
  const assujettiTva = opts.regimeFiscal === 'reel_normal' || opts.regimeFiscal === 'reel_simplifie';
  const synthetique = opts.regimeFiscal === 'synthetique';
  const inWindow = (d: Date) => d >= lo && d <= hi;

  const out: Deadline[] = [];

  // Mensuel : déclaration du mois M due le 15 du mois M+1.
  for (let k = -1; k <= 4; k++) {
    const due = new Date(from.getFullYear(), from.getMonth() + k, 15);
    if (!inWindow(due)) continue;
    const per = new Date(due.getFullYear(), due.getMonth() - 1, 1);
    const perLabel = `${MOIS[per.getMonth()]} ${per.getFullYear()}`;
    if (assujettiTva) out.push({ category: 'tva', dueDate: iso(due), label: `TVA de ${perLabel} — déclaration et paiement`, note: 'Régime du réel : TVA mensuelle.' });
    out.push({ category: 'salaires', dueDate: iso(due), label: `Impôts sur salaires (ITS, état 301) de ${perLabel}`, note: 'Si vous avez du personnel.' });
    out.push({ category: 'cnps', dueDate: iso(due), label: `Cotisations CNPS de ${perLabel} — déclaration et versement`, note: 'Si vous avez du personnel.' });
  }

  // Annuel : DSF (états financiers) — régime du réel. Exercice = année civile →
  // dépôt au plus tard le 30 mai N+1 (indicatif). Sinon dérivé de la clôture.
  if (!synthetique) {
    let dsf: Date | null = null;
    if (opts.fiscalYearEnd) {
      const end = new Date(opts.fiscalYearEnd);
      if (!isNaN(end.getTime())) { dsf = new Date(end.getFullYear() + (end.getMonth() === 11 ? 1 : 0), 4, 30); }
    }
    if (!dsf) dsf = new Date(from.getFullYear(), 4, 30);
    for (const cand of [dsf, new Date(dsf.getFullYear() + 1, 4, 30)]) {
      if (inWindow(cand)) out.push({ category: 'dsf', dueDate: iso(cand), label: `Dépôt de la déclaration des états financiers (DSF)`, note: 'Régime du réel — échéance indicative (à confirmer selon la clôture).' });
    }
  } else {
    // Impôt synthétique : pas de TVA ; versements selon échéancier propre (indicatif).
    const synth = new Date(from.getFullYear(), 3, 15); // avant fin avril (indicatif)
    for (const cand of [synth, new Date(synth.getFullYear() + 1, 3, 15)]) {
      if (inWindow(cand)) out.push({ category: 'synthetique', dueDate: iso(cand), label: `Impôt synthétique — déclaration/versement`, note: "Remplace la TVA et le BIC ; échéance indicative." });
    }
  }

  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
