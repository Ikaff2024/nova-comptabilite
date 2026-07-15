import type { Client } from '../db.js';
import { tableExists } from '../schema-cache.js';

// ============================================================================
// Catalogue des articles/services vendus. Enregistré en amont (désignation,
// prix HT, TVA, compte de produit), il pré-remplit les lignes de facture de
// vente : saisie plus rapide et imputation cohérente. Lecture seule côté
// comptabilité (ne poste aucune écriture) — c'est un référentiel de vente.
// ============================================================================

export interface CatalogItemInput {
  kind?: 'bien' | 'service';
  reference?: string;
  label: string;
  unit?: string;
  unitPrice?: number;
  vatRate?: number;
  accountCode?: string;
  active?: boolean;
}

const SELECT = `id, kind, reference, label, unit, unit_price, vat_rate, account_code, active`;
const mapRow = (r: any) => ({ ...r, unit_price: Number(r.unit_price), vat_rate: Number(r.vat_rate) });

export async function listCatalog(c: Client, dossierId: string, includeInactive = false): Promise<any[]> {
  if (!(await tableExists('catalog_items'))) return []; // schéma en retard : catalogue vide
  const { rows } = await c.query(
    `select ${SELECT} from catalog_items where dossier_id=$1 ${includeInactive ? '' : 'and active'}
      order by active desc, label`, [dossierId]);
  return rows.map(mapRow);
}

// Compte de produit par défaut selon la nature (ventes de marchandises 701,
// prestations de services 706) si l'utilisateur n'en fournit pas.
function defaultAccount(kind: string | undefined, provided?: string): string {
  const code = (provided ?? '').trim();
  if (code) return code;
  return kind === 'service' ? '706' : '701';
}

export async function createCatalogItem(c: Client, dossierId: string, input: CatalogItemInput): Promise<{ id: string }> {
  if (!(await tableExists('catalog_items'))) throw new Error('Le catalogue n\'est pas encore disponible (mise à jour de la base requise).');
  if (!input.label?.trim()) throw new Error('Désignation requise');
  const kind = input.kind === 'service' ? 'service' : 'bien';
  const { rows } = await c.query(
    `insert into catalog_items(dossier_id, kind, reference, label, unit, unit_price, vat_rate, account_code, active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,true)) returning id`,
    [dossierId, kind, input.reference?.trim() || null, input.label.trim(), input.unit?.trim() || null,
     Number(input.unitPrice ?? 0), Number(input.vatRate ?? 0.18), defaultAccount(kind, input.accountCode),
     input.active ?? true],
  );
  return { id: rows[0].id };
}

export async function updateCatalogItem(c: Client, dossierId: string, id: string, input: CatalogItemInput): Promise<void> {
  const { rows } = await c.query('select kind from catalog_items where dossier_id=$1 and id=$2', [dossierId, id]);
  if (!rows[0]) throw new Error('Article introuvable');
  const kind = input.kind === 'service' || input.kind === 'bien' ? input.kind : rows[0].kind;
  await c.query(
    `update catalog_items set kind=$3, reference=$4, label=coalesce($5,label), unit=$6,
            unit_price=coalesce($7,unit_price), vat_rate=coalesce($8,vat_rate),
            account_code=coalesce($9,account_code), active=coalesce($10,active)
      where dossier_id=$1 and id=$2`,
    [dossierId, id, kind, input.reference?.trim() || null, input.label?.trim() || null, input.unit?.trim() || null,
     input.unitPrice == null ? null : Number(input.unitPrice), input.vatRate == null ? null : Number(input.vatRate),
     input.accountCode?.trim() || null, input.active == null ? null : input.active],
  );
}

export async function deleteCatalogItem(c: Client, dossierId: string, id: string): Promise<void> {
  await c.query('delete from catalog_items where dossier_id=$1 and id=$2', [dossierId, id]);
}

// Données de démonstration : articles/services réalistes (commerce de textile
// + prestations), avec prix, TVA et comptes de produit cohérents.
export async function seedDemoCatalog(c: Client, dossierId: string): Promise<void> {
  if (!(await tableExists('catalog_items'))) return; // schéma en retard : on saute le seed
  const { rows } = await c.query('select count(*)::int as n from catalog_items where dossier_id=$1', [dossierId]);
  if (rows[0].n > 0) return;
  const items: CatalogItemInput[] = [
    { kind: 'bien', reference: 'WAX-6Y', label: 'Pagne wax hollandais (6 yards)', unit: 'pièce', unitPrice: 25000, vatRate: 0.18, accountCode: '701' },
    { kind: 'bien', reference: 'WAX-FANCY', label: 'Pagne fancy (6 yards)', unit: 'pièce', unitPrice: 12000, vatRate: 0.18, accountCode: '701' },
    { kind: 'bien', reference: 'KENTE', label: 'Étole kenté tissée', unit: 'pièce', unitPrice: 45000, vatRate: 0.18, accountCode: '701' },
    { kind: 'bien', reference: 'BAZIN', label: 'Bazin riche (5 mètres)', unit: 'coupon', unitPrice: 35000, vatRate: 0.18, accountCode: '701' },
    { kind: 'service', reference: 'COUT-SM', label: 'Confection sur mesure — ensemble', unit: 'prestation', unitPrice: 20000, vatRate: 0.18, accountCode: '706' },
    { kind: 'service', reference: 'RETOUCHE', label: 'Retouche / ajustement', unit: 'prestation', unitPrice: 5000, vatRate: 0.18, accountCode: '706' },
    { kind: 'service', reference: 'LIVR', label: 'Livraison Abidjan', unit: 'course', unitPrice: 3000, vatRate: 0.18, accountCode: '706' },
  ];
  for (const it of items) await createCatalogItem(c, dossierId, it);
}
