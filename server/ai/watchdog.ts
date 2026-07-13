import { pool, withUser } from '../db.js';
import * as dash from '../domain/dossierdashboard.js';
import * as acc from '../domain/accounting.js';
import { upcomingDeadlines } from '../domain/fiscalcalendar.js';
import { whatsappEnabled, sendText } from '../whatsapp/provider.js';
import { telegramEnabled, sendMessage as sendTelegram } from '../telegram/provider.js';

// ============================================================================
// Agent nocturne : « Lexa qui bosse la nuit ». Calcule les points d'attention
// de chaque dossier (réutilise les alertes du tableau de bord) et pousse un
// digest par WhatsApp/Telegram aux chats reliés. Sans effet sur la compta ;
// s'il n'y a rien à signaler, aucun message n'est envoyé.
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
  let links = 0;
  let sent = 0;

  // Calcule le digest d'un dossier une fois, réutilisé pour les deux canaux.
  const digestFor = (userId: string, dossierId: string) => withUser(userId, async (c) => {
    const { rows } = await c.query('select to_jsonb(dd) as j from dossiers dd where id=$1', [dossierId]);
    const dj: any = rows[0]?.j ?? {};
    const d: any = await dash.dossierDashboard(c, dossierId);
    const alerts: Alert[] = [...(d.alerts ?? [])];
    // Échéances fiscales/sociales à ≤ 7 jours (veille).
    try {
      let fyEnd: string | null = null;
      const fys = await acc.listFiscalYears(c, dossierId);
      const openFy = fys.find((f: any) => f.status && f.status !== 'closed') ?? fys[fys.length - 1];
      fyEnd = openFy?.end_date ?? null;
      for (const dl of upcomingDeadlines({ regimeFiscal: dj.regime_fiscal, accountingSystem: dj.accounting_system, fiscalYearEnd: fyEnd, horizonDays: 7 })) {
        alerts.push({ level: 'warn', message: `Échéance ${dl.dueDate} : ${dl.label}` });
      }
    } catch { /* ignore */ }
    return buildDigest(alerts, dj.raison_sociale ?? 'votre dossier');
  });

  // --- WhatsApp ---
  if (whatsappEnabled()) {
    const { rows } = await pool.query('select phone, user_id, dossier_id from whatsapp_links');
    links += rows.length;
    for (const l of rows) {
      try { const digest = await digestFor(l.user_id, l.dossier_id); if (digest) { await sendText(l.phone, digest); sent++; } }
      catch { /* best-effort par lien */ }
    }
  }

  // --- Telegram (chats reliés uniquement) ---
  if (telegramEnabled()) {
    const { rows } = await pool.query('select chat_id, user_id, dossier_id from telegram_links where chat_id is not null');
    links += rows.length;
    for (const l of rows) {
      try {
        const digest = await digestFor(l.user_id, l.dossier_id);
        if (digest) { await sendTelegram(l.chat_id, digest.replace(/\*/g, '')); sent++; } // Telegram : pas de markdown *gras*
      } catch { /* best-effort par lien */ }
    }
  }

  return { links, sent };
}

// Calcule les points d'attention d'un dossier (pour affichage/à la demande).
export async function computeAlerts(dossierId: string, userId: string): Promise<Alert[]> {
  return withUser(userId, async (c) => {
    const d: any = await dash.dossierDashboard(c, dossierId);
    return d.alerts ?? [];
  });
}
