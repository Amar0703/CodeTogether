import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, desc } from 'drizzle-orm';
import { ZodError } from 'zod';
import { type Database, users, sessions, rooms, members, files, invites } from '@codetogether/db';
import {
  signupSchema,
  loginSchema,
  roomSchema,
  inviteSchema,
  tokenSchema,
  idSchema,
  createFileSchema,
  saveFileSchema,
  renameFileSchema,
  memberSchema,
  type Role,
  type User,
  type RoomEvent,
} from '@codetogether/contracts';
import { hashPassword, verifyPassword, hashToken, token } from './security.js';
import { Realtime, RealtimeError } from './realtime.js';
import { normalizeOrigin } from './origin.js';

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
const publicUser = (u: typeof users.$inferSelect): User => ({
  id: u.id,
  name: u.name,
  email: u.email,
});
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Store = Database | Tx;
const everyone: Role[] = ['OWNER', 'EDITOR', 'VIEWER'];
const writers: Role[] = ['OWNER', 'EDITOR'];
const owner: Role[] = ['OWNER'];

export function createApp(
  db: Database,
  options: { origin: string; production?: boolean; rateLimit?: number; realtime?: Realtime },
) {
  options = { ...options, origin: normalizeOrigin(options.origin) };
  const realtime = options.realtime ?? new Realtime(db, options.origin);
  const app = express();
  const cookieName = options.production ? '__Host-ct_session' : 'ct_session';
  const cookieOptions = {
    httpOnly: true,
    secure: !!options.production,
    sameSite: 'lax' as const,
    path: '/',
  };
  app.disable('x-powered-by');
  app.use(helmet(), express.json({ limit: '1mb' }), cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', async (_req, res) => {
    await db.select({ id: users.id }).from(users).limit(1);
    res.json({ status: 'ok' });
  });
  app.use('/api', (req, _res, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (req.get('X-CodeTogether') !== '1' ||
        (req.get('Origin') && req.get('Origin') !== options.origin))
    )
      return next(new ApiError(403, 'INVALID_ORIGIN', 'Request origin could not be verified.'));
    next();
  });
  app.use(
    '/api/auth',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: options.rateLimit ?? 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.method === 'GET',
      message: {
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
      },
    }),
  );
  const newSession = async (userId: string, res: Response) => {
    const value = token();
    await db.insert(sessions).values({
      tokenHash: hashToken(value),
      userId,
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    });
    res.cookie(cookieName, value, { ...cookieOptions, maxAge: 7 * 86400_000 });
  };
  app.post('/api/auth/signup', async (req, res) => {
    const data = signupSchema.parse(req.body);
    const [user] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        name: data.name,
        email: data.email,
        passwordHash: await hashPassword(data.password),
      })
      .onConflictDoNothing()
      .returning();
    if (!user) fail(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
    await newSession(user.id, res);
    res.status(201).json({ user: publicUser(user) });
  });
  app.post('/api/auth/login', async (req, res) => {
    const data = loginSchema.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, data.email));
    // Derive a key even for unknown users to avoid a cheap account-existence timing signal.
    const valid = await verifyPassword(
      data.password,
      user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`,
    );
    if (!user || !valid) fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    if (req.cookies[cookieName]) {
      await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(req.cookies[cookieName])));
      realtime.revokeSession(hashToken(req.cookies[cookieName]));
    }
    await newSession(user.id, res);
    res.json({ user: publicUser(user) });
  });
  app.post('/api/auth/logout', async (req, res) => {
    if (req.cookies[cookieName]) {
      await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(req.cookies[cookieName])));
      realtime.revokeSession(hashToken(req.cookies[cookieName]));
    }
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  app.use('/api', async (req, res, next) => {
    const value = req.cookies[cookieName];
    if (!value || typeof value !== 'string')
      fail(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    const [record] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(value)), gt(sessions.expiresAt, new Date())));
    if (!record) fail(401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
    res.locals.user = publicUser(record.user);
    res.locals.sessionHash = hashToken(value);
    next();
  });
  const uid = (res: Response) => (res.locals.user as User).id;
  const param = (req: Request, name: string) => idSchema.parse(req.params[name]);
  async function access(store: Store, roomId: string, userId: string, allowed: Role[]) {
    const [record] = await store
      .select({ room: rooms, role: members.role })
      .from(rooms)
      .innerJoin(members, and(eq(members.roomId, rooms.id), eq(members.userId, userId)))
      .where(eq(rooms.id, roomId));
    if (!record) fail(404, 'ROOM_NOT_FOUND', 'Room not found or you do not have access.');
    if (!allowed.includes(record.role))
      fail(403, 'FORBIDDEN', 'Your role does not allow this action.');
    return { ...record.room, role: record.role };
  }
  // Serialize room mutations so permission changes, tree edits and saves cannot race.
  async function writeRoom<T>(
    roomId: string,
    userId: string,
    allowed: Role[],
    action: (tx: Tx) => Promise<T>,
    event?: RoomEvent,
  ) {
    return realtime.withRoom(roomId, async () => {
      const result = await db.transaction(async (tx) => {
        await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).for('update');
        await access(tx, roomId, userId, allowed);
        return action(tx);
      });
      if (event) await realtime.publish(event);
      return result;
    });
  }
  async function findFile(fileId: string) {
    const [file] = await db.select().from(files).where(eq(files.id, fileId));
    if (!file) fail(404, 'FILE_NOT_FOUND', 'File not found.');
    return file;
  }
  app.get('/api/auth/me', (_req, res) => res.json({ user: res.locals.user }));
  app.post('/api/realtime/ticket', async (_req, res) => {
    res.json(await realtime.ticket(res.locals.sessionHash));
  });
  app.get('/api/rooms/:roomId/messages', async (req, res) => {
    res.json(await realtime.history(param(req, 'roomId'), uid(res), req.query));
  });
  app.get('/api/rooms', async (_req, res) => {
    const rows = await db
      .select({ room: rooms, role: members.role })
      .from(rooms)
      .innerJoin(members, and(eq(members.roomId, rooms.id), eq(members.userId, uid(res))))
      .orderBy(desc(rooms.updatedAt))
      .limit(100);
    res.json({ rooms: rows.map((r) => ({ ...r.room, role: r.role })) });
  });
  app.post('/api/rooms', async (req, res) => {
    const data = roomSchema.parse(req.body);
    const id = randomUUID();
    const room = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(rooms)
        .values({ ...data, id, ownerId: uid(res) })
        .returning();
      await tx.insert(members).values({ roomId: id, userId: uid(res), role: 'OWNER' });
      await tx.insert(files).values({
        id: randomUUID(),
        roomId: id,
        name: 'main.js',
        path: '/main.js',
        kind: 'FILE',
        content:
          '// Every great idea starts with a first line.\n\nfunction greet(name) {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(greet("CodeTogether"));\n',
      });
      return created;
    });
    res.status(201).json({ room: { ...room, role: 'OWNER' } });
  });
  app.get('/api/rooms/:roomId', async (req, res) => {
    const roomId = param(req, 'roomId');
    const room = await access(db, roomId, uid(res), everyone);
    const roomMembers = await db
      .select({ id: users.id, name: users.name, email: users.email, role: members.role })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.roomId, roomId));
    const roomFiles = await db
      .select()
      .from(files)
      .where(eq(files.roomId, roomId))
      .orderBy(files.path);
    res.json({ room, members: roomMembers, files: roomFiles });
  });
  app.patch('/api/rooms/:roomId', async (req, res) => {
    const roomId = param(req, 'roomId');
    const data = roomSchema.parse(req.body);
    const [room] = await writeRoom(
      roomId,
      uid(res),
      owner,
      (tx) =>
        tx
          .update(rooms)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(rooms.id, roomId))
          .returning(),
      { type: 'room.updated', roomId, actorId: uid(res) },
    );
    res.json({ room: { ...room, role: 'OWNER' } });
  });
  app.delete('/api/rooms/:roomId', async (req, res) => {
    const roomId = param(req, 'roomId');
    await writeRoom(roomId, uid(res), owner, (tx) => tx.delete(rooms).where(eq(rooms.id, roomId)), {
      type: 'room.deleted',
      roomId,
      actorId: uid(res),
    });
    res.status(204).end();
  });
  app.post('/api/rooms/:roomId/invites', async (req, res) => {
    const roomId = param(req, 'roomId');
    const data = inviteSchema.parse(req.body);
    const value = token();
    const expiresAt = new Date(Date.now() + data.expiresInHours * 3600_000);
    await writeRoom(roomId, uid(res), owner, (tx) =>
      tx.insert(invites).values({
        id: randomUUID(),
        roomId,
        tokenHash: hashToken(value),
        role: data.role,
        expiresAt,
      }),
    );
    res.status(201).json({ url: `${options.origin}/join/${value}`, expiresAt });
  });
  app.post('/api/invites/:token/join', async (req, res) => {
    const value = tokenSchema.parse(req.params.token);
    const [invite] = await db
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, hashToken(value)), gt(invites.expiresAt, new Date())));
    if (!invite) fail(400, 'INVALID_INVITE', 'This invitation is invalid or has expired.');
    await realtime.withRoom(invite.roomId, async () => {
      await db.transaction(async (tx) => {
        const [room] = await tx
          .select()
          .from(rooms)
          .where(eq(rooms.id, invite.roomId))
          .for('update');
        if (!room) fail(400, 'INVALID_INVITE', 'This room no longer exists.');
        if (invite.expiresAt.getTime() <= Date.now())
          fail(400, 'INVALID_INVITE', 'This invitation has expired.');
        await tx
          .insert(members)
          .values({ roomId: invite.roomId, userId: uid(res), role: invite.role })
          .onConflictDoNothing();
      });
      await realtime.publish({
        type: 'membership.changed',
        roomId: invite.roomId,
        userId: uid(res),
        actorId: uid(res),
      });
    });
    res.json({ roomId: invite.roomId });
  });
  app.post('/api/rooms/:roomId/join', async (req, res) => {
    const roomId = param(req, 'roomId');
    await realtime.withRoom(roomId, async () => {
      await db.transaction(async (tx) => {
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
        if (!room || room.visibility !== 'PUBLIC')
          fail(404, 'ROOM_NOT_FOUND', 'Public room not found.');
        await tx
          .insert(members)
          .values({ roomId, userId: uid(res), role: 'VIEWER' })
          .onConflictDoNothing();
      });
      await realtime.publish({
        type: 'membership.changed',
        roomId,
        userId: uid(res),
        actorId: uid(res),
      });
    });
    res.json({ roomId });
  });
  app.patch('/api/rooms/:roomId/members/:userId', async (req, res) => {
    const roomId = param(req, 'roomId'),
      userId = param(req, 'userId'),
      data = memberSchema.parse(req.body);
    await writeRoom(
      roomId,
      uid(res),
      owner,
      async (tx) => {
        const [member] = await tx
          .select()
          .from(members)
          .where(and(eq(members.roomId, roomId), eq(members.userId, userId)));
        if (!member) fail(404, 'MEMBER_NOT_FOUND', 'Member not found.');
        if (member.role === 'OWNER')
          fail(400, 'OWNER_PROTECTED', 'The owner role cannot be changed.');
        await tx
          .update(members)
          .set(data)
          .where(and(eq(members.roomId, roomId), eq(members.userId, userId)));
      },
      { type: 'membership.changed', roomId, userId, actorId: uid(res) },
    );
    res.status(204).end();
  });
  app.delete('/api/rooms/:roomId/members/:userId', async (req, res) => {
    const roomId = param(req, 'roomId'),
      userId = param(req, 'userId');
    await writeRoom(
      roomId,
      uid(res),
      userId === uid(res) ? everyone : owner,
      async (tx) => {
        const [member] = await tx
          .select()
          .from(members)
          .where(and(eq(members.roomId, roomId), eq(members.userId, userId)));
        if (member?.role === 'OWNER')
          fail(400, 'OWNER_PROTECTED', 'Owners must delete the room instead of leaving.');
        await tx.delete(members).where(and(eq(members.roomId, roomId), eq(members.userId, userId)));
      },
      { type: 'membership.changed', roomId, userId, actorId: uid(res) },
    );
    res.status(204).end();
  });
  app.post('/api/rooms/:roomId/files', async (req, res) => {
    const roomId = param(req, 'roomId'),
      data = createFileSchema.parse(req.body);
    const fileId = randomUUID();
    const file = await writeRoom(
      roomId,
      uid(res),
      writers,
      async (tx) => {
        let prefix = '';
        if (data.parentId) {
          const [parent] = await tx
            .select()
            .from(files)
            .where(
              and(eq(files.id, data.parentId), eq(files.roomId, roomId), eq(files.kind, 'FOLDER')),
            );
          if (!parent) fail(400, 'INVALID_PARENT', 'Choose a folder in this room.');
          prefix = parent.path;
        }
        if ((prefix.match(/\//g)?.length ?? 0) >= 12)
          fail(400, 'TREE_TOO_DEEP', 'Folders can be nested up to 12 levels.');
        const [created] = await tx
          .insert(files)
          .values({ ...data, id: fileId, roomId, path: `${prefix}/${data.name}` })
          .returning();
        await tx.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, roomId));
        return created;
      },
      { type: 'file.changed', change: 'created', roomId, fileId, actorId: uid(res) },
    );
    res.status(201).json({ file });
  });
  app.get('/api/files/:fileId', async (req, res) => {
    const file = await findFile(param(req, 'fileId'));
    await access(db, file.roomId, uid(res), everyone);
    res.json({ file });
  });
  app.patch('/api/files/:fileId', async (req, res) => {
    const original = await findFile(param(req, 'fileId'));
    const data = saveFileSchema.parse(req.body);
    const file = await writeRoom(
      original.roomId,
      uid(res),
      writers,
      async (tx) => {
        const [saved] = await tx
          .update(files)
          .set({ content: data.content, version: data.version + 1, updatedAt: new Date() })
          .where(
            and(eq(files.id, original.id), eq(files.version, data.version), eq(files.kind, 'FILE')),
          )
          .returning();
        if (!saved)
          fail(
            409,
            'VERSION_CONFLICT',
            'This file changed since you opened it. Copy your draft, then reload the latest saved version.',
          );
        await tx.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, original.roomId));
        return saved;
      },
      {
        type: 'file.changed',
        change: 'saved',
        roomId: original.roomId,
        fileId: original.id,
        actorId: uid(res),
      },
    );
    res.json({ file });
  });
  app.patch('/api/files/:fileId/name', async (req, res) => {
    const original = await findFile(param(req, 'fileId'));
    const { name } = renameFileSchema.parse(req.body);
    await writeRoom(
      original.roomId,
      uid(res),
      writers,
      async (tx) => {
        const all = await tx.select().from(files).where(eq(files.roomId, original.roomId));
        const current = all.find((f) => f.id === original.id);
        if (!current) fail(404, 'FILE_NOT_FOUND', 'File not found.');
        const newPath = `${current.path.slice(0, current.path.lastIndexOf('/'))}/${name}`;
        for (const file of all.filter(
          (f) => f.id === current.id || f.path.startsWith(`${current.path}/`),
        )) {
          await tx
            .update(files)
            .set({
              path: newPath + file.path.slice(current.path.length),
              ...(file.id === current.id ? { name } : {}),
              updatedAt: new Date(),
            })
            .where(eq(files.id, file.id));
        }
      },
      {
        type: 'file.changed',
        change: 'renamed',
        roomId: original.roomId,
        fileId: original.id,
        actorId: uid(res),
      },
    );
    res.status(204).end();
  });
  app.delete('/api/files/:fileId', async (req, res) => {
    const file = await findFile(param(req, 'fileId'));
    await writeRoom(
      file.roomId,
      uid(res),
      writers,
      (tx) => tx.delete(files).where(eq(files.id, file.id)),
      {
        type: 'file.changed',
        change: 'deleted',
        roomId: file.roomId,
        fileId: file.id,
        actorId: uid(res),
      },
    );
    res.status(204).end();
  });
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError)
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
    if (err instanceof ApiError || err instanceof RealtimeError)
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    const dbError = err as { code?: string; cause?: { code?: string }; status?: number };
    if (dbError.code === '23505' || dbError.cause?.code === '23505')
      return res.status(409).json({
        error: { code: 'ALREADY_EXISTS', message: 'That name is already used in this folder.' },
      });
    if (dbError.status === 413 || dbError.status === 400)
      return res.status(dbError.status).json({
        error: { code: 'INVALID_BODY', message: 'Request body is invalid or too large.' },
      });
    console.error(err);
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
    });
  });
  return app;
}
