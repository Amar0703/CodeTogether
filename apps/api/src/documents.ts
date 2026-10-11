import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { documents, files, rooms, type Database } from '@codetogether/db';
import { MAX_DOCUMENT_BYTES, type Role } from '@codetogether/contracts';
import { RealtimeError } from './realtime.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const encode = (data: Uint8Array) => Buffer.from(data).toString('base64');

/** No hot document cache: each bounded candidate lives only until its transaction completes.
 * Snapshots compact every accepted update, retaining CRDT IDs for offline clients. */
export class DocumentStore {
  private active = 0;
  constructor(private db: Database) {}
  async sync(
    roomId: string,
    fileId: string,
    input: { vector?: string; update?: string },
    authorize: (tx: Tx) => Promise<Role>,
  ) {
    if (this.active >= 8)
      throw new RealtimeError('UNAVAILABLE', 'Document service busy. Retry shortly.', 503);
    this.active++;
    const doc = new Y.Doc();
    const text = doc.getText('content');
    try {
      return await this.db.transaction(async (tx) => {
        await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).for('update');
        const role = await authorize(tx);
        if (input.update !== undefined && role === 'VIEWER')
          throw new RealtimeError(
            'FORBIDDEN',
            'Viewer access is read-only. Download any local work.',
          );
        const [file] = await tx
          .select()
          .from(files)
          .where(and(eq(files.id, fileId), eq(files.roomId, roomId), eq(files.kind, 'FILE')))
          .for('update');
        if (!file)
          throw new RealtimeError(
            'FILE_NOT_FOUND',
            'File was deleted or is unavailable. Download your local work.',
            404,
          );
        const [stored] = await tx.select().from(documents).where(eq(documents.fileId, fileId));
        if (stored) Y.applyUpdate(doc, Buffer.from(stored.state, 'base64'));
        else if (file.content) text.insert(0, file.content);
        const before = encode(Y.encodeStateAsUpdate(doc));
        let state: string;
        let update: string;
        try {
          if (input.update !== undefined) {
            const bytes = Buffer.from(input.update, 'base64');
            if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Update too large');
            // Decode first; reject pathological struct counts and non-text shared types.
            const decoded = Y.decodeUpdate(bytes);
            if (decoded.structs.length > 100_000) throw new Error('Too many structs');
            Y.applyUpdate(doc, bytes);
          }
          if (
            doc.share.size !== 1 ||
            text._map.size !== 0 ||
            text.length > 200_000 ||
            text
              .toDelta()
              .some(
                (part: { insert: unknown; attributes?: unknown }) =>
                  typeof part.insert !== 'string' || part.attributes,
              )
          )
            throw new Error('Only bounded plain text is supported');
          if (doc.store.pendingStructs || doc.store.pendingDs)
            throw new RealtimeError(
              'RESYNC_REQUIRED',
              'Missing dependencies. Resynchronize before retrying.',
            );
          state = encode(Y.encodeStateAsUpdate(doc));
          if (Buffer.byteLength(state, 'base64') > MAX_DOCUMENT_BYTES)
            throw new RealtimeError(
              'DOCUMENT_LIMIT',
              'Document history limit reached. Export your work to a new file.',
            );
          // Validate vectors before committing anything.
          update = encode(
            Y.encodeStateAsUpdate(
              doc,
              input.vector === undefined ? undefined : Buffer.from(input.vector, 'base64'),
            ),
          );
        } catch (err) {
          if (err instanceof RealtimeError) throw err;
          throw new RealtimeError('INVALID_DOCUMENT', 'Invalid or oversized document update.', 400);
        }
        const changed = state !== before;
        if (!stored) await tx.insert(documents).values({ fileId, state });
        else if (changed)
          await tx.update(documents).set({ state }).where(eq(documents.fileId, fileId));
        if (changed) {
          await tx
            .update(files)
            .set({ content: text.toString(), version: file.version + 1, updatedAt: new Date() })
            .where(eq(files.id, fileId));
          await tx.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, roomId));
        }
        return {
          update,
          vector: encode(Y.encodeStateVector(doc)),
          version: file.version + (changed ? 1 : 0),
          role,
        };
      });
    } finally {
      doc.destroy();
      this.active--;
    }
  }
}
