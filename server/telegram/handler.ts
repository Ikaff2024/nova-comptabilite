import { withUser } from '../db.js';
import * as tg from '../domain/telegram.js';
import * as agent from '../ai/agent.js';
import { sendMessage, type TelegramUpdate } from './provider.js';

// ============================================================================
// Routage des messages Telegram. Chat non relié -> liaison par code ; chat
// relié -> Lexa (avec continuité de conversation, dans le périmètre RLS de
// l'utilisateur relié).
// ============================================================================

export async function handleUpdate(up: TelegramUpdate): Promise<void> {
  const text = (up.text ?? '').trim();
  try {
    const link = await tg.resolveChat(up.chatId);

    if (!link) {
      // Tente une liaison : le message est un code (éventuellement via /start CODE).
      const code = text.replace(/^\/start\s*/i, '').trim();
      if (code) {
        const linked = await tg.linkByCode(code, up.chatId);
        if (linked) {
          const name = await withUser(linked.userId, async (c) => {
            const { rows } = await c.query('select raison_sociale from dossiers where id=$1', [linked.dossierId]);
            return rows[0]?.raison_sociale ?? 'votre dossier';
          });
          await sendMessage(up.chatId, `✅ Ce chat est relié à « ${name} ». Je suis Lexa, votre comptable IA — posez-moi vos questions !`);
          return;
        }
      }
      await sendMessage(up.chatId, 'Bonjour ! Pour relier ce chat à votre dossier, envoyez-moi le code affiché dans Nova (onglet Lexa → Telegram).');
      return;
    }

    if (!text || text.startsWith('/start')) {
      await sendMessage(up.chatId, 'Je vous écoute — posez votre question comptable (trésorerie, créances, TVA, résultat…).');
      return;
    }

    const reply = await withUser(link.userId, async (c) => {
      const history = await agent.loadHistory(c, link.dossierId, link.userId, 12);
      const r = await agent.runAgent(c, link.dossierId, [...history, { role: 'user', content: text }]);
      await agent.saveTurns(c, link.dossierId, link.userId, [{ role: 'user', content: text }, { role: 'assistant', content: r.reply }]);
      return r.reply;
    });
    await sendMessage(up.chatId, reply);
  } catch {
    try { await sendMessage(up.chatId, 'Désolé, une erreur est survenue. Réessayez dans un instant.'); } catch { /* ignore */ }
  }
}
