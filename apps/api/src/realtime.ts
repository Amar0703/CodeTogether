import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { ZodError, type z } from 'zod';
import { type Database, files, members, messages, rooms, sessions, users } from '@codetogether/db';
import {
  chatHistorySchema,
  chatSendSchema,
  roomSubscriptionSchema,
  tokenSchema,
  type Ack,
  type ChatMessage,
  type ClientEvents,
  type Presence,
  type RoomEvent,
  type ServerEvents,
  documentSchema,
  documentJoinSchema,
  documentUpdateSchema,
  documentAwarenessSchema,
  type DocumentPeer,
  callJoinSchema,
  callCancelSchema,
  callSessionSchema,
  callStateSchema,
  callSignalSchema,
  MAX_CALL_PARTICIPANTS,
  type CallParticipant,
  type CallSnapshot,
} from '@codetogether/contracts';
import { hashToken, token } from './security.js';
import { normalizeOrigin } from './origin.js';
import { DocumentStore } from './documents.js';
import { iceEnvironmentSchema, issueIce, type IceSettings } from './ice.js';
import { MeteredPool, MeteredUnavailableError } from './metered.js';

export class RealtimeError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 403,
  ) {
    super(message);
  }
}
type Identity = {
  userId: string;
  name: string;
  sessionHash: string;
  roomId?: string;
  cancelledCalls?: Set<string>;
  call?: {
    callId: string;
    joinId: string;
    seen: number;
    participant: CallParticipant;
    sequences: Map<string, number>;
  };
  document?: { fileId: string; clientId: number; cursor: DocumentPeer['cursor']; seen: number };
};
type RoomSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, Identity>;
type Store = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
const wireMessage = (row: typeof messages.$inferSelect): ChatMessage => ({
  id: row.id,
  sequence: row.sequence.toString(),
  roomId: row.roomId,
  clientMessageId: row.clientMessageId,
  sender: { id: row.userId, name: row.senderName },
  body: row.body,
  createdAt: row.createdAt.toISOString(),
});

/** One instance per API process. Database owns durable data; these maps are ephemeral. */
export class Realtime {
  private io?: Server<ClientEvents, ServerEvents, Record<string, never>, Identity>;
  private tickets = new Map<string, { sessionHash: string; expiresAt: number }>();
  private limits = new Map<string, { count: number; expiresAt: number }>();
  private locks = new Map<string, Promise<unknown>>();
  private queued = 0;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private calls = new Map<string, { id: string; revision: number }>();
  readonly origin: string;
  private documents: DocumentStore;
  private metered?: MeteredPool;
  constructor(
    private db: Database,
    origin: string,
    private options: {
      ticketTtlMs?: number;
      sweepMs?: number;
      pingInterval?: number;
      pingTimeout?: number;
      actionLimit?: number;
      iceSettings?: IceSettings;
      meteredTransport?: typeof fetch;
      meteredNow?: () => number;
      callLeaseMs?: number;
    } = {},
  ) {
    this.origin = normalizeOrigin(origin);
    this.documents = new DocumentStore(db);
    if (options.iceSettings?.METERED_SECRET_KEY) {
      this.metered = new MeteredPool(
        options.iceSettings,
        options.meteredTransport,
        options.meteredNow,
      );
      this.metered.start();
    }
  }

  // Also used by HTTP mutations: revocation, joins, sends and broadcasts cannot overtake each other.
  async withRoom<T>(roomId: string, action: () => Promise<T>): Promise<T> {
    if (this.queued >= 64)
      throw new RealtimeError('UNAVAILABLE', 'Room service busy. Retry shortly.', 503);
    this.queued++;
    const previous = this.locks.get(roomId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.locks.set(roomId, current);
    try {
      return await current;
    } finally {
      this.queued--;
      if (this.locks.get(roomId) === current) this.locks.delete(roomId);
    }
  }
  private rate(key: string, limit: number, windowMs = 60_000, amount = 1) {
    let bucket = this.limits.get(key);
    if (!bucket || bucket.expiresAt <= Date.now()) {
      bucket = { count: 0, expiresAt: Date.now() + windowMs };
      this.limits.set(key, bucket);
    }
    bucket.count += amount;
    if (bucket.count > limit)
      throw new RealtimeError('RATE_LIMITED', 'Too many events. Try again shortly.', 429);
  }
  async session(sessionHash: string, store: Store = this.db) {
    const [row] = await store
      .select({ userId: users.id, name: users.name })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sessionHash), gt(sessions.expiresAt, new Date())));
    if (!row)
      throw new RealtimeError('UNAUTHENTICATED', 'Your session has expired. Sign in again.', 401);
    return { ...row, sessionHash };
  }
  async ticket(sessionHash: string) {
    const identity = await this.session(sessionHash);
    this.rate(`ticket:${identity.userId}`, 30);
    this.prune();
    if (this.tickets.size >= 10_000)
      throw new RealtimeError('UNAVAILABLE', 'Please try again shortly.', 503);
    const value = token();
    const expiresAt = Date.now() + (this.options.ticketTtlMs ?? 30_000);
    this.tickets.set(hashToken(value), { sessionHash, expiresAt });
    return { ticket: value, expiresAt: new Date(expiresAt).toISOString() };
  }
  async ice(roomId: string, sessionHash: string) {
    return this.withRoom(roomId, async () => {
      const identity = await this.session(sessionHash);
      await this.membership(this.db, roomId, identity.userId);
      this.rate(`ice:${identity.userId}`, 12);
      if (this.metered) {
        try {
          return this.metered.take();
        } catch (error) {
          throw new RealtimeError(
            error instanceof MeteredUnavailableError ? error.code : 'MEDIA_UNAVAILABLE',
            error instanceof MeteredUnavailableError
              ? error.message
              : 'TURN is unavailable. Try joining again shortly.',
            503,
          );
        }
      }
      return issueIce(this.options.iceSettings ?? iceEnvironmentSchema.parse({}));
    });
  }
  private callSnapshot(roomId: string, sockets: RoomSocket[]): CallSnapshot | undefined {
    const call = this.calls.get(roomId);
    if (!call) return;
    const participants = sockets
      .filter((s) => s.data.call?.callId === call.id)
      .map((s) => s.data.call!.participant);
    const snapshot = { roomId, callId: call.id, revision: ++call.revision, participants };
    for (const s of sockets) s.emit('call:snapshot', snapshot);
    if (!participants.length) this.calls.delete(roomId);
    return snapshot;
  }
  revokeSession(sessionHash: string) {
    for (const [key, value] of this.tickets)
      if (value.sessionHash === sessionHash) this.tickets.delete(key);
    for (const socket of this.io?.sockets.sockets.values() ?? [])
      if (socket.data.sessionHash === sessionHash) socket.disconnect(true);
  }
  private prune() {
    for (const [key, value] of this.tickets)
      if (value.expiresAt <= Date.now()) this.tickets.delete(key);
    for (const [key, value] of this.limits)
      if (value.expiresAt <= Date.now()) this.limits.delete(key);
  }
  private async membership(store: Store, roomId: string, userId: string) {
    const [row] = await store
      .select()
      .from(members)
      .where(and(eq(members.roomId, roomId), eq(members.userId, userId)));
    if (!row)
      throw new RealtimeError('ROOM_NOT_FOUND', 'Room not found or access was removed.', 404);
    return row;
  }
  attach(server: HttpServer) {
    const io = (this.io = new Server(server, {
      transports: ['websocket'],
      maxHttpBufferSize: 2_840_000,
      pingInterval: this.options.pingInterval ?? 25_000,
      pingTimeout: this.options.pingTimeout ?? 20_000,
      // CORS alone does not protect WebSocket upgrades. Reject absent and foreign origins.
      allowRequest: (req, callback) => callback(null, req.headers.origin === this.origin),
      cors: { origin: this.origin, credentials: false },
      connectTimeout: 10_000,
    }));
    io.use(async (socket, next) => {
      try {
        this.rate(`handshake:${socket.handshake.address}`, 120);
        const value = tokenSchema.parse(socket.handshake.auth.ticket);
        const key = hashToken(value),
          ticket = this.tickets.get(key);
        this.tickets.delete(key); // Consume before awaiting: two concurrent handshakes cannot replay it.
        if (!ticket || ticket.expiresAt <= Date.now()) throw new Error('Invalid ticket');
        socket.data = await this.session(ticket.sessionHash);
        next();
      } catch {
        next(new Error('Socket authentication failed. Obtain a new ticket.'));
      }
    });
    io.on('connection', (socket) => {
      const count = [...io.sockets.sockets.values()].filter(
        (s) => s.data.userId === socket.data.userId,
      ).length;
      if (count > 10) {
        socket.disconnect(true);
        return;
      }
      // Includes unknown packets; limits are shared across this user's tabs.
      socket.use((packet, next) => {
        try {
          if (typeof packet[0] === 'string' && packet[0].startsWith('call:')) {
            this.rate(`callpackets:${socket.data.userId}`, 600);
            next();
            return;
          }
          const documentPacket = ['doc:join', 'doc:update', 'doc:leave', 'doc:awareness'].includes(
            packet[0],
          );
          this.rate(
            `${documentPacket ? 'docpackets' : 'packets'}:${socket.data.userId}`,
            this.options.actionLimit ?? (documentPacket ? 3000 : 120),
          );
          next();
        } catch {
          if (typeof packet[0] === 'string' && packet[0].startsWith('call:')) {
            const ack = packet.at(-1);
            if (typeof ack === 'function')
              ack({
                ok: false,
                error: {
                  code: 'RATE_LIMITED',
                  message: 'Call event limit reached. Leave and retry shortly.',
                },
              });
            return; // A media flood must not disconnect document/chat transport.
          }
          socket.disconnect(true);
        }
      });
      const handle = <T>(ack: Ack<T>, action: () => Promise<T>) => {
        if (typeof ack !== 'function') return;
        void action()
          .then((data) => ack({ ok: true, data }))
          .catch((err: unknown) => {
            const error =
              err instanceof RealtimeError
                ? err
                : err instanceof ZodError
                  ? new RealtimeError('VALIDATION_ERROR', 'Invalid event payload.', 400)
                  : new RealtimeError(
                      'UNAVAILABLE',
                      'Could not complete this action. Please retry.',
                      503,
                    );
            ack({ ok: false, error: { code: error.code, message: error.message } });
            if (error.code === 'UNAUTHENTICATED') socket.disconnect(true);
          });
      };
      const documentAccess = async (roomId: string, fileId: string, subscribed = true) => {
        await this.session(socket.data.sessionHash);
        const member = await this.membership(this.db, roomId, socket.data.userId);
        if (
          !socket.connected ||
          socket.data.roomId !== roomId ||
          (subscribed && socket.data.document?.fileId !== fileId)
        )
          throw new RealtimeError('NOT_SUBSCRIBED', 'Join this document first.');
        const [file] = await this.db
          .select({ id: files.id })
          .from(files)
          .where(and(eq(files.id, fileId), eq(files.roomId, roomId), eq(files.kind, 'FILE')));
        if (!file)
          throw new RealtimeError(
            'FILE_NOT_FOUND',
            'File was deleted. Download your local work.',
            404,
          );
        return member;
      };
      const callAccess = async (roomId: string, callId?: string, participantId?: string) => {
        await this.session(socket.data.sessionHash);
        await this.membership(this.db, roomId, socket.data.userId);
        if (!socket.connected || socket.data.roomId !== roomId)
          throw new RealtimeError('NOT_SUBSCRIBED', 'Join this room first.');
        if (
          callId &&
          (socket.data.call?.callId !== callId || socket.data.call.participant.id !== participantId)
        )
          throw new RealtimeError('STALE_CALL', 'This call participation has ended. Join again.');
      };
      socket.on('call:join', (payload, ack) =>
        handle(ack, async () => {
          const data = callJoinSchema.parse(payload);
          this.rate(`calljoin:${socket.data.userId}`, 20);
          return this.withRoom(data.roomId, async () => {
            await callAccess(data.roomId);
            const sockets = await this.authorizedSockets(data.roomId);
            if (
              !socket.connected ||
              socket.data.roomId !== data.roomId ||
              socket.data.cancelledCalls?.has(data.joinId)
            )
              throw new RealtimeError('STALE_CALL', 'This join attempt has ended.');
            if (socket.data.call && socket.data.call.joinId !== data.joinId)
              throw new RealtimeError('ALREADY_IN_CALL', 'Leave this call before joining again.');
            if (!socket.data.call) {
              if (sockets.filter((s) => s.data.call).length >= MAX_CALL_PARTICIPANTS)
                throw new RealtimeError(
                  'CALL_FULL',
                  'This call has four participants. Try again when a place is free.',
                );
              let call = this.calls.get(data.roomId);
              if (!call) {
                if (this.calls.size >= 1000)
                  throw new RealtimeError('UNAVAILABLE', 'Call service is busy.');
                call = { id: randomUUID(), revision: 0 };
                this.calls.set(data.roomId, call);
              }
              socket.data.call = {
                seen: Date.now(),
                callId: call.id,
                joinId: data.joinId,
                sequences: new Map(),
                participant: {
                  id: randomUUID(),
                  userId: socket.data.userId,
                  name: socket.data.name,
                  media: data.media,
                },
              };
            }
            return {
              session: {
                roomId: data.roomId,
                callId: socket.data.call.callId,
                participantId: socket.data.call.participant.id,
              },
              snapshot: this.callSnapshot(data.roomId, sockets)!,
            };
          });
        }),
      );
      socket.on('call:cancel', (payload, ack) =>
        handle(ack, async () => {
          const data = callCancelSchema.parse(payload);
          return this.withRoom(data.roomId, async () => {
            await callAccess(data.roomId);
            const cancelled = (socket.data.cancelledCalls ??= new Set());
            cancelled.add(data.joinId);
            if (cancelled.size > 32) cancelled.delete(cancelled.values().next().value!);
            if (socket.data.call?.joinId === data.joinId) socket.data.call = undefined;
            this.callSnapshot(data.roomId, await this.authorizedSockets(data.roomId));
            return null;
          });
        }),
      );
      socket.on('call:leave', (payload, ack) =>
        handle(ack, async () => {
          const data = callSessionSchema.parse(payload);
          return this.withRoom(data.roomId, async () => {
            await callAccess(data.roomId, data.callId, data.participantId);
            socket.data.call = undefined;
            this.callSnapshot(data.roomId, await this.authorizedSockets(data.roomId));
            return null;
          });
        }),
      );
      socket.on('call:state', (payload, ack) =>
        handle(ack, async () => {
          const data = callStateSchema.parse(payload);
          this.rate(`callstate:${socket.data.userId}`, 60);
          return this.withRoom(data.roomId, async () => {
            await callAccess(data.roomId, data.callId, data.participantId);
            socket.data.call!.participant.media = data.media;
            socket.data.call!.seen = Date.now();
            this.callSnapshot(data.roomId, await this.authorizedSockets(data.roomId));
            return null;
          });
        }),
      );
      socket.on('call:signal', (payload, ack) =>
        handle(ack, async () => {
          const data = callSignalSchema.parse(payload);
          this.rate(`callsignal:${socket.data.userId}`, 480);
          this.rate(
            `callbytes:${socket.data.userId}`,
            1_000_000,
            60_000,
            JSON.stringify(data).length,
          );
          if (data.signal.kind === 'description') this.rate(`callsdp:${socket.data.userId}`, 60);
          else this.rate(`callcandidate:${socket.data.userId}`, 384);
          return this.withRoom(data.roomId, async () => {
            await callAccess(data.roomId, data.callId, data.participantId);
            const destination = (await this.authorizedSockets(data.roomId)).find(
              (s) =>
                s !== socket &&
                s.data.call?.callId === data.callId &&
                s.data.call.participant.id === data.to,
            );
            if (!destination)
              throw new RealtimeError('PEER_GONE', 'The participant has left this call.');
            if (!socket.connected || socket.data.call?.participant.id !== data.participantId)
              throw new RealtimeError('STALE_CALL', 'This call participation has ended.');
            const sequences = socket.data.call!.sequences;
            // Only keep the current (at most three) destinations; churn cannot grow this map.
            for (const id of sequences.keys())
              if (![...io.sockets.sockets.values()].some((s) => s.data.call?.participant.id === id))
                sequences.delete(id);
            if (data.sequence <= (sequences.get(data.to) ?? 0)) return null;
            sequences.set(data.to, data.sequence);
            destination.emit('call:signal', data);
            return null;
          });
        }),
      );
      socket.on('doc:join', (payload, ack) =>
        handle(ack, async () => {
          const data = documentJoinSchema.parse(payload);
          this.rate(`docjoin:${socket.data.userId}`, 120);
          return this.withRoom(data.roomId, async () => {
            await documentAccess(data.roomId, data.fileId, false);
            if (
              [...io.sockets.sockets.values()].some(
                (s) =>
                  s !== socket &&
                  s.data.document?.fileId === data.fileId &&
                  s.data.document.clientId === data.clientId,
              )
            )
              throw new RealtimeError(
                'CLIENT_ID_CONFLICT',
                'Another tab has this document identity. Reload this tab.',
              );
            const result = await this.documents.sync(
              data.roomId,
              data.fileId,
              { vector: data.vector },
              async (tx) => {
                await this.session(socket.data.sessionHash, tx);
                return (await this.membership(tx, data.roomId, socket.data.userId)).role;
              },
            );
            const previous = socket.data.document?.fileId;
            socket.data.document = {
              fileId: data.fileId,
              clientId: data.clientId,
              cursor: null,
              seen: Date.now(),
            };
            if (previous && previous !== data.fileId) await this.awareness(data.roomId, previous);
            await this.awareness(data.roomId, data.fileId);
            return { ...result, userId: socket.data.userId };
          });
        }),
      );
      socket.on('doc:update', (payload, ack) =>
        handle(ack, async () => {
          const data = documentUpdateSchema.parse(payload);
          this.rate(`docwrite:${socket.data.userId}`, 600);
          this.rate(`docbytes:${socket.data.userId}`, 12_000_000, 60_000, data.update.length);
          return this.withRoom(data.roomId, async () => {
            await documentAccess(data.roomId, data.fileId);
            const result = await this.documents.sync(
              data.roomId,
              data.fileId,
              { update: data.update, vector: data.vector },
              async (tx) => {
                await this.session(socket.data.sessionHash, tx);
                return (await this.membership(tx, data.roomId, socket.data.userId)).role;
              },
            );
            // Commit has completed. Never broadcast speculative state.
            for (const recipient of await this.authorizedSockets(data.roomId))
              if (recipient.data.document?.fileId === data.fileId && recipient !== socket)
                recipient.emit('doc:update', { fileId: data.fileId, update: data.update });
            return { ...result, userId: socket.data.userId };
          });
        }),
      );
      socket.on('doc:awareness', (payload, ack) =>
        handle(ack, async () => {
          const data = documentAwarenessSchema.parse(payload);
          this.rate(`cursor:${socket.data.userId}`, 1800);
          return this.withRoom(data.roomId, async () => {
            await documentAccess(data.roomId, data.fileId);
            socket.data.document!.cursor = data.cursor;
            socket.data.document!.seen = Date.now();
            await this.awareness(data.roomId, data.fileId);
            return null;
          });
        }),
      );
      socket.on('doc:leave', (payload, ack) =>
        handle(ack, async () => {
          const data = documentSchema.parse(payload);
          return this.withRoom(data.roomId, async () => {
            await documentAccess(data.roomId, data.fileId);
            socket.data.document = undefined;
            await this.awareness(data.roomId, data.fileId);
            return null;
          });
        }),
      );
      socket.on('room:join', (payload, ack) =>
        handle(ack, async () => {
          const { roomId } = roomSubscriptionSchema.parse(payload);
          return this.withRoom(roomId, async () => {
            await this.session(socket.data.sessionHash);
            await this.membership(this.db, roomId, socket.data.userId);
            if (!socket.connected) throw new RealtimeError('OFFLINE', 'Connection closed.');
            // One room per connection avoids unbounded subscriptions. Tabs use separate sockets.
            if (socket.data.roomId && socket.data.roomId !== roomId)
              throw new RealtimeError('ALREADY_JOINED', 'Leave the current room first.');
            socket.data.roomId = roomId;
            await socket.join(roomId);
            return this.presence(roomId);
          });
        }),
      );
      socket.on('room:leave', (payload, ack) =>
        handle(ack, async () => {
          const { roomId } = roomSubscriptionSchema.parse(payload);
          return this.withRoom(roomId, async () => {
            await this.session(socket.data.sessionHash);
            await this.membership(this.db, roomId, socket.data.userId);
            if (socket.data.roomId === roomId) {
              socket.data.call = undefined;
              const fileId = socket.data.document?.fileId;
              socket.data.document = undefined;
              socket.data.roomId = undefined;
              await socket.leave(roomId);
              if (fileId) await this.awareness(roomId, fileId);
              await this.presence(roomId);
            }
            return null;
          });
        }),
      );
      socket.on('chat:send', (payload, ack) =>
        handle(ack, async () => {
          const data = chatSendSchema.parse(payload);
          this.rate(`chat:${socket.data.userId}`, 30);
          return this.withRoom(data.roomId, async () => {
            if (!socket.connected || socket.data.roomId !== data.roomId)
              throw new RealtimeError('NOT_SUBSCRIBED', 'Join this room before sending messages.');
            const message = await this.db.transaction(async (tx) => {
              await tx
                .select({ id: rooms.id })
                .from(rooms)
                .where(eq(rooms.id, data.roomId))
                .for('update');
              const identity = await this.session(socket.data.sessionHash, tx);
              await this.membership(tx, data.roomId, identity.userId);
              // Viewers may chat; file writes remain restricted to owner/editor HTTP routes.
              const [inserted] = await tx
                .insert(messages)
                .values({
                  id: randomUUID(),
                  roomId: data.roomId,
                  userId: identity.userId,
                  senderName: identity.name,
                  clientMessageId: data.clientMessageId,
                  body: data.body,
                })
                .onConflictDoNothing()
                .returning();
              const row =
                inserted ??
                (
                  await tx
                    .select()
                    .from(messages)
                    .where(
                      and(
                        eq(messages.roomId, data.roomId),
                        eq(messages.userId, identity.userId),
                        eq(messages.clientMessageId, data.clientMessageId),
                      ),
                    )
                )[0];
              if (row.body !== data.body)
                throw new RealtimeError(
                  'IDEMPOTENCY_CONFLICT',
                  'This retry ID already belongs to another message.',
                  409,
                );
              return wireMessage(row);
            });
            // Commit precedes both broadcast and acknowledgment. Retry safely rebroadcasts the same ID.
            for (const recipient of await this.authorizedSockets(data.roomId))
              recipient.emit('chat:message', message);
            return message;
          });
        }),
      );
      socket.on('disconnect', () => {
        socket.data.call = undefined;
        const roomId = socket.data.roomId;
        const fileId = socket.data.document?.fileId;
        socket.data.document = undefined;
        socket.data.roomId = undefined;
        if (roomId && fileId)
          void this.withRoom(roomId, () => this.awareness(roomId, fileId)).catch(() => {});
        if (roomId) void this.withRoom(roomId, () => this.presence(roomId)).catch(() => {});
      });
    });
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.options.sweepMs ?? 15_000);
    this.timer.unref();
    return io;
  }
  private async authorizedSockets(roomId: string) {
    const result: RoomSocket[] = [];
    for (const socket of this.io?.sockets.sockets.values() ?? []) {
      if (!socket.connected || socket.data.roomId !== roomId) continue;
      try {
        await this.session(socket.data.sessionHash);
        await this.membership(this.db, roomId, socket.data.userId);
        if (socket.connected && socket.data.roomId === roomId) result.push(socket);
      } catch (err) {
        if (!(err instanceof RealtimeError)) throw err;
        socket.data.roomId = undefined;
        socket.data.document = undefined;
        socket.data.call = undefined;
        await socket.leave(roomId);
        socket.emit('room:revoked', { roomId, reason: err.message });
        if (err.code === 'UNAUTHENTICATED') socket.disconnect(true);
      }
    }
    return result;
  }
  async publishExecution(event: ExecutionEvent) {
    await this.withRoom(event.roomId, async () => {
      for (const socket of await this.authorizedSockets(event.roomId))
        socket.volatile.emit('execution:event', event);
    });
  }
  private async presence(roomId: string): Promise<Presence> {
    const sockets = await this.authorizedSockets(roomId);
    for (const socket of sockets)
      if (
        socket.data.call &&
        Date.now() - socket.data.call.seen > (this.options.callLeaseMs ?? 45_000)
      )
        socket.data.call = undefined;
    this.callSnapshot(roomId, sockets);
    const online = new Set(sockets.map((s) => s.data.userId));
    const rows = await this.db
      .select({ id: users.id, name: users.name, role: members.role })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.roomId, roomId));
    const presence = { roomId, members: rows.filter((row) => online.has(row.id)) };
    for (const socket of sockets) socket.emit('presence:update', presence);
    return presence;
  }
  private async awareness(roomId: string, fileId: string) {
    const sockets = (await this.authorizedSockets(roomId)).filter(
      (s) => s.data.document?.fileId === fileId,
    );
    const userIds = [...new Set(sockets.map((s) => s.data.userId))].sort();
    const peers: DocumentPeer[] = sockets
      .filter((s) => Date.now() - s.data.document!.seen < 45_000)
      .map((s) => {
        const palette = ['#60a5fa', '#f472b6', '#4ade80', '#fbbf24', '#c084fc', '#fb923c'];
        const color = palette[userIds.indexOf(s.data.userId) % palette.length];
        return {
          clientId: s.data.document!.clientId,
          cursor: s.data.document!.cursor,
          user: { name: s.data.name, color, colorLight: color + '44' },
        };
      });
    for (const s of sockets) s.emit('doc:awareness', { fileId, peers });
  }
  /** Called after commit, while the caller holds withRoom. */
  async publish(event: RoomEvent) {
    const sockets = await this.authorizedSockets(event.roomId);
    for (const socket of sockets) {
      const fileId = socket.data.document?.fileId;
      if (!fileId) continue;
      const [file] = await this.db.select({ id: files.id }).from(files).where(eq(files.id, fileId));
      if (!file) {
        socket.data.document = undefined;
        socket.emit('doc:revoked', {
          fileId,
          reason: 'File was deleted. Download your local work.',
        });
      }
    }
    for (const socket of sockets) socket.emit('room:event', event);
    for (const fileId of new Set(sockets.map((s) => s.data.document?.fileId)))
      if (fileId) await this.awareness(event.roomId, fileId);
    if (event.type === 'membership.changed' || event.type === 'room.deleted')
      await this.presence(event.roomId);
  }
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    this.prune();
    try {
      for (const socket of this.io?.sockets.sockets.values() ?? []) {
        try {
          await this.session(socket.data.sessionHash);
        } catch (err) {
          if (err instanceof RealtimeError) socket.disconnect(true);
        }
      }
      const roomIds = new Set([
        ...this.calls.keys(),
        ...[...(this.io?.sockets.sockets.values() ?? [])].map((s) => s.data.roomId),
      ]);
      for (const roomId of roomIds)
        if (roomId)
          await this.withRoom(roomId, async () => {
            await this.presence(roomId);
            for (const fileId of new Set(
              [...this.io!.sockets.sockets.values()]
                .filter((s) => s.data.roomId === roomId)
                .map((s) => s.data.document?.fileId),
            ))
              if (fileId) await this.awareness(roomId, fileId);
          });
    } catch {
      /* Database outage: do not emit data; subsequent actions reauthorize and fail closed. */
    } finally {
      this.sweeping = false;
    }
  }
  async history(roomId: string, userId: string, query: unknown) {
    const data: z.infer<typeof chatHistorySchema> = chatHistorySchema.parse(query);
    this.rate(`history:${userId}`, 120);
    return this.withRoom(roomId, async () => {
      await this.membership(this.db, roomId, userId);
      const rows = await this.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.roomId, roomId),
            data.before ? lt(messages.sequence, BigInt(data.before)) : undefined,
            data.after ? gt(messages.sequence, BigInt(data.after)) : undefined,
          ),
        )
        .orderBy(data.after ? asc(messages.sequence) : desc(messages.sequence))
        .limit(data.limit + 1);
      const page = rows.slice(0, data.limit);
      const nextCursor = rows.length > data.limit ? page.at(-1)!.sequence.toString() : null;
      return { messages: (data.after ? page : page.reverse()).map(wireMessage), nextCursor };
    });
  }
  async close() {
    this.metered?.close();
    clearInterval(this.timer);
    await new Promise<void>((resolve) => (this.io ? this.io.close(() => resolve()) : resolve()));
    await Promise.allSettled([...this.locks.values()]);
    this.tickets.clear();
    this.calls.clear();
    this.limits.clear();
  }
}
import type { ExecutionEvent } from '@codetogether/contracts';
