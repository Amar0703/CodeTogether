'use client';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import type { Socket } from 'socket.io-client';
import type {
  ClientEvents,
  ServerEvents,
  DocumentPeer,
  RealtimeResult,
  DocumentSync,
} from '@codetogether/contracts';

export const encode = (bytes: Uint8Array) => {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
};
export const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
type Client = Socket<ServerEvents, ClientEvents>;
export type DocumentStatus = { label: string; pending: boolean; ready: boolean; blocked: boolean };

export class CollaborativeDocument {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText('content');
  readonly awareness = new Awareness(this.doc);
  readonly undo = new Y.UndoManager(this.text, { trackedOrigins: new Set(), captureTimeout: 350 });
  private socket?: Client;
  private db?: IDBDatabase;
  private disposed = false;
  private blocked = false;
  private initialized = false;
  private joined = false;
  private writing = false;
  private revision = 0;
  private durable = new Y.Doc();
  private timer?: ReturnType<typeof setTimeout>;
  private cursorTimer?: ReturnType<typeof setTimeout>;
  private heartbeat: ReturnType<typeof setInterval>;
  private epoch = 0;
  private awarenessClock = 0;
  private role = 'VIEWER';
  private storageFailed = false;
  private localReady: Promise<void>;
  constructor(
    readonly roomId: string,
    readonly fileId: string,
    readonly accountId: string,
    private report: (status: DocumentStatus, text: string) => void,
  ) {
    // A single snapshot per account/room/file. Read+merge+put is one serialized IDB transaction,
    // so separate tabs cannot overwrite one another's offline updates.
    this.localReady = new Promise<void>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(`codetogether-v3:${accountId}:${roomId}:${fileId}`, 1);
      } catch {
        this.storageFailed = true;
        resolve();
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore('document');
      request.onerror = () => {
        this.storageFailed = true;
        resolve();
      };
      request.onsuccess = () => {
        if (this.disposed) {
          request.result.close();
          resolve();
          return;
        }
        this.db = request.result;
        const tx = this.db.transaction('document', 'readonly');
        const read = tx.objectStore('document').get('state');
        read.onsuccess = () => {
          if (read.result) {
            try {
              Y.applyUpdate(this.doc, read.result, 'restore');
              this.initialized = true;
            } catch {
              this.storageFailed = true;
            }
          }
        };
        tx.oncomplete = () => {
          this.notify('Connecting…', true);
          resolve();
        };
        tx.onabort = () => {
          this.storageFailed = true;
          resolve();
        };
      };
    });
    this.doc.on('update', this.changed);
    this.awareness.on('update', this.cursorChanged);
    this.heartbeat = setInterval(this.sendCursor, 15_000);
  }
  private notify(label: string, pending: boolean) {
    if (!this.disposed)
      this.report(
        {
          label: this.storageFailed
            ? `${label} · browser backup unavailable; download before leaving`
            : label,
          pending,
          ready: this.initialized,
          blocked: this.blocked,
        },
        this.text.toString(),
      );
  }
  private backup() {
    if (!this.db || this.disposed) return;
    const state = Y.encodeStateAsUpdate(this.doc);
    try {
      const tx = this.db.transaction('document', 'readwrite');
      const store = tx.objectStore('document');
      const read = store.get('state');
      read.onsuccess = () => {
        try {
          const merged = read.result ? Y.mergeUpdates([read.result, state]) : state;
          if (merged.byteLength > 2_097_152) throw new Error('Local history limit');
          store.put(merged, 'state');
        } catch {
          tx.abort();
        }
      };
      tx.onabort = () => {
        this.storageFailed = true;
        this.notify('Local backup failed; download your work', true);
      };
    } catch {
      this.storageFailed = true;
    }
  }
  private changed = (_update: Uint8Array, origin: unknown) => {
    if (origin !== 'restore') this.backup();
    if (origin === 'server') {
      this.notify(this.joined ? 'Syncing…' : 'Connecting…', true);
      return;
    }
    this.revision++;
    this.notify(
      this.blocked
        ? 'Sync stopped · download your draft'
        : this.joined
          ? 'Saving…'
          : 'Offline · changes pending',
      true,
    );
    this.schedule();
  };
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 200);
  }
  connect(socket: Client | null, connected: boolean) {
    if (this.blocked || this.disposed) return;
    this.detach();
    if (!socket || !connected) return;
    this.socket = socket;
    socket.on('doc:update', this.remote);
    socket.on('doc:awareness', this.peers);
    socket.on('doc:revoked', this.revoked);
    socket.on('disconnect', this.disconnected);
    void this.sync();
  }
  private async sync() {
    await this.localReady;
    const socket = this.socket,
      epoch = ++this.epoch;
    if (!socket?.connected || this.disposed || this.blocked) return;
    this.joined = false;
    this.notify('Syncing…', true);
    // Ask for missing durable state, not local pending structs. This also reconciles deletion
    // sets, which cannot be inferred from a state vector alone.
    socket.timeout(10_000).emit(
      'doc:join',
      {
        roomId: this.roomId,
        fileId: this.fileId,
        clientId: this.doc.clientID,
        vector: encode(Y.encodeStateVector(this.durable)),
      },
      (err, result) => {
        if (epoch !== this.epoch || this.disposed) return;
        if (err || !result?.ok) {
          this.failure(result);
          return;
        }
        if (result.data.userId !== this.accountId) {
          this.stop('Account changed · reload before synchronizing');
          return;
        }
        this.role = result.data.role;
        Y.applyUpdate(this.doc, decode(result.data.update), 'server');
        Y.applyUpdate(this.durable, decode(result.data.update));
        this.initialized = true;
        this.joined = true;
        this.backup();
        this.sendCursor();
        void this.flush();
      },
    );
  }
  private failure(result?: RealtimeResult<DocumentSync>) {
    if (
      result &&
      !result.ok &&
      !['UNAVAILABLE', 'RATE_LIMITED', 'RESYNC_REQUIRED'].includes(result.error.code)
    ) {
      this.stop(result.error.message);
    } else {
      this.joined = false;
      this.notify('Sync pending · retrying', true);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.sync(), 4000);
    }
  }
  async flush() {
    if (!this.joined || this.blocked || this.writing || !this.socket?.connected) return;
    if (this.isDurable()) {
      this.notify('Saved', false);
      return;
    }
    const update = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.durable));
    if (this.role === 'VIEWER') {
      this.stop('Read-only access · local work retained for download');
      return;
    }
    if (update.byteLength > 2_097_152 || this.text.length > 200_000) {
      this.stop('Document limit reached · download your work');
      return;
    }
    const revision = this.revision,
      epoch = this.epoch;
    this.writing = true;
    this.notify('Saving…', true);
    this.socket.timeout(10_000).emit(
      'doc:update',
      {
        roomId: this.roomId,
        fileId: this.fileId,
        update: encode(update),
        vector: encode(Y.encodeStateVector(this.doc)),
      },
      (err, result) => {
        if (epoch !== this.epoch || this.disposed) return;
        this.writing = false;
        if (err || !result?.ok) {
          this.failure(result);
          return;
        }
        Y.applyUpdate(this.doc, decode(result.data.update), 'server');
        Y.applyUpdate(this.durable, update);
        Y.applyUpdate(this.durable, decode(result.data.update));
        if (revision === this.revision) this.notify('Saved', false);
        else this.schedule();
      },
    );
  }
  private isDurable() {
    // Undo keeps deleted payloads alive locally. Compare GC-normalized state so those
    // payloads are not mistaken for unacknowledged edits after a role change/reload.
    const normalized = new Y.Doc();
    Y.applyUpdate(normalized, Y.encodeStateAsUpdate(this.doc));
    const same =
      encode(Y.encodeStateAsUpdate(normalized)) === encode(Y.encodeStateAsUpdate(this.durable));
    normalized.destroy();
    return same;
  }
  private remote = (data: { fileId: string; update: string }) => {
    if (data.fileId !== this.fileId || this.blocked) return;
    Y.applyUpdate(this.doc, decode(data.update), 'server');
    Y.applyUpdate(this.durable, decode(data.update));
    if (this.isDurable()) this.notify('Saved', false);
    else this.schedule();
  };
  private peers = (data: { fileId: string; peers: DocumentPeer[] }) => {
    if (data.fileId !== this.fileId || this.blocked) return;
    const peers = data.peers.filter((p) => p.clientId !== this.doc.clientID);
    const missing = [...this.awareness.getStates().keys()].filter(
      (id) => id !== this.doc.clientID && !peers.some((p) => p.clientId === id),
    );
    removeAwarenessStates(this.awareness, missing, 'server');
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, peers.length);
    for (const peer of peers) {
      encoding.writeVarUint(encoder, peer.clientId);
      encoding.writeVarUint(encoder, ++this.awarenessClock);
      encoding.writeVarString(encoder, JSON.stringify({ user: peer.user, cursor: peer.cursor }));
    }
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), 'server');
  };
  private cursorChanged = (_event: unknown, origin: unknown) => {
    if (this.disposed || origin === 'server' || this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      this.sendCursor();
    }, 100);
  };
  private sendCursor = () => {
    if (!this.joined || !this.socket?.connected || this.blocked) return;
    const cursor = this.awareness.getLocalState()?.cursor ?? null;
    this.socket
      .timeout(5000)
      .emit('doc:awareness', { roomId: this.roomId, fileId: this.fileId, cursor }, () => {});
  };
  private revoked = (data: { fileId: string; reason: string }) => {
    if (data.fileId === this.fileId) this.stop(data.reason);
  };
  stop(reason: string) {
    this.blocked = true;
    this.detach();
    this.notify(reason, true);
  }
  private disconnected = () => {
    this.epoch++;
    this.joined = false;
    this.writing = false;
    removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID),
      'server',
    );
    const pending = !this.isDurable();
    this.notify(pending ? 'Offline · changes pending' : 'Offline · server copy confirmed', pending);
  };
  private detach() {
    clearTimeout(this.timer);
    if (this.socket) {
      this.socket
        .off('doc:update', this.remote)
        .off('doc:awareness', this.peers)
        .off('doc:revoked', this.revoked)
        .off('disconnect', this.disconnected);
      if (this.socket.connected && this.joined)
        this.socket.emit('doc:leave', { roomId: this.roomId, fileId: this.fileId }, () => {});
    }
    this.socket = undefined;
    this.disconnected();
  }
  destroy() {
    this.disposed = true;
    this.detach();
    clearInterval(this.heartbeat);
    clearTimeout(this.cursorTimer);
    this.db?.close(); // Already queued IDB transactions complete before closing.
    this.undo.destroy();
    this.awareness.destroy();
    this.doc.destroy();
    this.durable.destroy();
  }
}
