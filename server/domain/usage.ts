import type { Client } from '../db.js';

// ============================================================================
// Métrage des coûts d'API par dossier. Enregistrement best-effort (ne casse
// jamais le flux appelant) + agrégation pour la page propriétaire.
// Coûts estimés en USD (barèmes indicatifs, à ajuster).
// ============================================================================

// Barèmes USD (par token pour les LLM, par unité pour le reste).
function estimateCost(provider: string, model: string | null, inTok: number, outTok: number, units: number): number {
  const m = String(model ?? '');
  if (provider === 'anthropic') {
    const p = /haiku/i.test(m) ? { i: 1 / 1e6, o: 5 / 1e6 }
      : /sonnet/i.test(m) ? { i: 3 / 1e6, o: 15 / 1e6 }
      : { i: 5 / 1e6, o: 25 / 1e6 }; // opus par défaut
    return inTok * p.i + outTok * p.o;
  }
  if (provider === 'elevenlabs') return units * (0.10 / 1000);   // ~ /1000 caractères
  if (provider === 'openai_tts') return units * (0.015 / 1000);  // ~ /1000 caractères
  if (provider === 'whisper') return units * (0.006 / 60);       // ~ /minute (units = secondes)
  return 0; // resend / autres : négligeable
}

export async function recordUsage(
  c: Client, dossierId: string, provider: string, model: string | null,
  o: { inputTokens?: number; outputTokens?: number; units?: number } = {},
): Promise<void> {
  try {
    const inTok = Math.round(o.inputTokens ?? 0), outTok = Math.round(o.outputTokens ?? 0), units = o.units ?? 0;
    const cost = estimateCost(provider, model, inTok, outTok, units);
    await c.query(
      'insert into api_usage(dossier_id, provider, model, input_tokens, output_tokens, units, cost_usd) values ($1,$2,$3,$4,$5,$6,$7)',
      [dossierId, provider, model, inTok, outTok, units, cost]);
  } catch { /* best-effort : jamais bloquant, ni si la table n'existe pas encore */ }
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Lexa (IA)', elevenlabs: 'Voix (ElevenLabs)', openai_tts: 'Voix (OpenAI)', whisper: 'Transcription', resend: 'Email',
};

// Synthèse des coûts par dossier (dans le périmètre RLS) sur les N derniers jours.
export async function usageSummary(c: Client, days = 30): Promise<any> {
  const exists = await c.query("select to_regclass('public.api_usage') is not null as ok");
  if (exists.rows[0]?.ok !== true) return { days, dossiers: [], parProvider: [], total: { costUsd: 0, appels: 0 }, indisponible: true };

  const { rows } = await c.query(
    `select u.dossier_id, d.raison_sociale, u.provider,
            count(*)::int as appels, coalesce(sum(u.input_tokens),0)::bigint as tok_in,
            coalesce(sum(u.output_tokens),0)::bigint as tok_out, coalesce(sum(u.cost_usd),0) as cost
       from api_usage u join dossiers d on d.id = u.dossier_id
      where u.created_at >= now() - ($1 || ' days')::interval
      group by u.dossier_id, d.raison_sociale, u.provider`, [String(days)]);

  const byDossier = new Map<string, any>();
  const byProvider = new Map<string, { provider: string; label: string; cost: number; appels: number }>();
  let totalCost = 0, totalAppels = 0;
  for (const r of rows) {
    const cost = Number(r.cost); const appels = Number(r.appels);
    totalCost += cost; totalAppels += appels;
    let d = byDossier.get(r.dossier_id);
    if (!d) { d = { dossierId: r.dossier_id, raisonSociale: r.raison_sociale, costUsd: 0, appels: 0, providers: {} as Record<string, number> }; byDossier.set(r.dossier_id, d); }
    d.costUsd += cost; d.appels += appels; d.providers[r.provider] = (d.providers[r.provider] ?? 0) + cost;
    let p = byProvider.get(r.provider);
    if (!p) { p = { provider: r.provider, label: PROVIDER_LABEL[r.provider] ?? r.provider, cost: 0, appels: 0 }; byProvider.set(r.provider, p); }
    p.cost += cost; p.appels += appels;
  }
  const dossiers = [...byDossier.values()].map((d) => ({ ...d, costUsd: round4(d.costUsd) })).sort((a, b) => b.costUsd - a.costUsd);
  const parProvider = [...byProvider.values()].map((p) => ({ ...p, cost: round4(p.cost) })).sort((a, b) => b.cost - a.cost);
  return { days, dossiers, parProvider, total: { costUsd: round4(totalCost), appels: totalAppels } };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
