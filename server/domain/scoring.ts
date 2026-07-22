import type { Client } from '../db.js';
import { agedBalance } from './lettrage.js';

// ============================================================================
// Scoring de santé financière + éligibilité à la finance embarquée. Calcule, à
// partir de la donnée comptable, un score 0-100 (note A–D), le détail par axe, et
// une offre indicative d'avance de trésorerie. Lecture pure — aucune écriture.
// ============================================================================

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n);

export async function creditScore(c: Client, dossierId: string, fiscalYearId?: string) {
  // Soldes cumulés par compte (position bilancielle).
  const { rows: bal } = await c.query(
    `select a.account_code, a.class_no, coalesce(sum(l.amount_debit - l.amount_credit),0) as bal
       from entry_lines l
       join entries e on e.id=l.entry_id and e.status='posted'
       join accounts a on a.id=l.account_id
      where l.dossier_id=$1 group by a.account_code, a.class_no`, [dossierId]);
  // Aucune écriture validée → le score n'est pas calculable. On évite le « faux
  // score » (les axes retombaient sur des valeurs neutres par défaut, donnant
  // ~38/D à tout dossier vide). On renvoie un état explicite « à compléter ».
  if (bal.length === 0) {
    const axes = [
      { key: 'rentabilite', label: 'Rentabilité', score: 0, weight: 0.30 },
      { key: 'solvabilite', label: 'Autonomie financière', score: 0, weight: 0.20 },
      { key: 'tresorerie', label: 'Trésorerie', score: 0, weight: 0.20 },
      { key: 'recouvrement', label: 'Recouvrement clients', score: 0, weight: 0.15 },
      { key: 'croissance', label: 'Croissance du CA', score: 0, weight: 0.15 },
    ];
    return {
      insufficientData: true, score: 0, rating: 'N.A.', axes, strengths: [], weaknesses: [],
      financing: { eligible: false, amount: 0, note: 'Aucune écriture comptable validée : le score de santé financière se calcule dès les premières saisies.' },
      metrics: { tresorerie: 0, resultat: 0, ca: 0, caMensuel: 0, creances: 0, capitauxPropres: 0, dettesFin: 0, overdue90: 0 },
    };
  }

  const cls = (n: number) => bal.filter((r: any) => r.class_no === n).reduce((s: number, r: any) => s + Number(r.bal), 0);
  const tresorerie = cls(5);
  const creances = bal.filter((r: any) => r.account_code.startsWith('41') && Number(r.bal) > 0).reduce((s: number, r: any) => s + Number(r.bal), 0);
  const capitauxPropres = -bal.filter((r: any) => r.class_no === 1 && Number(r.account_code.slice(0, 2)) <= 15).reduce((s: number, r: any) => s + Number(r.bal), 0);
  const dettesFin = -bal.filter((r: any) => r.class_no === 1 && Number(r.account_code.slice(0, 2)) >= 16).reduce((s: number, r: any) => s + Number(r.bal), 0);

  // Compte de résultat (exercice si fourni).
  const p: any[] = [dossierId]; let w = "l.dossier_id=$1 and e.status='posted'";
  if (fiscalYearId) { p.push(fiscalYearId); w += ` and e.fiscal_year_id=$${p.length}`; }
  const { rows: pl } = await c.query(
    `select coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no=7),0) as produits,
            coalesce( sum(l.amount_debit - l.amount_credit) filter (where a.class_no=6),0) as charges,
            coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.account_code like '70%'),0) as ca
       from entry_lines l join entries e on e.id=l.entry_id join accounts a on a.id=l.account_id where ${w}`, p);
  const produits = Number(pl[0].produits), charges = Number(pl[0].charges), ca = Number(pl[0].ca);
  const resultat = produits - charges;

  // Tendance CA : 3 derniers mois vs 3 précédents.
  const { rows: tr } = await c.query(
    `select to_char(e.entry_date,'YYYY-MM') ym, coalesce(-sum(l.amount_debit - l.amount_credit) filter (where a.class_no=7),0) as prod
       from entry_lines l join entries e on e.id=l.entry_id and e.status='posted' join accounts a on a.id=l.account_id
      where l.dossier_id=$1 and e.entry_date >= (date_trunc('month', current_date) - interval '5 months')
      group by ym order by ym`, [dossierId]);
  const series = tr.map((r: any) => Number(r.prod));
  const last3 = series.slice(-3).reduce((s, x) => s + x, 0);
  const prev3 = series.slice(-6, -3).reduce((s, x) => s + x, 0);
  const monthsActive = Math.max(series.length, 1);
  const caMensuel = round(produits / monthsActive);

  const aged = await agedBalance(c, dossierId);
  const overdue90 = aged.reduce((s: number, r: any) => s + (r.b90_plus > 0 ? r.b90_plus : 0), 0);

  // --- Axes (0-100) ---
  const margeNette = produits > 0 ? resultat / produits : (resultat < 0 ? -1 : 0);
  const sRentabilite = clamp(50 + margeNette * 333);                       // 0%→50, +15%→~100, -15%→0
  const autonomie = (capitauxPropres + dettesFin) > 0 ? capitauxPropres / (capitauxPropres + dettesFin) : (capitauxPropres > 0 ? 1 : 0);
  const sSolvabilite = clamp(autonomie * 200 - 20);                        // 20%→20, 50%→80, 60%→100
  const sTresorerie = tresorerie <= 0 ? clamp(20 + tresorerie / Math.max(caMensuel, 1) * 10)
    : clamp(55 + (caMensuel > 0 ? Math.min(tresorerie / caMensuel, 3) : 1.5) * 15);
  const sRecouvrement = creances > 0 ? clamp(100 - (overdue90 / creances) * 120) : 75;
  const sCroissance = prev3 > 0 ? clamp(55 + ((last3 - prev3) / prev3) * 120) : (last3 > 0 ? 65 : 50);

  const axes = [
    { key: 'rentabilite', label: 'Rentabilité', score: round(sRentabilite), weight: 0.30 },
    { key: 'solvabilite', label: 'Autonomie financière', score: round(sSolvabilite), weight: 0.20 },
    { key: 'tresorerie', label: 'Trésorerie', score: round(sTresorerie), weight: 0.20 },
    { key: 'recouvrement', label: 'Recouvrement clients', score: round(sRecouvrement), weight: 0.15 },
    { key: 'croissance', label: 'Croissance du CA', score: round(sCroissance), weight: 0.15 },
  ];
  const score = round(axes.reduce((s, a) => s + a.score * a.weight, 0));
  const rating = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';

  const strengths = axes.filter((a) => a.score >= 70).map((a) => a.label);
  const weaknesses = axes.filter((a) => a.score < 50).map((a) => a.label);

  // --- Éligibilité finance embarquée : avance de trésorerie indicative ---
  const eligible = score >= 60 && (creances > 0 || caMensuel > 0);
  // Avance adossée à la meilleure assiette : affacturage des créances OU ~1 mois de CA.
  const amount = eligible ? round(Math.max(creances * 0.7, caMensuel * 1.0) / 1000) * 1000 : 0;
  const financing = {
    eligible,
    amount,
    note: eligible
      ? `Pré-éligible à une avance de trésorerie jusqu'à ~${amount.toLocaleString('fr-FR')} (indicatif, adossé aux créances et au chiffre d'affaires).`
      : score < 60 ? 'Score insuffisant pour une avance à ce stade — renforcez rentabilité et trésorerie.'
        : "Pas d'assiette (créances/CA) suffisante pour une avance.",
  };

  return {
    score, rating, axes, strengths, weaknesses, financing,
    metrics: { tresorerie: round(tresorerie), resultat: round(resultat), ca: round(ca), caMensuel, creances: round(creances), capitauxPropres: round(capitauxPropres), dettesFin: round(dettesFin), overdue90: round(overdue90) },
  };
}
