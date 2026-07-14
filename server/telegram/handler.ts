import { withUser } from '../db.js';
import * as tg from '../domain/telegram.js';
import * as agent from '../ai/agent.js';
import * as usage from '../domain/usage.js';
import { sendMessage, downloadFile, type TelegramUpdate } from './provider.js';
import { transcribeAudio } from '../ai/transcribe.js';
import { mdToPlain } from '../textfmt.js';

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

    // Message effectif : texte, ou transcription d'une note vocale.
    let message = text;
    let fromVoice = false;
    if (!message && up.voiceFileId) {
      const audio = await downloadFile(up.voiceFileId);
      const transcript = audio ? await transcribeAudio(audio) : null;
      if (!transcript) { await sendMessage(up.chatId, "Je n'ai pas pu transcrire ta note vocale — réessaie ou écris-moi ? 🎤"); return; }
      message = transcript; fromVoice = true;
    }

    if (!message || message.startsWith('/start')) {
      await sendMessage(up.chatId, 'Je t\'écoute — pose ta question comptable (trésorerie, créances, TVA, résultat…), à l\'écrit ou en note vocale. 🎤');
      return;
    }

    const reply = await withUser(link.userId, async (c) => {
      if (fromVoice) await usage.recordUsage(c, link.dossierId, 'whisper', 'whisper-1', { units: up.voiceDuration ?? 0 });
      const history = await agent.loadHistory(c, link.dossierId, link.userId, 12);
      const r = await agent.runAgent(c, link.dossierId, [...history, { role: 'user', content: message }]);
      await agent.saveTurns(c, link.dossierId, link.userId, [{ role: 'user', content: message }, { role: 'assistant', content: r.reply }]);
      return r.reply;
    });
    // Sur note vocale, confirme ce qui a été compris (les STT peuvent se tromper).
    const out = fromVoice ? `🎤 J'ai compris : « ${message} »\n\n${mdToPlain(reply)}` : mdToPlain(reply);
    await sendMessage(up.chatId, out);
  } catch {
    try { await sendMessage(up.chatId, 'Désolé, une erreur est survenue. Réessayez dans un instant.'); } catch { /* ignore */ }
  }
}
