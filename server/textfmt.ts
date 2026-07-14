// Convertit le markdown de Lexa en texte propre pour les canaux qui ne le
// rendent pas (Telegram, WhatsApp) : retire titres/gras, normalise les puces.
export function mdToPlain(s: string): string {
  return (s || '')
    .replace(/^#{1,6}\s+/gm, '')            // titres ## ###
    .replace(/\*\*(.+?)\*\*/g, '$1')         // **gras**
    .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1$2') // *italique/gras simple*
    .replace(/`([^`]+)`/g, '$1')             // `code`
    .replace(/^\s*[-*]\s+/gm, '• ')          // puces - / *
    .replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + ' ') // listes numérotées : garde le numéro
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
