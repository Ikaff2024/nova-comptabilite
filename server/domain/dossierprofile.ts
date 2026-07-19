import type { Client } from '../db.js';
import { recordAudit } from './audit.js';

// ============================================================================
// Fiche entreprise : identité légale, fiscale et coordonnées du dossier.
// Sert l'en-tête des bulletins de paie, les attestations, les courriers et les
// déclarations. Lecture tolérante au schéma (to_jsonb) ; écriture sur une
// LISTE BLANCHE de colonnes (jamais de nom de colonne venant du client).
// ============================================================================

// clé API (camelCase) -> colonne SQL
const FIELDS: Record<string, string> = {
  raisonSociale: 'raison_sociale',
  adresse: 'adresse',
  ville: 'ville',
  telephone: 'telephone',
  taxId: 'tax_id',
  rccm: 'rccm',
  numeroCnps: 'numero_cnps',
  formeJuridique: 'forme_juridique',
  regimeFiscal: 'regime_fiscal',
  bankName: 'bank_name',
  rib: 'rib',
};

export interface DossierProfile {
  raisonSociale: string; adresse: string | null; ville: string | null; telephone: string | null;
  taxId: string | null; rccm: string | null; numeroCnps: string | null;
  formeJuridique: string | null; regimeFiscal: string | null;
  bankName: string | null; rib: string | null;
  country: string; baseCurrency: string;
}

export async function getProfile(c: Client, dossierId: string): Promise<DossierProfile> {
  const { rows } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
  const d: any = rows[0]?.j;
  if (!d) throw new Error('Dossier introuvable.');
  return {
    raisonSociale: d.raison_sociale ?? '',
    adresse: d.adresse ?? null, ville: d.ville ?? null, telephone: d.telephone ?? null,
    taxId: d.tax_id ?? null, rccm: d.rccm ?? null, numeroCnps: d.numero_cnps ?? null,
    formeJuridique: d.forme_juridique ?? null, regimeFiscal: d.regime_fiscal ?? null,
    bankName: d.bank_name ?? null, rib: d.rib ?? null,
    country: d.country ?? 'CI', baseCurrency: d.base_currency ?? 'XOF',
  };
}

export async function updateProfile(c: Client, dossierId: string, input: Record<string, any>): Promise<DossierProfile> {
  const sets: string[] = [];
  const params: any[] = [dossierId];
  for (const [key, col] of Object.entries(FIELDS)) {
    if (!(key in input)) continue;
    const raw = input[key];
    const value = raw == null ? null : String(raw).trim() || null;
    if (key === 'raisonSociale') {
      if (!value || value.length < 2) throw new Error('La raison sociale doit comporter au moins 2 caractères.');
    }
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return getProfile(c, dossierId);

  await c.query(`update dossiers set ${sets.join(', ')} where id = $1`, params);
  await recordAudit(c, { dossierId, action: 'dossier.profile_updated', entity: 'dossier', entityId: dossierId, detail: { champs: Object.keys(input).filter((k) => k in FIELDS) } });
  return getProfile(c, dossierId);
}
