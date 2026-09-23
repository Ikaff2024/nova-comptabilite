import type { Client } from '../db.js';
import { storageMode, putObject, getObject } from '../storage/provider.js';

// ============================================================================
// Conservation des pièces justificatives. saveDocument stocke l'octet (base ou
// R2) et renvoie l'URL à mettre dans entries.document_url. getDocument relit.
// ============================================================================

// LISTE BLANCHE des pièces acceptées (constat NOVA-P1-04).
//
// Cette table ne servait qu'à nommer la clé de stockage : le type MIME déclaré
// par le client était enregistré tel quel, et restitué tel quel en `inline`.
// Un client du portail — qui a le droit de DÉPOSER une pièce — pouvait donc
// téléverser un text/html piégé ; un collaborateur l'ouvrait, et le script
// s'exécutait sur l'origine de l'application, où le jeton de session est stocké.
//
// C'est désormais une vraie liste blanche, et l'appartenance est vérifiée sur
// les PREMIERS OCTETS du fichier, pas sur ce que le client annonce. Un
// justificatif comptable est une photo ou un PDF : il n'y a aucune raison
// d'accepter autre chose.
export const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'application/pdf': 'pdf',
};

/**
 * Type réellement contenu dans le fichier, d'après sa signature binaire.
 * Renvoie null si les octets ne correspondent à aucun format attendu.
 *
 * On ne fait pas confiance au type déclaré : c'est une chaîne que l'appelant
 * choisit librement, et tout le défaut tenait à ce qu'on la reprenne telle
 * quelle jusqu'à la restitution.
 */
export function typeReel(buf: Buffer): string | null {
  const a = (...o: number[]) => o.every((v, i) => buf[i] === v);
  if (a(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (a(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (a(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';                      // %PDF
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // HEIC : boîte ISO-BMFF « ftyp » suivie d'une marque heic/heix/hevc/mif1.
  if (buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
      && /^(heic|heix|hevc|hevx|mif1|msf1)/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}

export interface SaveDocInput {
  mimeType: string;
  dataBase64: string;
  filename?: string;
  entryId?: string;
}

export async function saveDocument(
  c: Client, dossierId: string, input: SaveDocInput, userId?: string,
): Promise<{ id: string; url: string; storage: string; size: number }> {
  const buf = Buffer.from(input.dataBase64, 'base64');
  if (buf.length === 0) throw new Error('Document vide.');
  if (buf.length > 15 * 1024 * 1024) throw new Error('Document trop volumineux (15 Mo max).');

  // Le type retenu est celui des OCTETS, jamais celui annoncé par le client.
  const reel = typeReel(buf);
  if (!reel) {
    const e: any = new Error(
      'Format de pièce non reconnu. Les justificatifs acceptés sont les photos '
      + '(JPEG, PNG, WebP, HEIC) et les PDF.');
    e.code = 'FORMAT_REFUSE';
    throw e;
  }
  const mimeType = reel;
  const mode = storageMode();

  const { rows } = await c.query(
    `insert into documents(dossier_id, entry_id, filename, mime_type, size_bytes, storage, created_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [dossierId, input.entryId ?? null, input.filename ?? null, mimeType, buf.length, mode, userId ?? null],
  );
  const id = rows[0].id;

  if (mode === 'r2') {
    const key = `${dossierId}/${id}.${EXT[mimeType]}`;
    await putObject(key, mimeType, buf);
    await c.query('update documents set storage_key=$2 where id=$1', [id, key]);
  } else {
    await c.query('insert into document_blobs(document_id, dossier_id, data) values ($1,$2,$3)', [id, dossierId, buf]);
  }

  return { id, url: `/api/dossiers/${dossierId}/documents/${id}`, storage: mode, size: buf.length };
}

// Liste des pièces d'un dossier (métadonnées, sans le binaire).
export async function listDocuments(c: Client, dossierId: string): Promise<any[]> {
  const { rows } = await c.query(
    `select id, filename, mime_type, size_bytes, entry_id, to_char(created_at,'YYYY-MM-DD HH24:MI') as created_at
       from documents where dossier_id=$1 order by created_at desc`, [dossierId]);
  return rows.map((r: any) => ({
    id: r.id, filename: r.filename, mimeType: r.mime_type, size: Number(r.size_bytes),
    entryId: r.entry_id, createdAt: r.created_at, url: `/api/dossiers/${dossierId}/documents/${r.id}`,
  }));
}

export async function getDocument(
  c: Client, dossierId: string, id: string,
): Promise<{ mime: string; filename: string | null; buffer: Buffer }> {
  const { rows } = await c.query(
    'select mime_type, filename, storage, storage_key from documents where dossier_id=$1 and id=$2', [dossierId, id]);
  const d = rows[0];
  if (!d) throw new Error('Pièce introuvable.');

  let buffer: Buffer;
  if (d.storage === 'r2') {
    if (!d.storage_key) throw new Error('Pièce R2 sans clé.');
    buffer = await getObject(d.storage_key);
  } else {
    const { rows: br } = await c.query('select data from document_blobs where document_id=$1', [id]);
    if (!br[0]) throw new Error('Contenu de la pièce introuvable.');
    buffer = br[0].data as Buffer;
  }
  return { mime: d.mime_type, filename: d.filename, buffer };
}

// Rattache une pièce à une écriture (après comptabilisation).
export async function attachToEntry(c: Client, dossierId: string, documentId: string, entryId: string): Promise<void> {
  await c.query('update documents set entry_id=$3 where dossier_id=$1 and id=$2', [dossierId, documentId, entryId]);
}
