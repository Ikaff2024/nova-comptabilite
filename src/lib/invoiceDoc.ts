import { fmtMoney, type InvoiceDetail, type DossierProfile, type InvoiceTemplate } from './api';

// ============================================================================
// Documents professionnels de facture / devis / avoir (HTML autonome, imprimable).
// Trois modèles, au choix de l'utilisateur selon la nature de l'opération :
//   'standard' : gabarit générique sarcelle (rétro-compatible).
//   'goods'    : vente de biens — tableau d'articles + modalités de livraison
//                + conditions (réserve de propriété, garantie) adaptées OHADA.
//   'services' : prestation de services — livrables + modalités d'exécution
//                + conditions (propriété des livrables, révisions) adaptées OHADA.
// Tous sont alimentés par les MÊMES données (fiche entreprise + lignes du doc) :
// seuls la mise en forme et les mentions changent. Thème clair (papier).
// ============================================================================

const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const dfr = (s?: string | null) => { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return y && m && d ? `${d}/${m}/${y}` : String(s); };

const META: Record<string, { label: string; accent: string }> = {
  quote: { label: 'DEVIS', accent: '' },
  credit_note: { label: 'AVOIR', accent: '#b91c1c' },
  invoice: { label: 'FACTURE', accent: '' },
};

export function invoiceDocumentHtml(inv: InvoiceDetail, co: DossierProfile, currency: string, template?: InvoiceTemplate): string {
  const t = template ?? inv.template ?? 'standard';
  if (t === 'goods') return proDocument(inv, co, currency, 'goods');
  if (t === 'services') return proDocument(inv, co, currency, 'services');
  return standardDocument(inv, co, currency);
}

// ----------------------------------------------------------------------------
// Éléments partagés
// ----------------------------------------------------------------------------
function emetteurLines(co: DossierProfile): string[] {
  return [
    [co.adresse, co.ville].filter(Boolean).map(esc).join(', '),
    co.telephone ? `Tél. ${esc(co.telephone)}` : '',
    [co.taxId ? `NCC/IFU : ${esc(co.taxId)}` : '', co.rccm ? `RCCM : ${esc(co.rccm)}` : ''].filter(Boolean).join(' · '),
  ].filter(Boolean);
}

// ============================================================================
// MODÈLES « PRO » — vente de biens / prestation de services (serif + terracotta)
// ============================================================================
const P = {
  INK: '#2b2620', ACCENT: '#b0563a', MUTED: '#7a7266', LINE: '#e4ddd3',
  SOFT: '#f8f5f0', DARK: '#2b2620', DARKTX: '#f5f1ea', DARKLB: '#d99a7e',
};

interface ProCopy {
  tagline: string;
  section1: { title: string; subtitle: string };
  modalites: { title: string; subtitle: string; rows: [string, string][] };
  conditions: [string, string][];
}

function proCopy(kind: 'goods' | 'services', isQuote: boolean): ProCopy {
  if (kind === 'goods') {
    return {
      tagline: 'Vente de biens et équipements',
      section1: { title: '1. Détail des articles', subtitle: isQuote ? 'Biens proposés à la vente' : 'Biens facturés' },
      modalites: {
        title: '2. Modalités de livraison',
        subtitle: 'Informations pratiques concernant la remise du bien',
        rows: [
          ['Délai de livraison', 'À convenir à la validation de la commande'],
          ['Lieu de livraison', 'Adresse du client, précisée à la commande'],
          ['Transfert de propriété', 'À réception du paiement intégral'],
        ],
      },
      conditions: [
        ['Modalités de paiement', 'Selon accord : acompte à la commande, solde à la livraison.'],
        ['Réserve de propriété', 'Le bien demeure la propriété du vendeur jusqu\'au paiement intégral du prix.'],
        ['Garantie', 'Garantie légale contre les vices cachés, conformément au droit OHADA.'],
        ['Règlement des litiges', 'À défaut d\'accord amiable, compétence des tribunaux d\'Abidjan.'],
      ],
    };
  }
  return {
    tagline: 'Prestation de services',
    section1: { title: '1. Détail des prestations', subtitle: isQuote ? 'Prestations proposées' : 'Prestations facturées' },
    modalites: {
      title: '2. Modalités d\'exécution',
      subtitle: 'Conditions de réalisation de la prestation',
      rows: [
        ['Délai d\'exécution', 'À convenir au lancement de la mission'],
        ['Lieu d\'exécution', 'Dans les locaux du prestataire, sauf mention contraire'],
        ['Livrables', 'Remis à l\'achèvement de la prestation'],
      ],
    },
    conditions: [
      ['Modalités de paiement', 'Selon accord : acompte au lancement, solde à la livraison.'],
      ['Propriété des livrables', 'Les livrables restent la propriété du prestataire jusqu\'au paiement intégral.'],
      ['Révisions', 'Ajustements mineurs inclus ; toute évolution majeure fait l\'objet d\'un avenant.'],
      ['Règlement des litiges', 'À défaut d\'accord amiable, compétence des tribunaux d\'Abidjan.'],
    ],
  };
}

function proDocument(inv: InvoiceDetail, co: DossierProfile, currency: string, kind: 'goods' | 'services'): string {
  const m = (n: number) => fmtMoney(n, currency);
  const meta = META[inv.doc_type] ?? META.invoice;
  const isQuote = inv.doc_type === 'quote';
  const isCredit = inv.doc_type === 'credit_note';
  const num = inv.number ?? '(brouillon)';
  const copy = proCopy(kind, isQuote);
  const emet = emetteurLines(co);

  // TVA : colonne par ligne seulement si les taux diffèrent (sinon rendu épuré,
  // TVA unique dans les totaux — fidèle aux maquettes).
  const rates = Array.from(new Set(inv.lines.map((l) => l.vat_rate)));
  const uniform = rates.length === 1 ? rates[0] : null;
  const showLineTva = uniform === null;
  const tvaLabel = uniform !== null && uniform > 0 ? `TVA (${Math.round(uniform * 100)}%)` : 'TVA';

  const dateRow = (label: string, val: string) => val
    ? `<div style="font-size:13px;color:${P.MUTED};margin-top:2px">${label} : <span style="color:${P.INK}">${esc(val)}</span></div>` : '';

  const th = (t: string, align = 'left') => `<th style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;text-align:${align};padding:10px 12px;color:${P.INK}">${t}</th>`;
  const lignes = inv.lines.map((l) => `
    <tr style="border-bottom:1px solid ${P.LINE}">
      <td style="padding:11px 12px;font-weight:600">${esc(l.description)}</td>
      <td style="padding:11px 12px;text-align:center;font-size:13px">${l.quantity}</td>
      ${showLineTva ? `<td style="padding:11px 12px;text-align:right;font-size:13px">${Math.round(l.vat_rate * 100)}%</td>` : ''}
      <td style="padding:11px 12px;text-align:right;font-variant-numeric:tabular-nums">${m(l.unit_price)}</td>
      <td style="padding:11px 12px;text-align:right;font-variant-numeric:tabular-nums">${m(l.amount_ht ?? l.quantity * l.unit_price)}</td>
    </tr>`).join('');

  const totRow = (label: string, val: string, opts: { border?: boolean; big?: boolean } = {}) => `
    <div style="display:flex;justify-content:space-between;padding:${opts.big ? '14px 0 0' : '8px 0'};font-size:${opts.big ? '19px' : '14px'};${opts.border ? `border-bottom:1px solid ${P.LINE}` : ''}${opts.big ? `;font-family:Georgia,serif;font-weight:600` : ''}">
      <span style="color:${opts.big ? P.INK : P.MUTED}">${label}</span>
      <span style="font-variant-numeric:tabular-nums${opts.big ? `;color:${P.ACCENT}` : ''}">${val}</span>
    </div>`;

  const objet = inv.notes
    ? `<div style="background:${P.SOFT};border:1px solid ${P.LINE};border-radius:4px;padding:18px 22px;margin-bottom:34px">
         <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:${P.ACCENT};font-weight:600;margin-bottom:6px">Objet</div>
         <div style="font-family:Georgia,serif;font-size:16px">${esc(inv.notes)}</div>
       </div>` : '';

  const modalites = isQuote
    ? `<div style="font-family:Georgia,serif;font-size:18px;font-weight:600;margin-bottom:4px">${copy.modalites.title}</div>
       <div style="font-size:13px;color:${P.MUTED};margin-bottom:12px">${copy.modalites.subtitle}</div>
       <table style="width:100%;border-collapse:collapse;margin-bottom:32px">
         <tbody>${copy.modalites.rows.map(([k, v]) => `
           <tr style="border-bottom:1px solid ${P.LINE}">
             <td style="padding:10px 12px;font-weight:600;width:210px">${k}</td>
             <td style="padding:10px 12px;font-size:13px;color:${P.MUTED}">${v}</td>
           </tr>`).join('')}
         </tbody>
       </table>` : '';

  const paiement = (!isQuote && (co.bankName || co.rib))
    ? `<div style="margin-top:24px;padding:14px 18px;background:${P.SOFT};border:1px solid ${P.LINE};border-radius:4px;font-size:13px">
         <span style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${P.ACCENT};font-weight:600">Coordonnées de paiement</span><br>
         ${co.bankName ? `Banque : <strong>${esc(co.bankName)}</strong>` : ''}${co.bankName && co.rib ? ' · ' : ''}${co.rib ? `RIB/IBAN : <strong>${esc(co.rib)}</strong>` : ''}
       </div>` : '';

  const fne = inv.fne_reference
    ? `<div style="margin-top:12px;font-size:12px;color:${P.MUTED}"><strong style="color:${P.INK}">Facture Normalisée Électronique</strong> — Réf. ${esc(inv.fne_reference)}</div>` : '';

  const conditions = `
    <div style="font-family:Georgia,serif;font-size:18px;font-weight:600;margin-bottom:12px">Conditions</div>
    <div style="font-size:13px;color:${P.MUTED};column-count:2;column-gap:32px">
      ${copy.conditions.map(([k, v]) => `<p style="margin:0 0 12px 0;break-inside:avoid"><strong style="color:${P.INK}">${k}</strong> — ${v}</p>`).join('')}
    </div>`;

  const signature = isQuote
    ? `<div style="display:flex;justify-content:space-between;gap:40px;margin-top:46px;padding-top:24px;border-top:1px solid ${P.LINE}">
         <div style="width:45%">
           <div style="font-size:12px;color:${P.MUTED};margin-bottom:40px">Bon pour accord — le client</div>
           <div style="border-top:1px solid #b9b0a3;font-size:11px;color:${P.MUTED};padding-top:4px">Date, signature et cachet</div>
         </div>
         <div style="width:45%">
           <div style="font-size:12px;color:${P.MUTED};margin-bottom:40px">${esc(co.raisonSociale)}</div>
           <div style="border-top:1px solid #b9b0a3;font-size:11px;color:${P.MUTED};padding-top:4px">Signature et cachet</div>
         </div>
       </div>` : '';

  const secondDate = isQuote ? dateRow('Valable jusqu\'au', dfr(inv.due_date)) : dateRow('Échéance', dfr(inv.due_date));

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${meta.label} ${esc(num)} — ${esc(co.raisonSociale)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;color:${P.INK};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .doc{max-width:820px;margin:0 auto;padding:34px 42px}
  table{width:100%;border-collapse:collapse}
  @media print{ .doc{max-width:none;padding:13mm} @page{margin:0} }
</style></head><body><div class="doc">

  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${P.INK};padding-bottom:22px;margin-bottom:30px">
    <div>
      <div style="font-family:Georgia,serif;font-size:29px;font-weight:600;letter-spacing:-.01em">${esc(co.raisonSociale)}</div>
      <div style="font-size:13px;color:${P.MUTED};margin-top:4px">${co.formeJuridique ? esc(co.formeJuridique) + ' · ' : ''}${copy.tagline}</div>
    </div>
    <div style="text-align:right;min-width:220px">
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:${isCredit ? meta.accent : P.ACCENT};letter-spacing:.04em">${meta.label}</div>
      <div style="font-size:13px;margin-top:6px">N° <strong>${esc(num)}</strong></div>
      ${dateRow('Émis le', dfr(inv.invoice_date))}
      ${secondDate}
    </div>
  </div>

  <div style="display:flex;gap:40px;margin-bottom:34px">
    <div style="flex:1">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:${P.ACCENT};font-weight:600;margin-bottom:8px">Émetteur</div>
      <div style="font-size:14px;font-weight:600">${esc(co.raisonSociale)}</div>
      ${emet.map((l) => `<div style="font-size:13px;color:${P.MUTED}">${l}</div>`).join('')}
    </div>
    <div style="flex:1">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:${P.ACCENT};font-weight:600;margin-bottom:8px">${isCredit ? 'Avoir au profit de' : isQuote ? 'Destinataire' : 'Client'}</div>
      <div style="font-size:14px;font-weight:600">${esc(inv.client_name)}</div>
    </div>
  </div>

  ${objet}

  <div style="font-family:Georgia,serif;font-size:18px;font-weight:600;margin-bottom:4px">${copy.section1.title}</div>
  <div style="font-size:13px;color:${P.MUTED};margin-bottom:12px">${copy.section1.subtitle}</div>
  <table style="margin-bottom:${isQuote ? '32px' : '20px'}">
    <thead><tr style="border-bottom:2px solid ${P.INK}">
      ${th('Désignation')}${th('Qté', 'center')}${showLineTva ? th('TVA', 'right') : ''}${th('Prix unitaire HT', 'right')}${th('Total HT', 'right')}
    </tr></thead>
    <tbody>${lignes}</tbody>
  </table>

  ${modalites}

  <div style="display:flex;justify-content:flex-end;margin-bottom:38px">
    <div style="width:290px">
      ${totRow('Total HT', m(inv.total_ht))}
      ${totRow(tvaLabel, m(inv.total_tva), { border: true })}
      ${totRow(isCredit ? 'Total TTC (à déduire)' : 'Total TTC', m(inv.total_ttc), { big: true })}
    </div>
  </div>

  ${conditions}
  ${paiement}
  ${fne}
  ${signature}

  <div style="margin-top:34px;padding-top:12px;border-top:1px solid ${P.LINE};font-size:10.5px;color:${P.MUTED};text-align:center">
    ${esc(co.raisonSociale)}${emet.length ? ' — ' + emet.join(' · ') : ''} · Document généré par Nova Comptabilité.
  </div>

</div></body></html>`;
}

// ============================================================================
// MODÈLE STANDARD (sarcelle) — gabarit générique historique
// ============================================================================
const ACCENT = '#0f766e';
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const SOFT = '#f8fafc';
const S_META: Record<string, { label: string; accent: string }> = {
  quote: { label: 'DEVIS', accent: ACCENT },
  credit_note: { label: 'AVOIR', accent: '#b91c1c' },
  invoice: { label: 'FACTURE', accent: ACCENT },
};

function standardDocument(inv: InvoiceDetail, co: DossierProfile, currency: string): string {
  const m = (n: number) => fmtMoney(n, currency);
  const meta = S_META[inv.doc_type] ?? S_META.invoice;
  const isQuote = inv.doc_type === 'quote';
  const isCredit = inv.doc_type === 'credit_note';
  const num = inv.number ?? '(brouillon)';

  const emetteur = [
    co.formeJuridique ? `${esc(co.raisonSociale)} — ${esc(co.formeJuridique)}` : esc(co.raisonSociale),
    [co.adresse, co.ville].filter(Boolean).map(esc).join(', '),
    co.telephone ? `Tél. ${esc(co.telephone)}` : '',
    [co.taxId ? `NCC/IFU : ${esc(co.taxId)}` : '', co.rccm ? `RCCM : ${esc(co.rccm)}` : ''].filter(Boolean).join(' · '),
  ].filter(Boolean);

  const dateRow = (label: string, val: string) => val
    ? `<div style="display:flex;justify-content:space-between;gap:16px;font-size:12.5px;margin-top:3px"><span style="color:${MUTED}">${label}</span><strong>${esc(val)}</strong></div>` : '';

  const lignes = inv.lines.map((l) => `
    <tr style="border-bottom:1px solid ${LINE}">
      <td style="padding:9px 10px;">${esc(l.description)}</td>
      <td style="padding:9px 10px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap">${l.quantity}</td>
      <td style="padding:9px 10px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap">${m(l.unit_price)}</td>
      <td style="padding:9px 10px;text-align:right;white-space:nowrap">${Math.round(l.vat_rate * 100)}%</td>
      <td style="padding:9px 10px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap">${m(l.amount_ht ?? (l.quantity * l.unit_price))}</td>
    </tr>`).join('');

  const totLine = (label: string, val: string, strong = false, accent = false) => `
    <div style="display:flex;justify-content:space-between;gap:24px;padding:${strong ? '12px 0 0' : '7px 0'};font-size:${strong ? '18px' : '13.5px'};${strong ? `border-top:2px solid ${INK};margin-top:4px;font-weight:600` : ''}">
      <span style="color:${strong ? INK : MUTED}${strong ? ";font-family:Georgia,serif" : ''}">${label}</span>
      <span style="font-variant-numeric:tabular-nums;${accent ? `color:${meta.accent};font-weight:600` : ''}${strong ? ';font-family:Georgia,serif' : ''}">${val}</span>
    </div>`;

  const paiement = (!isQuote && (co.bankName || co.rib))
    ? `<div style="margin-top:26px;padding:14px 16px;background:${SOFT};border:1px solid ${LINE};border-radius:6px;font-size:12.5px">
         <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:${meta.accent};font-weight:600;margin-bottom:5px">Coordonnées de paiement</div>
         ${co.bankName ? `Banque : <strong>${esc(co.bankName)}</strong>` : ''}${co.bankName && co.rib ? ' · ' : ''}${co.rib ? `RIB/IBAN : <strong>${esc(co.rib)}</strong>` : ''}
       </div>` : '';

  const fne = inv.fne_reference
    ? `<div style="margin-top:14px;font-size:12px;color:${MUTED}"><strong style="color:${INK}">Facture Normalisée Électronique</strong> — Réf. ${esc(inv.fne_reference)}</div>` : '';

  const notes = inv.notes
    ? `<div style="margin:22px 0;padding:14px 18px;background:${SOFT};border:1px solid ${LINE};border-radius:6px">
         <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:${meta.accent};font-weight:600;margin-bottom:4px">Objet / notes</div>
         <div style="font-size:13px">${esc(inv.notes)}</div>
       </div>` : '';

  const signature = isQuote
    ? `<div style="display:flex;justify-content:space-between;gap:40px;margin-top:44px;padding-top:22px;border-top:1px solid ${LINE}">
         <div style="width:46%">
           <div style="font-size:12px;color:${MUTED};margin-bottom:38px">Bon pour accord — le client</div>
           <div style="border-top:1px solid #9ca3af;padding-top:4px;font-size:11px;color:${MUTED}">Date, signature et cachet</div>
         </div>
         <div style="width:46%">
           <div style="font-size:12px;color:${MUTED};margin-bottom:38px">${esc(co.raisonSociale)}</div>
           <div style="border-top:1px solid #9ca3af;padding-top:4px;font-size:11px;color:${MUTED}">Signature et cachet</div>
         </div>
       </div>` : '';

  const secondDateLabel = isQuote ? 'Valable jusqu\'au' : 'Échéance';

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${meta.label} ${esc(num)} — ${esc(co.raisonSociale)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;color:${INK};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .doc{max-width:820px;margin:0 auto;padding:34px 40px}
  .serif{font-family:Georgia,'Times New Roman',serif}
  table{width:100%;border-collapse:collapse}
  @media print{ .doc{max-width:none;padding:14mm} @page{margin:0} }
</style></head><body><div class="doc">

  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${INK};padding-bottom:20px">
    <div>
      <div class="serif" style="font-size:27px;font-weight:600;letter-spacing:-.01em">${esc(co.raisonSociale)}</div>
      ${co.formeJuridique ? `<div style="font-size:12.5px;color:${MUTED};margin-top:3px">${esc(co.formeJuridique)}</div>` : ''}
    </div>
    <div style="text-align:right;min-width:210px">
      <div class="serif" style="font-size:22px;font-weight:600;color:${meta.accent};letter-spacing:.04em">${meta.label}</div>
      <div style="font-size:13px;margin-top:5px">N° <strong>${esc(num)}</strong></div>
      ${dateRow('Date', dfr(inv.invoice_date))}
      ${dateRow(secondDateLabel, dfr(inv.due_date))}
    </div>
  </div>

  <div style="display:flex;gap:40px;margin:26px 0 8px">
    <div style="flex:1">
      <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:${meta.accent};font-weight:600;margin-bottom:6px">Émetteur</div>
      <div style="font-size:14px;font-weight:600">${esc(co.raisonSociale)}</div>
      ${emetteur.slice(1).map((l) => `<div style="font-size:12.5px;color:${MUTED}">${l}</div>`).join('')}
    </div>
    <div style="flex:1">
      <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:${meta.accent};font-weight:600;margin-bottom:6px">${isCredit ? 'Avoir au profit de' : isQuote ? 'Destinataire' : 'Facturé à'}</div>
      <div style="font-size:14px;font-weight:600">${esc(inv.client_name)}</div>
    </div>
  </div>

  ${notes}

  <table style="margin-top:22px">
    <thead>
      <tr style="border-bottom:2px solid ${INK}">
        <th style="text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Désignation</th>
        <th style="text-align:right;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Qté</th>
        <th style="text-align:right;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em">P.U. HT</th>
        <th style="text-align:right;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em">TVA</th>
        <th style="text-align:right;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Montant HT</th>
      </tr>
    </thead>
    <tbody>${lignes}</tbody>
  </table>

  <div style="display:flex;justify-content:flex-end;margin-top:18px">
    <div style="width:280px">
      ${totLine('Total HT', m(inv.total_ht))}
      ${totLine('TVA', m(inv.total_tva))}
      ${totLine(isCredit ? 'Total TTC (à déduire)' : 'Total TTC', m(inv.total_ttc), true, true)}
    </div>
  </div>

  ${paiement}
  ${fne}
  ${signature}

  <div style="margin-top:34px;padding-top:12px;border-top:1px solid ${LINE};font-size:10.5px;color:${MUTED};text-align:center">
    ${emetteur.filter(Boolean).join(' · ')} — Document généré par Nova Comptabilité.
  </div>

</div></body></html>`;
}
