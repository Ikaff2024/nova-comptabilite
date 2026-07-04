-- =============================================================================
-- Nova Comptabilité — 0020 : Devis & avoirs (cycle de vente)
-- =============================================================================
-- La table invoices porte désormais un type de document :
--   'invoice'      : facture de vente (411 / 70x / 443)
--   'quote'        : devis (aucune écriture ; se convertit en facture)
--   'credit_note'  : avoir / facture rectificative (écriture inverse)
-- source_document_id relie l'avoir à sa facture, ou la facture à son devis.
-- =============================================================================

alter type invoice_status add value if not exists 'converted';  -- devis converti en facture

alter table invoices
  add column doc_type text not null default 'invoice'
    check (doc_type in ('invoice', 'quote', 'credit_note')),
  add column source_document_id uuid references invoices(id) on delete set null;

create index idx_invoices_doc_type on invoices(dossier_id, doc_type, status);
