import { pool, withUser } from '../db.js';
import * as dash from '../domain/dossierdashboard.js';
import { whatsappEnabled, sendText } from '../whatsapp/provider.js';

// ============================================================================
// Agent nocturne : « Lexa qui bosse la nuit ». Calcule les points d'attention
// de chaque dossier (réutilise les alertes du tableau de bord) et pousse un
// digest par WhatsApp aux numéros reliés. Sans effet sur la compta ; s'il n'y
// a rien à signaler, aucun message n'est envoyé.
// ============================================================================

export interface Alert { level: 'info' | 'warn'; message: string; tab?: string }

// Construit le texte du digest (null s'il n'y a rien à signaler).
export function buildDigest(alerts: Alert[], dossierName: string): string | null {
  if (!alerts || alerts.length === 0) return null;
  const lines = alerts.slice(0, 6).map((a) => `${a.level === 'warn' ? '⚠️' : 'ℹ️'} ${a.message}`).join('\n');
  return `Bonjour 👋 Votre point du jour — *${dossierName}* :\n\n${lines}\n\nRépondez-moi si vous voulez que je creuse l'un de ces points.\n— Lexa`;
}

// Pousse le digest quotidien aux numéros WhatsApp reliés (dans le périmètre RLS
// de l'utilisateur relié). No-op si WhatsApp n'est pas configuré.
export async function runDailyPush(): Promise<{ links: number; sent: number }> {
  if (!whatsappEnabled()) return { links: 0, sent: 0 };
  const { rows: links } = await pool.query('select phone, user_id, dossier_id from whatsapp_links');
  let sent = 0;
  for (const l of links) {
    try {
      const digest = await withUser(l.user_id, async (c) => {
        const { rows } = await c.query('select raison_sociale from dossiers where id=$1', [l.dossier_id]);
        const d: any = await dash.dossierDashboard(c, l.dossier_id);
        return buildDigest(d.alerts ?? [], rows[0]?.raison_sociale ?? 'votre dossier');
      });
      if (digest) { await sendText(l.phone, digest); sent++; }
    } catch { /* best-effort par lien */ }
  }
  return { links: links.length, sent };
}

// Calcule les points d'attention d'un dossier (pour affichage/à la demande).
export async function computeAlerts(dossierId: string, userId: string): Promise<Alert[]> {
  return withUser(userId, async (c) => {
    const d: any = await dash.dossierDashboard(c, dossierId);
    return d.alerts ?? [];
  });
}
