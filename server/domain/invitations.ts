import crypto from 'node:crypto';
import type { Client } from '../db.js';
import { pool } from '../db.js';
import { sendEmail, emailEnabled } from '../email/provider.js';
import { addMember } from './users.js';

// ============================================================================
// Invitations de collaborateurs. Un seul geste côté cabinet : on saisit une
// adresse + un rôle.
//   • un compte Nova existe déjà  -> rattachement immédiat ;
//   • sinon -> invitation par email, la personne crée son compte via le lien et
//     se retrouve rattachée automatiquement (fonctions SECURITY DEFINER, le
//     destinataire n'étant pas authentifié quand il ouvre le lien).
// ============================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const appUrl = () => (process.env.APP_URL ?? 'https://app.nova-comptabilite.africa').replace(/\/$/, '');
const ROLE_LABEL: Record<string, string> = { owner: 'Propriétaire', associe: 'Associé (admin)', collaborateur: 'Collaborateur' };

export interface InviteResult { status: 'added' | 'invited'; email: string; role: string; }

// Rattache si le compte existe, sinon crée l'invitation et envoie le mail.
export async function inviteMember(
  c: Client, cabinetId: string, emailRaw: string, role: string, invitedBy?: string,
): Promise<InviteResult> {
  const email = String(emailRaw ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`Adresse email invalide : « ${emailRaw} ».`);
  const r = ['owner', 'associe', 'collaborateur'].includes(role) ? role : 'collaborateur';

  // Autorisation : réservé aux administrateurs (le rattachement direct est déjà
  // gardé par cabinet_member_add ; on garde aussi le chemin « invitation »).
  const { rows: mine } = await c.query(
    'select role from cabinet_members where cabinet_id=$1 and user_id=app_current_user_id()', [cabinetId]);
  const callerRole = mine[0]?.role;
  if (callerRole !== 'owner' && callerRole !== 'associe') {
    throw new Error('Réservé aux administrateurs du cabinet.');
  }

  // 1) Compte existant -> rattachement direct (cabinet_member_add contrôle que
  //    l'appelant est owner/associé du cabinet).
  const { rows: existing } = await c.query('select id from get_user_for_login($1)', [email]);
  if (existing[0]) {
    await addMember(c, cabinetId, email, r);
    return { status: 'added', email, role: r };
  }

  // 2) Sinon : invitation. Le contrôle de droits se fait via la RLS du cabinet
  //    (insert refusé si l'appelant n'est pas membre) + garde applicative.
  if (!emailEnabled()) {
    throw new Error("Aucun compte Nova avec cet email, et le canal email n'est pas configuré : impossible d'envoyer l'invitation.");
  }
  const { rows: cab } = await c.query('select name from cabinets where id=$1', [cabinetId]);
  const cabinetName = cab[0]?.name ?? 'votre organisation';

  const token = crypto.randomBytes(32).toString('hex');
  await c.query(
    `insert into cabinet_invitations(cabinet_id, email, role, token, created_by)
     values ($1,$2,$3::cabinet_role,$4,$5)
     on conflict (cabinet_id, lower(email)) where accepted_at is null
     do update set role = excluded.role, token = excluded.token,
                   created_at = now(), expires_at = now() + interval '14 days'`,
    [cabinetId, email, r, token, invitedBy ?? null]);

  const link = `${appUrl()}/?invite=${token}`;
  const html = `<p>Bonjour,</p>
    <p>Vous êtes invité(e) à rejoindre <strong>${escapeHtml(cabinetName)}</strong> sur <strong>Nova Comptabilité</strong>
       en tant que <strong>${ROLE_LABEL[r] ?? r}</strong>.</p>
    <p><a href="${link}" style="background:#059669;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Rejoindre ${escapeHtml(cabinetName)}</a></p>
    <p style="color:#555;font-size:13px">Ou copiez ce lien : <br/>${link}</p>
    <p style="color:#555;font-size:13px">Ce lien est personnel et expire dans 14 jours.</p>
    <p style="color:#888;font-size:12px">Nova Comptabilité — comptabilité SYSCOHADA &amp; paie.</p>`;

  await sendEmail({ to: email, subject: `Invitation à rejoindre ${cabinetName} sur Nova`, html });
  return { status: 'invited', email, role: r };
}

export async function listInvitations(c: Client, cabinetId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select id, email, role, to_char(created_at,'YYYY-MM-DD') as created_at,
            to_char(expires_at,'YYYY-MM-DD') as expires_at, (expires_at < now()) as expired
       from cabinet_invitations
      where cabinet_id=$1 and accepted_at is null
      order by created_at desc`, [cabinetId]);
  return rows;
}

export async function revokeInvitation(c: Client, cabinetId: string, id: string): Promise<void> {
  await c.query('delete from cabinet_invitations where cabinet_id=$1 and id=$2', [cabinetId, id]);
}

// --- Côté destinataire (non authentifié) : clés sur le token ----------------
export async function invitationInfo(token: string): Promise<{ email: string; role: string; cabinetName: string; expired: boolean; accepted: boolean } | null> {
  const { rows } = await pool.query('select * from invitation_info($1)', [String(token ?? '')]);
  const r = rows[0];
  if (!r) return null;
  return { email: r.email, role: r.role, cabinetName: r.cabinet_name, expired: r.expired, accepted: r.accepted };
}

// Rattache p_user_id au cabinet de l'invitation. Le user id vient TOUJOURS du
// serveur (compte fraîchement créé ou session vérifiée), jamais du client.
export async function acceptInvitation(token: string, userId: string): Promise<string> {
  const { rows } = await pool.query('select invitation_accept($1,$2) as cabinet_id', [String(token ?? ''), userId]);
  return rows[0]?.cabinet_id;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}
