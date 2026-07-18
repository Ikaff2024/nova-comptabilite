import type { Client } from '../db.js';
import * as acc from '../domain/accounting.js';

// ============================================================================
// Intégration AuthNTIC — moteur de liasse fiscale SYSCOHADA « à la virgule près »
// (projet interne, https://app.authntic.africa). Nova reste le système comptable
// de référence ; AuthNTIC est appelé en API server-to-server comme MOTEUR de
// liasse (endpoint stateless POST /liasse/generate). Nova génère la balance N/N-1
// depuis sa propre comptabilité, AuthNTIC renvoie la liasse (PDF).
//
// Config (env) : AUTHNTIC_API_URL (base, ex. https://…/api/v1) + AUTHNTIC_SERVICE_KEY.
// Sans ces variables, la fonction est inerte (erreur explicite) — rien ne casse.
// ============================================================================

export function authnticEnabled(): boolean {
  return Boolean(process.env.AUTHNTIC_API_URL && process.env.AUTHNTIC_SERVICE_KEY);
}

const PAYS: Record<string, string> = {
  CI: "Côte d'Ivoire", SN: 'Sénégal', BJ: 'Bénin', BF: 'Burkina Faso', ML: 'Mali',
  TG: 'Togo', NE: 'Niger', GW: 'Guinée-Bissau', CM: 'Cameroun', GA: 'Gabon',
  CG: 'Congo', TD: 'Tchad', CF: 'Centrafrique', GQ: 'Guinée équatoriale', KM: 'Comores', GN: 'Guinée',
};

// Solde final → sens (débiteur/créditeur), pour les colonnes SD/SC d'AuthNTIC.
function sdSc(balance: number): { sd: number; sc: number } {
  return balance >= 0 ? { sd: balance, sc: 0 } : { sd: 0, sc: -balance };
}

// Construit le corps de requête AuthNTIC : identité + lignes de balance N/N-1.
export async function buildLiassePayload(c: Client, dossierId: string, fiscalYearId?: string): Promise<any> {
  const { rows: dr } = await c.query(
    'select raison_sociale, base_currency, tax_id, rccm, forme_juridique, country, fiscal_extra from dossiers where id=$1',
    [dossierId]);
  const d: any = dr[0];
  if (!d) throw new Error('Dossier introuvable.');

  const fys = await acc.listFiscalYears(c, dossierId); // triés par start_date asc
  let current = fiscalYearId ? fys.find((f: any) => f.id === fiscalYearId) : undefined;
  if (!current) current = fys.filter((f: any) => f.status !== 'closed')[0] ?? fys[fys.length - 1];
  if (!current) throw new Error('Aucun exercice disponible pour produire la liasse.');
  const idx = fys.findIndex((f: any) => f.id === current.id);
  const previous = idx > 0 ? fys[idx - 1] : null;

  const balN = await acc.trialBalance(c, dossierId, current.id);
  const balN1 = previous ? await acc.trialBalance(c, dossierId, previous.id) : [];

  // Fusion par compte : colonnes N depuis l'exercice courant, N-1 depuis le précédent.
  const map = new Map<string, any>();
  const blank = (compte: string, libelle: string) => ({
    compte, libelle,
    rand_n: 0, ranc_n: 0, mvtd_n: 0, mvtc_n: 0, sd_n: 0, sc_n: 0,
    rand_n1: 0, ranc_n1: 0, mvtd_n1: 0, mvtc_n1: 0, sd_n1: 0, sc_n1: 0,
  });
  for (const r of balN) {
    const l = map.get(r.account_code) ?? blank(r.account_code, r.account_label ?? '');
    const { sd, sc } = sdSc(r.balance);
    l.rand_n = r.open_debit; l.ranc_n = r.open_credit; l.mvtd_n = r.period_debit; l.mvtc_n = r.period_credit;
    l.sd_n = sd; l.sc_n = sc;
    map.set(r.account_code, l);
  }
  for (const r of balN1) {
    const l = map.get(r.account_code) ?? blank(r.account_code, r.account_label ?? '');
    const { sd, sc } = sdSc(r.balance);
    l.rand_n1 = r.open_debit; l.ranc_n1 = r.open_credit; l.mvtd_n1 = r.period_debit; l.mvtc_n1 = r.period_credit;
    l.sd_n1 = sd; l.sc_n1 = sc;
    map.set(r.account_code, l);
  }
  // AuthNTIC refuse les comptes non numériques (notice 1 SYSCOHADA) : on écarte
  // proprement les comptes alphanumériques éventuels plutôt que de faire échouer tout.
  const lignes = [...map.values()].filter((l) => /^\d+$/.test(String(l.compte).trim()));

  const annee = Number(String(current.end_date).slice(0, 4)) || new Date().getUTCFullYear();
  return {
    identite: {
      raison_sociale: d.raison_sociale ?? '',
      nif: d.tax_id ?? null,
      forme_juridique: d.forme_juridique ?? null,
      sigle: d.fiscal_extra?.sigle ?? null,
      ville: d.fiscal_extra?.ville ?? null,
      pays: PAYS[d.country] ?? d.country ?? null,
      devise: d.base_currency ?? 'XOF',
      annee,
      date_debut: current.start_date ?? null,
      date_fin: current.end_date ?? null,
    },
    lignes,
    _meta: { hasPrevious: !!previous, nbLignes: lignes.length, exerciceLabel: current.label },
  };
}

// Appelle le moteur AuthNTIC et renvoie le PDF de la liasse.
export async function generateLiassePdf(c: Client, dossierId: string, fiscalYearId?: string): Promise<{ filename: string; buffer: Buffer; count: number }> {
  const base = process.env.AUTHNTIC_API_URL;
  const key = process.env.AUTHNTIC_SERVICE_KEY;
  if (!base || !key) throw new Error("Intégration AuthNTIC non configurée (AUTHNTIC_API_URL / AUTHNTIC_SERVICE_KEY absents).");

  const payload = await buildLiassePayload(c, dossierId, fiscalYearId);
  if (!payload.lignes.length) throw new Error('Aucune écriture : balance vide, liasse impossible.');

  const url = `${base.replace(/\/$/, '')}/liasse/generate?format=pdf`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
      body: JSON.stringify({ identite: payload.identite, lignes: payload.lignes }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    throw new Error(`AuthNTIC injoignable : ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j: any = await res.json(); detail = j?.detail ?? detail; } catch { /* ignore */ }
    throw new Error(`AuthNTIC a refusé la génération : ${detail}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const nom = String(payload.identite.raison_sociale || 'entreprise').replace(/\s+/g, '_');
  return { filename: `liasse-syscohada-${nom}-${payload.identite.annee}.pdf`, buffer, count: payload.lignes.length };
}
