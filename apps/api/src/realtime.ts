import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { ZodError, type z } from 'zod';
import { type Database, members, messages, rooms, sessions, users } from '@codetogether/db';
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
} from '@codetogether/contracts';
import { hashToken, token } from './security.js';
import { normalizeOrigin } from './origin.js';

export class RealtimeError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 403,
  ) {
    super(message);
  }
}
type Identity = { userId: string; name: string; sessionHash: string; roomId?: string };
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
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  readonly origin: string;
  constructor(
    private db: Database,
    origin: string,
    private options: {
      ticketTtlMs?: number;
      sweepMs?: number;
      pingInterval?: number;
      pingTimeout?: number;
      actionLimit?: number;
    } = {},
  ) {
    this.origin = normalizeOrigin(origin);
  }

  // Also used by HTTP mutations: revocation, joins, sends and broadcasts cannot overtake each other.
  async withRoom<T>(roomId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(roomId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.locks.set(roomId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(roomId) === current) this.locks.delete(roomId);
    }
  }
  private rate(key: string, limit: number, windowMs = 60_000) {
    let bucket = this.limits.get(key);
    if (!bucket || bucket.expiresAt <= Date.now()) {
      bucket = { count: 0, expiresAt: Date.now() + windowMs };
      this.limits.set(key, bucket);
    }
    if (++bucket.count > limit)
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
      maxHttpBufferSize: 16_384,
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
      socket.use((_packet, next) => {
        try {
          this.rate(`packets:${socket.data.userId}`, this.options.actionLimit ?? 120);
          next();
        } catch {
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
              socket.data.roomId = undefined;
              await socket.leave(roomId);
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
        const roomId = socket.data.roomId;
        socket.data.roomId = undefined;
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
        await socket.leave(roomId);
        socket.emit('room:revoked', { roomId, reason: err.message });
        if (err.code === 'UNAUTHENTICATED') socket.disconnect(true);
      }
    }
    return result;
  }
  private async presence(roomId: string): Promise<Presence> {
    const sockets = await this.authorizedSockets(roomId);
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
  /** Called after commit, while the caller holds withRoom. */
  async publish(event: RoomEvent) {
    const sockets = await this.authorizedSockets(event.roomId);
    for (const socket of sockets) socket.emit('room:event', event);
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
      const roomIds = new Set(
        [...(this.io?.sockets.sockets.values() ?? [])].map((s) => s.data.roomId),
      );
      for (const roomId of roomIds)
        if (roomId) await this.withRoom(roomId, () => this.presence(roomId));
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
    clearInterval(this.timer);
    await new Promise<void>((resolve) => (this.io ? this.io.close(() => resolve()) : resolve()));
    await Promise.allSettled([...this.locks.values()]);
    this.tickets.clear();
    this.limits.clear();
  }
}
