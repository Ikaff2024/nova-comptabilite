// ============================================================================
// Certification Facture Normalisée Électronique (FNE).
// Fournisseur abstrait : mode démo (stub) sans clé, ou API DGI si configurée.
// Brancher l'API réelle : FNE_API_URL + FNE_API_KEY (endpoint officiel du pays).
// ============================================================================

export interface FneInput {
  number: string; date: string; clientName: string; clientTaxId?: string | null;
  totalHt: number; totalTva: number; totalTtc: number; currency: string;
}
export interface FneResult { reference: string; qr: string; provider: string; }

export function fneProvider(): string {
  return process.env.FNE_API_URL && process.env.FNE_API_KEY ? 'dgi' : 'demo';
}

export async function certifyInvoice(input: FneInput): Promise<FneResult> {
  if (!(process.env.FNE_API_URL && process.env.FNE_API_KEY)) {
    // Mode démo : référence + charge QR simulées (à remplacer par la certification réelle).
    const reference = 'FNE-CI-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const qr = JSON.stringify({ ref: reference, num: input.number, ttc: input.totalTtc, tva: input.totalTva, date: input.date });
    return { reference, qr, provider: 'demo' };
  }
  // Mode réel : appel à l'API de facturation normalisée du pays.
  const res = await fetch(process.env.FNE_API_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.FNE_API_KEY}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`FNE indisponible (${res.status})`);
  const data: any = await res.json();
  return { reference: data.reference ?? data.ref, qr: data.qr ?? data.qrData ?? '', provider: 'dgi' };
}
