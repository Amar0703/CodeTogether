import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, lt, desc, inArray, sql } from 'drizzle-orm';
import {
  executions,
  executionAdmission,
  rooms,
  members,
  sessions,
  files,
  type Database,
} from '@codetogether/db';
import {
  executionLimits as L,
  executionSubmitSchema,
  executionHistorySchema,
  executionLanguage,
  type ExecutionView,
  type ExecutionEvent,
  type ExecutionResult,
  type OutputChunk,
} from '@codetogether/contracts';
import { RealtimeError } from './realtime.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Row = typeof executions.$inferSelect;
const active = ['QUEUED', 'RUNNING'] as const;
export const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function executionView(r: Row): ExecutionView {
  return {
    id: r.id,
    roomId: r.roomId,
    fileId: r.fileId,
    sequence: String(r.sequence),
    userId: r.userId,
    submitter: r.submitter,
    filename: r.filename,
    language: r.language,
    sourceHash: r.sourceHash,
    version: r.version,
    status: r.status,
    attempt: r.attempt,
    revision: r.revision,
    chunks: r.chunks,
    truncated: r.truncated,
    failure: r.failure,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}
export class ExecutionService {
  constructor(
    readonly db: Database,
    private available: () => Promise<boolean> = async () => false,
    private emit: (event: ExecutionEvent) => Promise<void> = async () => {},
  ) {}
  async health() {
    return { available: await this.available().catch(() => false), limits: L };
  }
  private async membership(tx: Database | Tx, roomId: string, userId: string) {
    const [m] = await tx
      .select()
      .from(members)
      .where(and(eq(members.roomId, roomId), eq(members.userId, userId)));
    if (!m) throw new RealtimeError('ROOM_NOT_FOUND', 'Room not found or access removed.', 404);
    return m;
  }
  private async lock<T>(roomId: string, fn: (tx: Tx) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).for('update');
      return fn(tx);
    });
  }
  async submit(
    roomId: string,
    user: { id: string; name: string },
    sessionHash: string,
    input: unknown,
  ) {
    const data = executionSubmitSchema.parse(input);
    const fingerprint = sourceHash(JSON.stringify({ roomId, ...data }));
    // Fast readiness check happens outside database locks. Existing retries remain recoverable.
    const available = (await this.health()).available;
    const row = await this.lock(roomId, async (tx) => {
      const member = await this.membership(tx, roomId, user.id);
      if (member.role === 'VIEWER')
        throw new RealtimeError(
          'FORBIDDEN',
          'Viewers may observe executions but cannot run code.',
          403,
        );
      const [session] = await tx
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.tokenHash, sessionHash),
            eq(sessions.userId, user.id),
            gt(sessions.expiresAt, new Date()),
          ),
        );
      if (!session) throw new RealtimeError('UNAUTHENTICATED', 'Session expired.', 401);
      await tx.select().from(executionAdmission).where(eq(executionAdmission.id, 1)).for('update');
      const [existing] = await tx
        .select()
        .from(executions)
        .where(
          and(eq(executions.userId, user.id), eq(executions.idempotencyKey, data.idempotencyKey)),
        );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new RealtimeError(
            'IDEMPOTENCY_CONFLICT',
            'This submission key was used for different input.',
            409,
          );
        return existing;
      }
      if (!available)
        throw new RealtimeError(
          'EXECUTION_UNAVAILABLE',
          'Execution is unavailable. Check Redis and the sandbox worker; editing, chat and calls remain available.',
          503,
        );
      const [file] = await tx
        .select()
        .from(files)
        .where(and(eq(files.id, data.fileId), eq(files.roomId, roomId), eq(files.kind, 'FILE')));
      if (!file) throw new RealtimeError('FILE_NOT_FOUND', 'File is not in this room.', 404);
      if (file.version !== data.version || sourceHash(file.content) !== data.sourceHash)
        throw new RealtimeError(
          'SNAPSHOT_CONFLICT',
          'The saved file changed. Wait for Saved and run again.',
          409,
        );
      if (executionLanguage(file.name) !== data.language)
        throw new RealtimeError(
          'LANGUAGE_MISMATCH',
          'Use a .js/.mjs/.cjs, .py or .cpp/.cc/.cxx file matching the selected language.',
          400,
        );
      if (Buffer.byteLength(file.content) > L.sourceBytes)
        throw new RealtimeError('SOURCE_LIMIT', 'Source exceeds 64 KiB.', 400);
      const [counts] = await tx
        .select({
          global: sql<number>`count(*) filter (where status in ('QUEUED','RUNNING'))::int`,
          userActive: sql<number>`count(*) filter (where user_id=${user.id} and status in ('QUEUED','RUNNING'))::int`,
          roomActive: sql<number>`count(*) filter (where room_id=${roomId} and status in ('QUEUED','RUNNING'))::int`,
          userRate: sql<number>`count(*) filter (where user_id=${user.id} and created_at > now() - interval '1 minute')::int`,
          roomRate: sql<number>`count(*) filter (where room_id=${roomId} and created_at > now() - interval '1 minute')::int`,
        })
        .from(executions)
        .where(sql`status in ('QUEUED','RUNNING') or created_at > now() - interval '1 minute'`);
      if (
        counts.global >= L.globalActive ||
        counts.userActive >= L.userActive ||
        counts.roomActive >= L.roomActive ||
        counts.userRate >= L.userPerMinute ||
        counts.roomRate >= L.roomPerMinute
      )
        throw new RealtimeError(
          'EXECUTION_LIMIT',
          'Execution capacity or submission rate reached. Wait for an active run to finish and retry shortly.',
          429,
        );
      const [created] = await tx
        .insert(executions)
        .values({
          id: randomUUID(),
          roomId,
          fileId: file.id,
          userId: user.id,
          submitter: user.name,
          sessionHash,
          idempotencyKey: data.idempotencyKey,
          fingerprint,
          filename: file.path,
          language: data.language,
          source: file.content,
          stdin: data.stdin,
          sourceHash: data.sourceHash,
          version: file.version,
        })
        .returning();
      return created;
    });
    await this.publish(row);
    return executionView(row);
  }
  async history(roomId: string, userId: string, query: unknown) {
    const { before, limit } = executionHistorySchema.parse(query);
    return this.lock(roomId, async (tx) => {
      await this.membership(tx, roomId, userId);
      const rows = await tx
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.roomId, roomId),
            before ? lt(executions.sequence, BigInt(before)) : undefined,
          ),
        )
        .orderBy(desc(executions.sequence))
        .limit(limit + 1);
      return {
        executions: rows.slice(0, limit).map(executionView),
        nextCursor: rows.length > limit ? String(rows[limit - 1].sequence) : null,
      };
    });
  }
  async get(roomId: string, id: string, userId: string) {
    return this.lock(roomId, async (tx) => {
      await this.membership(tx, roomId, userId);
      const row = await this.row(tx, id, roomId);
      return executionView(row);
    });
  }
  private async row(tx: Database | Tx, id: string, roomId?: string) {
    const [row] = await tx
      .select()
      .from(executions)
      .where(and(eq(executions.id, id), roomId ? eq(executions.roomId, roomId) : undefined))
      .for('update');
    if (!row) throw new RealtimeError('EXECUTION_NOT_FOUND', 'Execution not found.', 404);
    return row;
  }
  private async authorized(tx: Tx, row: Row) {
    const [m] = await tx
      .select()
      .from(members)
      .where(and(eq(members.roomId, row.roomId), eq(members.userId, row.userId)));
    const [s] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, row.sessionHash), gt(sessions.expiresAt, new Date())));
    return !!m && m.role !== 'VIEWER' && !!s && !!row.fileId;
  }
  private async terminal(
    tx: Tx,
    row: Row,
    status: 'CANCELLED' | 'FAILED',
    failure: ExecutionResult['failure'],
  ) {
    const [updated] = await tx
      .update(executions)
      .set({
        status,
        failure,
        revision: row.revision + 1,
        finishedAt: new Date(),
        leaseUntil: null,
      })
      .where(eq(executions.id, row.id))
      .returning();
    return updated;
  }
  async cancel(roomId: string, id: string, userId: string) {
    const row = await this.lock(roomId, async (tx) => {
      const m = await this.membership(tx, roomId, userId);
      const r = await this.row(tx, id, roomId);
      if (r.userId !== userId && m.role !== 'OWNER')
        throw new RealtimeError('FORBIDDEN', 'Only the submitter or room owner may cancel.', 403);
      return active.includes(r.status as (typeof active)[number])
        ? this.terminal(tx, r, 'CANCELLED', 'USER_CANCELLED')
        : r;
    });
    await this.publish(row);
    return executionView(row);
  }
  private async workerMutation<T>(id: string, fn: (tx: Tx, row: Row) => Promise<T>) {
    const initial = await this.row(this.db, id);
    return this.lock(initial.roomId, async (tx) => fn(tx, await this.row(tx, id)));
  }
  async claim(id: string) {
    const row = await this.workerMutation(id, async (tx, r) => {
      if (r.status !== 'QUEUED') return null; // Duplicate delivery never starts another attempt.
      if (!(await this.authorized(tx, r))) return this.terminal(tx, r, 'CANCELLED', 'REVOKED');
      if (Date.now() - r.createdAt.getTime() > L.queueWaitMs)
        return this.terminal(tx, r, 'FAILED', 'QUEUE_EXPIRED');
      const [started] = await tx
        .update(executions)
        .set({
          status: 'RUNNING',
          attempt: randomUUID(),
          revision: r.revision + 1,
          startedAt: new Date(),
          leaseUntil: new Date(Date.now() + L.leaseMs),
        })
        .where(eq(executions.id, id))
        .returning();
      return started;
    });
    if (row) await this.publish(row);
    return row?.status === 'RUNNING'
      ? {
          executionId: row.id,
          attempt: row.attempt!,
          language: row.language,
          source: row.source,
          stdin: row.stdin,
        }
      : null;
  }
  async update(id: string, attempt: string, chunk?: OutputChunk, result?: ExecutionResult) {
    let emittedChunk: OutputChunk | undefined;
    const row = await this.workerMutation(id, async (tx, r) => {
      if (
        r.status !== 'RUNNING' ||
        r.attempt !== attempt ||
        !r.leaseUntil ||
        r.leaseUntil.getTime() <= Date.now()
      )
        throw new RealtimeError('STALE_ATTEMPT', 'Execution lease is no longer active.', 409);
      if (!(await this.authorized(tx, r))) return this.terminal(tx, r, 'CANCELLED', 'REVOKED');
      if (Date.now() - r.startedAt!.getTime() > L.totalMs + 5000)
        return this.terminal(tx, r, 'FAILED', 'INFRASTRUCTURE');
      if (chunk) {
        if (chunk.sequence <= r.chunks.length) {
          const old = r.chunks[chunk.sequence - 1];
          if (old.text !== chunk.text || old.stream !== chunk.stream)
            throw new RealtimeError('OUTPUT_CONFLICT', 'Conflicting output sequence.', 409);
          return r;
        }
        if (chunk.sequence !== r.chunks.length + 1)
          throw new RealtimeError('OUTPUT_GAP', 'Output must arrive in order.', 409);
        const bytes = Buffer.byteLength(chunk.text);
        if (r.outputBytes + bytes > L.outputBytes || r.chunks.length >= L.chunks)
          throw new RealtimeError('OUTPUT_LIMIT', 'Output limit reached.', 413);
        emittedChunk = chunk;
        const [updated] = await tx
          .update(executions)
          .set({
            chunks: [...r.chunks, chunk],
            outputBytes: r.outputBytes + bytes,
            revision: r.revision + 1,
            leaseUntil: new Date(Date.now() + L.leaseMs),
          })
          .where(eq(executions.id, id))
          .returning();
        return updated;
      }
      const [updated] = await tx
        .update(executions)
        .set(
          result
            ? { ...result, revision: r.revision + 1, finishedAt: new Date(), leaseUntil: null }
            : { leaseUntil: new Date(Date.now() + L.leaseMs) },
        )
        .where(eq(executions.id, id))
        .returning();
      return updated;
    });
    if (chunk || result || row.status !== 'RUNNING') await this.publish(row, emittedChunk);
    return { active: row.status === 'RUNNING' };
  }
  async publish(row: Row, chunk?: OutputChunk) {
    // Delivery is best effort after commit; authenticated refetch is authoritative.
    await this.emit({
      roomId: row.roomId,
      executionId: row.id,
      attempt: row.attempt,
      revision: row.revision,
      status: row.status,
      truncated: row.truncated,
      ...(chunk ? { chunk } : {}),
    }).catch(() => {});
  }
  async reconcile() {
    const rows = await this.db
      .select()
      .from(executions)
      .where(inArray(executions.status, [...active]))
      .limit(L.globalActive);
    for (const initial of rows) {
      const row = await this.lock(initial.roomId, async (tx) => {
        const [r] = await tx.select().from(executions).where(eq(executions.id, initial.id));
        if (!r || !active.includes(r.status as (typeof active)[number])) return null;
        if (!(await this.authorized(tx, r))) return this.terminal(tx, r, 'CANCELLED', 'REVOKED');
        if (r.status === 'QUEUED' && Date.now() - r.createdAt.getTime() > L.queueWaitMs)
          return this.terminal(tx, r, 'FAILED', 'QUEUE_EXPIRED');
        if (
          r.status === 'RUNNING' &&
          (!r.leaseUntil ||
            r.leaseUntil.getTime() < Date.now() ||
            Date.now() - r.startedAt!.getTime() > L.totalMs + 5000)
        )
          return this.terminal(tx, r, 'FAILED', 'INFRASTRUCTURE');
        return null;
      });
      if (row) await this.publish(row);
    }
    // Keep idempotency, snapshots and results for 7 days, bounded cleanup batches.
    const expired = await this.db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          lt(executions.finishedAt, new Date(Date.now() - 7 * 86400_000)),
          sql`status not in ('QUEUED','RUNNING')`,
        ),
      )
      .limit(100);
    if (expired.length)
      await this.db.delete(executions).where(
        inArray(
          executions.id,
          expired.map((r) => r.id),
        ),
      );
  }
}
