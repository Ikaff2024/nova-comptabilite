import { withUser } from '../db.js';
import * as wa from '../domain/whatsapp.js';
import * as agent from '../ai/agent.js';
import { sendText, type InboundMessage } from './provider.js';

// ============================================================================
// Routage des messages WhatsApp entrants. Texte -> agent (dans le périmètre RLS
// de l'utilisateur relié) ; média -> accusé (capture par photo à venir).
// Chaque message est traité indépendamment (pas d'historique multi-tours en v1).
// ============================================================================

export async function handleInbound(messages: InboundMessage[]): Promise<void> {
  for (const m of messages) {
    try {
      const link = await wa.resolvePhone(m.from);
      if (!link) {
        await sendText(m.from, 'Ce numéro n\'est pas encore relié à un dossier Nova. Reliez-le depuis l\'onglet « Assistant » de votre dossier, puis réessayez.');
        continue;
      }
      if (m.type === 'text' && m.text?.trim()) {
        const r = await withUser(link.userId, (c) => agent.runAgent(c, link.dossierId, [{ role: 'user', content: m.text!.trim() }]));
        await sendText(m.from, r.reply);
      } else if (m.type === 'image' || m.type === 'document') {
        await sendText(m.from, '📎 Pièce bien reçue. La comptabilisation par photo arrive très bientôt — en attendant, posez-moi vos questions par écrit, ou utilisez l\'onglet « Capture IA » dans l\'application.');
      } else {
        await sendText(m.from, 'Je traite pour l\'instant les messages texte. Posez votre question comptable et je vous réponds.');
      }
    } catch {
      try { await sendText(m.from, 'Désolé, une erreur est survenue. Réessayez dans un instant.'); } catch { /* ignore */ }
    }
  }
}
