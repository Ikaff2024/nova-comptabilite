// ============================================================================
// Canal email sortant (pour les actions agentiques de Lexa : envoi de
// documents, relances, synthèses). Fournisseur : Resend (API HTTP simple).
// Activé par RESEND_API_KEY. Adresse d'expéditeur via EMAIL_FROM.
// ============================================================================

const apiKey = () => process.env.RESEND_API_KEY ?? '';
// Domaine de test Resend par défaut ; à remplacer par un expéditeur vérifié.
const from = () => process.env.EMAIL_FROM ?? 'Lexa (Nova) <onboarding@resend.dev>';

export function emailEnabled(): boolean {
  return !!apiKey();
}

export interface EmailInput { to: string; subject: string; html?: string; text?: string; replyTo?: string }

// Envoie un email. Renvoie { id } en cas de succès, lève une erreur sinon.
export async function sendEmail(input: EmailInput): Promise<{ id: string }> {
  if (!apiKey()) throw new Error("Canal email non configuré (RESEND_API_KEY absent).");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: from(), to: [input.to], subject: input.subject,
        html: input.html ?? undefined, text: input.text ?? (input.html ? undefined : ''),
        reply_to: input.replyTo ?? undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Échec de l'envoi (${res.status}) ${detail.slice(0, 180)}`);
    }
    const data: any = await res.json().catch(() => ({}));
    return { id: data?.id ?? 'sent' };
  } finally { clearTimeout(t); }
}
