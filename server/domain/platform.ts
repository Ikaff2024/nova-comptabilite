import type { Client } from '../db.js';

// ============================================================================
// Console éditeur (opérateurs Nova) : vue transverse à tous les cabinets clients.
// S'appuie sur la fonction SECURITY DEFINER platform_cabinets(), qui est
// fail-closed (lève NOT_PLATFORM_ADMIN si l'appelant n'est pas opérateur).
// ============================================================================

export interface PlatformCabinet {
  cabinetId: string; name: string; country: string; createdAt: string;
  dossiers: number; membres: number; ecritures: number;
  cost30d: number; costTotal: number; lastActivity: string | null;
}

export async function platformOverview(c: Client): Promise<{
  cabinets: PlatformCabinet[];
  totals: { cabinets: number; dossiers: number; ecritures: number; cost30d: number; costTotal: number; actifs30j: number };
  generatedAt: string;
}> {
  const { rows } = await c.query('select * from platform_cabinets()');
  const cabinets: PlatformCabinet[] = rows.map((r: any) => ({
    cabinetId: r.cabinet_id, name: r.name, country: r.country, createdAt: r.created_at,
    dossiers: Number(r.dossiers), membres: Number(r.membres), ecritures: Number(r.ecritures),
    cost30d: Number(r.cost_30d), costTotal: Number(r.cost_total), lastActivity: r.last_activity,
  }));
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const totals = {
    cabinets: cabinets.length,
    dossiers: cabinets.reduce((s, x) => s + x.dossiers, 0),
    ecritures: cabinets.reduce((s, x) => s + x.ecritures, 0),
    cost30d: round4(cabinets.reduce((s, x) => s + x.cost30d, 0)),
    costTotal: round4(cabinets.reduce((s, x) => s + x.costTotal, 0)),
    actifs30j: cabinets.filter((x) => x.lastActivity && new Date(x.lastActivity).getTime() >= cutoff).length,
  };
  // Trie par activité récente (les plus vivants d'abord), inactifs en fin.
  cabinets.sort((a, b) => (b.lastActivity ? new Date(b.lastActivity).getTime() : 0) - (a.lastActivity ? new Date(a.lastActivity).getTime() : 0));
  return { cabinets, totals, generatedAt: new Date().toISOString() };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
