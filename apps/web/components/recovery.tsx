'use client';
import { useState } from 'react';
import * as Y from 'yjs';

/** Recovery only reads account-scoped browser storage. It never contacts a document endpoint. */
export function DraftRecovery({ accountId, roomId }: { accountId: string; roomId: string }) {
  const [drafts, setDrafts] = useState<{ id: string; text: string }[]>([]);
  const [message, setMessage] = useState('');
  async function load() {
    try {
      const prefix = `codetogether-v3:${accountId}:${roomId}:`;
      const databases = await indexedDB.databases();
      const result = await Promise.all(
        databases
          .filter((db) => db.name?.startsWith(prefix))
          .map(
            (db) =>
              new Promise<{ id: string; text: string }>((resolve, reject) => {
                const request = indexedDB.open(db.name!);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                  const connection = request.result;
                  const read = connection
                    .transaction('document')
                    .objectStore('document')
                    .get('state');
                  read.onerror = () => {
                    connection.close();
                    reject(read.error);
                  };
                  read.onsuccess = () => {
                    const doc = new Y.Doc();
                    try {
                      if (read.result) Y.applyUpdate(doc, read.result);
                      resolve({
                        id: db.name!.slice(prefix.length),
                        text: doc.getText('content').toString(),
                      });
                    } catch (error) {
                      reject(error);
                    } finally {
                      doc.destroy();
                      connection.close();
                    }
                  };
                };
              }),
          ),
      );
      setDrafts(result);
      setMessage(
        result.length
          ? 'Browser copies may include work not accepted by the server.'
          : 'No browser copies were found for this account and room.',
      );
    } catch {
      setMessage('Browser storage is unavailable. Download the open editor draft if available.');
    }
  }
  if (!accountId) return null;
  return (
    <div className="draft-recovery">
      <button className="button small" onClick={() => void load()}>
        Recover local drafts
      </button>
      {message && <p role="status">{message}</p>}
      {drafts.map((draft) => (
        <button
          key={draft.id}
          className="button small"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([draft.text], { type: 'text/plain' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `recovered-${draft.id}.txt`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download recovered {draft.id.slice(0, 8)}
        </button>
      ))}
    </div>
  );
}
