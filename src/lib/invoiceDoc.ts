import { fmtMoney, type InvoiceDetail, type DossierProfile } from './api';

// ============================================================================
// Document professionnel de facture / devis / avoir (HTML autonome, imprimable).
// Reprend l'identité de l'entreprise (fiche entreprise) : en-tête soigné, blocs
// émetteur/client, totaux mis en valeur, coordonnées de paiement, mentions
// légales, et bloc de signature pour les devis. Thème clair (papier).
// ============================================================================

const ACCENT = '#0f766e';        // sarcelle sobre et professionnel
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const SOFT = '#f8fafc';

const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const dfr = (s?: string | null) => { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return y && m && d ? `${d}/${m}/${y}` : String(s); };

const META: Record<string, { label: string; accent: string }> = {
  quote: { label: 'DEVIS', accent: ACCENT },
  credit_note: { label: 'AVOIR', accent: '#b91c1c' },
  invoice: { label: 'FACTURE', accent: ACCENT },
};

export function invoiceDocumentHtml(inv: InvoiceDetail, co: DossierProfile, currency: string): string {
  const m = (n: number) => fmtMoney(n, currency);
  const meta = META[inv.doc_type] ?? META.invoice;
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
