import type { Client } from '../db.js';
import { storageMode, putObject, getObject } from '../storage/provider.js';

// ============================================================================
// Conservation des pièces justificatives. saveDocument stocke l'octet (base ou
// R2) et renvoie l'URL à mettre dans entries.document_url. getDocument relit.
// ============================================================================

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'application/pdf': 'pdf',
};

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
  const mode = storageMode();

  const { rows } = await c.query(
    `insert into documents(dossier_id, entry_id, filename, mime_type, size_bytes, storage, created_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [dossierId, input.entryId ?? null, input.filename ?? null, input.mimeType, buf.length, mode, userId ?? null],
  );
  const id = rows[0].id;

  if (mode === 'r2') {
    const key = `${dossierId}/${id}.${EXT[input.mimeType] ?? 'bin'}`;
    await putObject(key, input.mimeType, buf);
    await c.query('update documents set storage_key=$2 where id=$1', [id, key]);
  } else {
    await c.query('insert into document_blobs(document_id, dossier_id, data) values ($1,$2,$3)', [id, dossierId, buf]);
  }

  return { id, url: `/api/dossiers/${dossierId}/documents/${id}`, storage: mode, size: buf.length };
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
