import type { Employee } from './core/index.js';

// =============================================================================
// Exports « modèles officiels » — CNPS nominatif, État 301, FUDP (détail ITS).
// Portés d'IvoirePaie (src/utils/officialExports.ts) et adaptés aux structures
// de Nova. Produisent EXACTEMENT les colonnes attendues par les formulaires
// officiels, DANS L'ORDRE : l'utilisateur n'a qu'à coller le bloc de données
// dans le modèle, puis générer le XML via la macro du formulaire.
//
// Repères de collage (validés sur les modèles officiels) :
//   • CNPS  : onglet « Feuil1 »,     en-têtes ligne 1  → coller en A2
//   • É.301 : onglet « SAISIE »,     en-têtes ligne 14 → coller en C17
//   • FUDP  : onglet « DETAIL-ITS », en-têtes ligne 14 → coller en C17
//
// ⚠️ Dans l'État 301, les colonnes S, U, X et Z sont des FORMULES dans le modèle
// (S=P+Q+R, U=S−T, X=max(0,W−V), Z=max(0,X+Y)). On les PRÉ-CALCULE ici pour que
// le collage se fasse en un seul bloc : la macro lit les valeurs, donc remplacer
// les formules par des valeurs exactes n'affecte pas la génération du XML.
// =============================================================================

export const PASTE_TARGETS = {
  cnps: { sheet: 'Feuil1', cell: 'A2', headerRow: 1 },
  etat301: { sheet: 'SAISIE', cell: 'C17', headerRow: 14 },
  fudp: { sheet: 'DETAIL-ITS', cell: 'C17', headerRow: 14 },
} as const;

export interface ExportTable {
  /** En-têtes lisibles (aperçu à l'écran ; NE PAS coller dans le modèle). */
  headers: string[];
  /** Lignes de données, dans l'ordre exact des colonnes du modèle. */
  rows: (string | number)[][];
  /** Anomalies à corriger avant dépôt. */
  warnings: string[];
  /** Consigne de collage, affichée à l'utilisateur. */
  paste: { sheet: string; cell: string; headerRow: number };
}

/** Un bulletin enregistré, tel que stocké par Nova (payroll_payslips). */
export interface SlipRow { employeeId: string; year: number; month: number; calculation: any }

const numv = (v: any) => (v == null || Number.isNaN(Number(v)) ? 0 : Number(v));

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' (format attendu par le modèle CNPS). */
function toFrDate(iso?: string): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Code emploi État 301 : celui saisi, sinon déduit de la catégorie socio-pro. */
export function resolveCodeEmploi(e: Employee): string {
  if (e.codeEmploi) return e.codeEmploi;
  switch (e.categorie) {
    case 'Cadre': return 'CS';
    case 'Agent de Maitrise': return 'AM';
    case 'Employe': return 'EQ';
    case 'Ouvrier': return 'OQ';
    default: return 'A';
  }
}

/** Situation de famille → code DGI (C/M/D/V). */
export function situationFamilleCode(e: Employee): string {
  const s = String(e.statutMatrimonial ?? '');
  if (s.startsWith('Marie')) return 'M';
  if (s.startsWith('Divorce')) return 'D';
  if (s.startsWith('Veuf')) return 'V';
  return 'C';
}

// --- 1) CNPS — cotisation nominative (mensuel) -------------------------------
export const CNPS_HEADERS = [
  'NUMERO CNPS', 'NOM', 'PRENOMS', 'ANNEE DE NAISSANCE', "DATE D'EMBAUCHE",
  'DATE DE DEPART', 'TYPE SALARIE', 'DUREE TRAVAILLEE', 'SALAIRE BRUT', 'BRANCHE COTISEE',
];

export function buildCnpsTable(employees: Employee[], slips: SlipRow[], year: number, month: number): ExportTable {
  const monthly = slips.filter((p) => p.year === year && p.month === month);
  const warnings: string[] = [];
  const missingCnps: string[] = [];

  const rows = monthly.map((p) => {
    const e = employees.find((x) => x.id === p.employeeId);
    if (e && !e.numeroCnps) missingCnps.push(`${e.nom} ${e.prenoms}`);
    return [
      e?.numeroCnps ?? '',
      e?.nom ?? 'INCONNU',
      e?.prenoms ?? '',
      e?.dateNaissance ? String(e.dateNaissance).slice(0, 4) : '',
      toFrDate(e?.dateEmbauche),
      toFrDate(e?.dateFinContrat),
      'M',   // mensuel
      1,     // durée travaillée (1 mois)
      Math.round(numv(p.calculation?.salaireBrutTotal)),
      '123', // Retraite + AT/MP + PF/Maternité
    ];
  });

  if (monthly.length === 0) warnings.push('Aucun bulletin pour cette période.');
  if (missingCnps.length > 0) {
    warnings.push(`N° CNPS manquant pour ${missingCnps.length} salarié(s) : ${missingCnps.slice(0, 5).join(', ')}${missingCnps.length > 5 ? '…' : ''}`);
  }
  return { headers: CNPS_HEADERS, rows, warnings, paste: PASTE_TARGETS.cnps };
}

// --- 2) État 301 (annuel) & FUDP (mensuel) — détail ITS, colonnes C..AB ------
export const ETAT301_HEADERS = [
  'N° CNPS', 'Nom et prénoms', 'Type de travailleur', 'Emploi ou Qualité', 'Code Emploi',
  'Régime (G/A)', 'Sexe', 'Nationalité', 'Local/Expatrié', 'Situation de famille',
  "Nombre d'enfants à charge", 'Nombre de parts', "Nombre de jours d'application",
  'Salaires et rémunérations accessoires', 'Avantages en nature (barème)',
  'Avantages en nature (réel)', 'Rémunération totale brute', 'Revenus non imposables',
  'Rémunération brute imposable', 'RICF', 'ITS brut', 'ITS net', 'Ajustement',
  'ITS net à payer', 'Indemnités exonérées (montant)', 'Désignation',
];

// Les deux formulaires DGI partagent exactement ces colonnes : seule la période
// de sélection change (année entière pour l'État 301, un mois pour le FUDP).
function buildItsDetailTable(
  employees: Employee[], slips: SlipRow[], keep: (p: SlipRow) => boolean,
  contexte: string, paste: ExportTable['paste'],
): ExportTable {
  const kept = slips.filter(keep);
  const warnings: string[] = [];
  const missing = { cnps: 0, sexe: 0, nat: 0, loc: 0 };

  const byEmp = new Map<string, SlipRow[]>();
  for (const p of kept) {
    const list = byEmp.get(p.employeeId) ?? [];
    list.push(p);
    byEmp.set(p.employeeId, list);
  }

  const rows: (string | number)[][] = [];
  for (const [empId, list] of byEmp) {
    const e = employees.find((x) => x.id === empId);
    if (!e) continue;
    if (!e.numeroCnps) missing.cnps++;
    if (!e.sexe) missing.sexe++;
    if (!e.nationalite) missing.nat++;
    if (!e.localExpatrie) missing.loc++;

    const sum = (f: (c: any) => number) => Math.round(list.reduce((s, p) => s + numv(f(p.calculation ?? {})), 0));

    const brutTotal = sum((c) => c.salaireBrutTotal);
    const brutImposable = sum((c) => c.salaireBrutImposable);
    const nonImposable = Math.max(0, brutTotal - brutImposable);
    // ITS brut / RICF : détail exposé par le moteur depuis la réforme. Repli sur
    // l'impôt net pour les bulletins figés avant l'introduction de ce détail.
    const itsBrut = sum((c) => c.iusBrut ?? c.itsSalarial);
    const ricf = sum((c) => c.iusReduction ?? 0);
    const itsNet = Math.max(0, itsBrut - ricf);
    const jours = list.length * 30; // convention : 30 jours par mois déclaré

    rows.push([
      e.numeroCnps ?? '',                    // C
      `${e.nom} ${e.prenoms}`.trim(),        // D
      'Salarié',                             // E
      e.poste || 'Salarié',                  // F
      resolveCodeEmploi(e),                  // G
      'G',                                   // H — régime général
      e.sexe ?? '',                          // I
      e.nationalite ?? '',                   // J
      e.localExpatrie ?? '',                 // K
      situationFamilleCode(e),               // L
      numv(e.nombreEnfants),                 // M
      numv(e.nombrePartsIGR),                // N
      jours,                                 // O
      brutTotal,                             // P
      0,                                     // Q — avantages en nature (barème)
      0,                                     // R — avantages en nature (réel)
      brutTotal,                             // S = P+Q+R (pré-calculée)
      nonImposable,                          // T
      brutImposable,                         // U = S−T (pré-calculée)
      ricf,                                  // V
      itsBrut,                               // W
      itsNet,                                // X = max(0, W−V) (pré-calculée)
      0,                                     // Y — ajustement
      itsNet,                                // Z = max(0, X+Y) (pré-calculée)
      0,                                     // AA — indemnités exonérées
      'NEANT',                               // AB — désignation
    ]);
  }

  if (rows.length === 0) warnings.push(`Aucun bulletin pour ${contexte}.`);
  if (missing.cnps) warnings.push(`N° CNPS manquant : ${missing.cnps} salarié(s).`);
  if (missing.sexe) warnings.push(`Sexe non renseigné : ${missing.sexe} salarié(s).`);
  if (missing.nat) warnings.push(`Nationalité non renseignée : ${missing.nat} salarié(s).`);
  if (missing.loc) warnings.push(`Local/Expatrié non renseigné : ${missing.loc} salarié(s).`);
  return { headers: ETAT301_HEADERS, rows, warnings, paste };
}

/** État 301 — déclaration ANNUELLE des salaires (cumul sur l'exercice). */
export function buildEtat301Table(employees: Employee[], slips: SlipRow[], year: number): ExportTable {
  return buildItsDetailTable(employees, slips, (p) => p.year === year, `l'exercice ${year}`, PASTE_TARGETS.etat301);
}

/** FUDP — détail ITS MENSUEL (onglet DETAIL-ITS du formulaire unique DGI). */
export function buildFudpItsTable(employees: Employee[], slips: SlipRow[], year: number, month: number): ExportTable {
  return buildItsDetailTable(employees, slips, (p) => p.year === year && p.month === month, 'ce mois', PASTE_TARGETS.fudp);
}

/** Nom de fichier normalisé. */
export function officialFilename(kind: 'CNPS' | 'ETAT301' | 'FUDP_ITS', year: number, month?: number): string {
  return month === undefined ? `${kind}_${year}.csv` : `${kind}_${year}${String(month + 1).padStart(2, '0')}.csv`;
}
