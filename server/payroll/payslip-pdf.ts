import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatFCFA, getMonthName, type PayrollResult, type MonthlyVariables } from './core/index.js';

// ============================================================================
// Rendu serveur d'un bulletin de paie en PDF — modèle IDENTIQUE à Ivoire Paie
// (porté à l'identique). Autoritatif : construit à partir du calcul FIGÉ en
// base. Utilise pdf-lib (polices standard WinAnsi -> texte assaini).
// ============================================================================

const NON_WINANSI_SPACES = new RegExp('[\\u00A0\\u2007\\u2009\\u202F\\u2060\\uFEFF]', 'gu');
const san = (s: string) => (s ?? '').replace(NON_WINANSI_SPACES, ' ');

export interface PayslipPdfInput {
  employer: { name: string; adresse?: string; telephone?: string; numeroCnps?: string; numeroCc?: string };
  employee: {
    matricule: string; nom: string; prenoms: string; poste: string; categorie: string;
    dateEmbauche: string; statutMatrimonial: string; nombrePartsIGR: number; nombreEnfants: number;
    salaireBase: number; sursalaire: number; indemniteLogement: number; autresPrimes: number;
  };
  period: { month: number; year: number };
  numBulletin: string;
  dateEdition: string; // JJ/MM/AAAA
  tenureYears: number;
  variables: MonthlyVariables;
  calc: PayrollResult;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 40;
const DARK = rgb(0.07, 0.09, 0.11);
const GRAY = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.8, 0.82, 0.85);
const HEAD = rgb(0.94, 0.95, 0.96);
const EMERALD = rgb(0.02, 0.59, 0.41);
const WHITE = rgb(1, 1, 1);

export async function renderPayslipPdf(input: PayslipPdfInput): Promise<Uint8Array> {
  const { employer, employee: e, period, calc, variables: v } = input;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const cw = A4.w - 2 * M;

  let page: PDFPage = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const T = (s: string, x: number, size: number, f: PDFFont, color = DARK) => page.drawText(san(s), { x, y, size, font: f, color });
  const money = (n: number) => san(n ? formatFCFA(n) : '—');

  // Bandeau tricolore.
  const stripe = A4.w / 3;
  page.drawRectangle({ x: M, y: y - 3, width: stripe - M, height: 3, color: rgb(0.976, 0.451, 0.086) });
  page.drawRectangle({ x: 2 * stripe, y: y - 3, width: stripe - M, height: 3, color: EMERALD });
  y -= 20;

  // En-tête : employeur (gauche) + cartouche bulletin (droite).
  const topY = y;
  T(employer.name.toUpperCase(), M, 13, bold);
  y -= 14;
  const eLines = [
    employer.adresse,
    employer.numeroCc && `N° d'identification Fiscale (CC) : ${employer.numeroCc}`,
    employer.numeroCnps && `N° employeur CNPS : ${employer.numeroCnps}`,
    employer.telephone,
  ].filter(Boolean) as string[];
  for (const l of eLines) { T(l, M, 8, font, GRAY); y -= 11; }

  // Cartouche à droite.
  const boxX = M + cw * 0.58;
  const boxW = cw * 0.42;
  page.drawRectangle({ x: boxX, y: topY - 58, width: boxW, height: 62, borderColor: LINE, borderWidth: 1, color: rgb(0.98, 0.98, 0.99) });
  const bt = 'BULLETIN DE PAIE';
  page.drawText(bt, { x: boxX + (boxW - bold.widthOfTextAtSize(bt, 10)) / 2, y: topY - 14, size: 10, font: bold });
  const kv = (label: string, valRaw: string, yy: number) => {
    const val = san(valRaw);
    page.drawText(san(label), { x: boxX + 8, y: yy, size: 7.5, font, color: GRAY });
    page.drawText(val, { x: boxX + boxW - 8 - bold.widthOfTextAtSize(val, 8), y: yy, size: 8, font: bold });
  };
  kv('Période :', `${getMonthName(period.month).toUpperCase()} ${period.year}`, topY - 30);
  kv('Édition :', input.dateEdition, topY - 42);
  kv('N° :', input.numBulletin, topY - 54);

  y = Math.min(y, topY - 66) - 8;

  // Bandeau salarié.
  const infoH = 46;
  page.drawRectangle({ x: M, y: y - infoH, width: cw, height: infoH, color: rgb(0.97, 0.975, 0.98), borderColor: LINE, borderWidth: 0.5 });
  const infos: [string, string][] = [
    ['Matricule', e.matricule],
    ['Nom & Prénoms', `${e.nom} ${e.prenoms}`],
    ['Emploi', e.poste || '—'],
    ['Catégorie', e.categorie],
    ['Ancienneté', `${input.tenureYears.toFixed(1)} ans`],
    ['Embauche', new Date(e.dateEmbauche).toLocaleDateString('fr-FR')],
    ['Situation', e.statutMatrimonial],
    ['Parts / Enfants', `${e.nombrePartsIGR} / ${e.nombreEnfants}`],
  ];
  const colW = cw / 4;
  infos.forEach(([label, val], i) => {
    const cx = M + 8 + (i % 4) * colW;
    const cy = y - 14 - Math.floor(i / 4) * 22;
    page.drawText(san(label), { x: cx, y: cy, size: 6.5, font, color: GRAY });
    page.drawText(san(val.length > 26 ? `${val.slice(0, 25)}…` : val), { x: cx, y: cy - 10, size: 8, font: bold });
  });
  y -= infoH + 14;

  // Tableau des rubriques.
  const cols = [
    { label: 'Désignation', x: M + 4, w: cw * 0.4, align: 'l' as const },
    { label: 'Base', x: M + cw * 0.4, w: cw * 0.15, align: 'r' as const },
    { label: 'Taux', x: M + cw * 0.55, w: cw * 0.1, align: 'r' as const },
    { label: 'Gains', x: M + cw * 0.65, w: cw * 0.13, align: 'r' as const },
    { label: 'Retenues', x: M + cw * 0.78, w: cw * 0.11, align: 'r' as const },
    { label: 'Patronal', x: M + cw * 0.89, w: cw * 0.11, align: 'r' as const },
  ];
  const cell = (text: string, col: typeof cols[number], size: number, f: PDFFont, color = DARK) => {
    if (!text) return;
    const s = san(text);
    const w = f.widthOfTextAtSize(s, size);
    const x = col.align === 'r' ? col.x + col.w - 4 - w : col.x;
    page.drawText(s, { x, y, size, font: f, color });
  };
  const rowH = 15;
  // En-tête tableau.
  page.drawRectangle({ x: M, y: y - rowH + 5, width: cw, height: rowH, color: HEAD });
  cols.forEach((c) => cell(c.label, c, 7.5, bold, rgb(0.25, 0.28, 0.32)));
  y -= rowH;

  const ensure = () => { if (y < M + 120) { page = doc.addPage([A4.w, A4.h]); y = A4.h - M; } };
  const row = (desig: string, base: string, taux: string, gains: string, ret: string, pat: string, opts: { bold?: boolean; red?: boolean } = {}) => {
    ensure();
    const f = opts.bold ? bold : font;
    cell(desig, cols[0], 8, f);
    cell(base, cols[1], 8, font, GRAY);
    cell(taux, cols[2], 8, font, GRAY);
    cell(gains, cols[3], 8, font, gains && gains !== '—' ? EMERALD : GRAY);
    cell(ret, cols[4], 8, font, ret && ret !== '—' ? rgb(0.86, 0.15, 0.15) : GRAY);
    cell(pat, cols[5], 8, font, GRAY);
    y -= 3;
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: A4.w - M, y: y + 2 }, thickness: 0.4, color: rgb(0.92, 0.93, 0.94) });
    y -= rowH - 3;
  };

  const pct = (n: number) => `${n}%`;
  row('Salaire de base', money(e.salaireBase), '—', money(e.salaireBase), '—', '—', { bold: true });
  if (e.sursalaire > 0) row('Sursalaire', money(e.sursalaire), '—', money(e.sursalaire), '—', '—');
  if (v.joursAbsence > 0) row(`Déduction absence (${v.joursAbsence} j)`, `${v.joursAbsence} j`, '1/30', '—', money(Math.round(((e.salaireBase + e.sursalaire) / 30) * v.joursAbsence)), '—');
  if (calc.primeAnciennete > 0) row("Prime d'ancienneté", money(e.salaireBase), pct(calc.tauxAnciennete), money(calc.primeAnciennete), '—', '—');
  if (calc.heuresSupMontant > 0) row('Heures supplémentaires', '—', '—', money(calc.heuresSupMontant), '—', '—');
  if (e.indemniteLogement > 0) row('Indemnité de logement', '—', '—', money(e.indemniteLogement), '—', '—');
  if (calc.transportExonere > 0) row('Transport (exonéré)', 'Max 30 000', '—', money(calc.transportExonere), '—', '—');
  if (calc.transportImposable > 0) row('Transport (imposable)', '—', '—', money(calc.transportImposable), '—', '—');
  if (e.autresPrimes + v.primesExceptionnelles > 0) row('Autres primes', '—', '—', money(e.autresPrimes + v.primesExceptionnelles), '—', '—');
  row('Retraite CNPS (salarié)', money(calc.salaireBrutImposable), '6,3%', '—', money(calc.cnpsSalarial), `${money(calc.cnpsRetraitePatronal)}`);
  row('Impôt Unique sur Salaires (IUS)', money(calc.salaireBrutImposable), 'Barème', '—', money(calc.itsSalarial), '—');
  row('Couverture Maladie (CMU)', 'Forfait', '—', '—', money(calc.cmuSalarial), '—');
  row('Prestations familiales', 'Max 70 000', '5,75%', '—', '—', money(calc.cnpsFamille));
  row('Accident du travail', 'Max 70 000', '2%', '—', '—', money(calc.cnpsAccident));
  row('Contribution Unique Employeurs (CUE)', money(calc.salaireBrutImposable), '1,2%', '—', '—', money(calc.taxeApprentissage));
  if (v.acompte > 0) row('Acompte', '—', '—', '—', money(v.acompte), '—', { bold: true });
  if (v.retenuesDiverses > 0) row('Retenues diverses', '—', '—', '—', money(v.retenuesDiverses), '—');
  if (calc.remboursementAvance > 0) row('Remboursement avance/prêt', '—', '—', '—', money(calc.remboursementAvance), '—');

  y -= 8;

  // Totaux.
  ensure();
  const cardW = (cw - 18) / 4;
  const cards: [string, string, boolean][] = [
    ['Total gains bruts', formatFCFA(calc.salaireBrutTotal), false],
    ['Total retenues', `-${formatFCFA(calc.totalRetenuesSalariales)}`, false],
    ['Charges patronales', formatFCFA(calc.totalChargesPatronales), false],
    ['NET À PAYER', formatFCFA(calc.salaireNetPaye), true],
  ];
  cards.forEach(([label, val, hi], i) => {
    const x = M + i * (cardW + 6);
    page.drawRectangle({ x, y: y - 40, width: cardW, height: 40, color: hi ? EMERALD : rgb(0.96, 0.97, 0.975), borderColor: LINE, borderWidth: 0.5 });
    page.drawText(san(label.toUpperCase()), { x: x + 6, y: y - 14, size: 6, font: bold, color: hi ? WHITE : GRAY });
    page.drawText(san(val), { x: x + 6, y: y - 30, size: 11, font: bold, color: hi ? WHITE : DARK });
  });
  y -= 58;

  // Signatures.
  ensure();
  const sigW = (cw - 20) / 2;
  ['Signature du salarié', 'La Direction (cachet & signature)'].forEach((label, i) => {
    const x = M + i * (sigW + 20);
    page.drawRectangle({ x, y: y - 50, width: sigW, height: 50, borderColor: LINE, borderWidth: 0.6 });
    page.drawText(san(label), { x: x + 8, y: y - 14, size: 7.5, font, color: GRAY });
  });
  y -= 62;

  // Pied de page.
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: A4.w - M, y: y + 6 }, thickness: 0.5, color: LINE });
  if (calc.ruleSetLabel) {
    const s = `Règles appliquées : ${calc.ruleSetLabel} (v${calc.ruleSetVersion})`;
    page.drawText(san(s), { x: M, y, size: 7, font, color: GRAY });
    y -= 10;
  }
  const legal = 'Conservez ce bulletin de paie sans limite de durée conformément à la législation ivoirienne.';
  page.drawText(san(legal), { x: M, y, size: 7, font, color: GRAY });

  return doc.save();
}
