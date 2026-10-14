import { z } from 'zod';

export const executionLimits = {
  sourceBytes: 65_536,
  stdinBytes: 16_384,
  outputBytes: 65_536,
  chunkBytes: 4096,
  chunks: 256,
  userActive: 2,
  roomActive: 4,
  globalActive: 64,
  userPerMinute: 10,
  roomPerMinute: 30,
  queueWaitMs: 120_000,
  leaseMs: 15_000,
  compileMs: 10_000,
  runMs: 3000,
  sandboxMs: 16_000,
  totalMs: 40_000,
  memoryBytes: 268_435_456,
  diskBytes: 33_554_432,
  processes: 32,
} as const;
const boundedText = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine(
      (s) => !s.includes('\0') && new TextEncoder().encode(s).length <= bytes,
      'Text exceeds UTF-8 byte limit or contains a null character',
    );
export const executionLanguageSchema = z.enum(['javascript', 'python', 'cpp']);
export type ExecutionLanguage = z.infer<typeof executionLanguageSchema>;
export function executionLanguage(filename: string): ExecutionLanguage | undefined {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'py') return 'python';
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx') return 'cpp';
}
export const executionSubmitSchema = z
  .object({
    fileId: z.uuid(),
    idempotencyKey: z.uuid(),
    language: executionLanguageSchema,
    version: z.number().int().positive(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    stdin: boundedText(executionLimits.stdinBytes).default(''),
  })
  .strict();
export const executionHistorySchema = z
  .object({
    before: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(20).default(10),
  })
  .strict();
export const executionStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
]);
export const executionFailureSchema = z.enum([
  'COMPILE_ERROR',
  'RUNTIME_ERROR',
  'RESOURCE_LIMIT',
  'INFRASTRUCTURE',
  'QUEUE_EXPIRED',
  'REVOKED',
  'USER_CANCELLED',
]);
export const outputChunkSchema = z
  .object({
    sequence: z.number().int().min(1).max(executionLimits.chunks),
    stream: z.enum(['stdout', 'stderr']),
    text: boundedText(executionLimits.chunkBytes),
  })
  .strict();
export type OutputChunk = z.infer<typeof outputChunkSchema>;
export const executionResultSchema = z
  .object({
    status: z.enum(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']),
    failure: executionFailureSchema.nullable(),
    exitCode: z.number().int().min(-255).max(255).nullable(),
    durationMs: z.number().int().min(0).max(60_000),
    truncated: z.boolean(),
  })
  .strict()
  .refine((r) => {
    if (r.status === 'SUCCEEDED') return r.failure === null && r.exitCode === 0 && !r.truncated;
    if (r.status === 'TIMED_OUT') return r.failure === 'RESOURCE_LIMIT';
    if (r.status === 'CANCELLED') return r.failure === 'USER_CANCELLED' || r.failure === 'REVOKED';
    return r.failure !== null && !['USER_CANCELLED', 'REVOKED'].includes(r.failure);
  }, 'Terminal status, failure and exit information must agree');
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export const workerClaimSchema = z.object({ executionId: z.uuid() }).strict();
export const workerLeaseSchema = z.object({ attempt: z.uuid() }).strict();
export const workerOutputSchema = workerLeaseSchema.extend({ chunk: outputChunkSchema }).strict();
export const workerFinishSchema = workerLeaseSchema
  .extend({ result: executionResultSchema })
  .strict();
export const executionViewSchema = z
  .object({
    id: z.uuid(),
    roomId: z.uuid(),
    fileId: z.uuid().nullable(),
    sequence: z.string().regex(/^\d+$/),
    userId: z.uuid(),
    submitter: z.string(),
    filename: z.string(),
    language: executionLanguageSchema,
    sourceHash: z.string(),
    version: z.number().int(),
    status: executionStatusSchema,
    attempt: z.uuid().nullable(),
    revision: z.number().int(),
    chunks: z.array(outputChunkSchema).max(executionLimits.chunks),
    truncated: z.boolean(),
    failure: executionFailureSchema.nullable(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .strict();
export type ExecutionView = z.infer<typeof executionViewSchema>;
export type ExecutionHistory = { executions: ExecutionView[]; nextCursor: string | null };
export const executionEventSchema = z
  .object({
    roomId: z.uuid(),
    executionId: z.uuid(),
    attempt: z.uuid().nullable(),
    revision: z.number().int().positive(),
    status: executionStatusSchema,
    chunk: outputChunkSchema.optional(),
    truncated: z.boolean(),
  })
  .strict();
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export type WorkerClaim = {
  executionId: string;
  attempt: string;
  language: ExecutionLanguage;
  source: string;
  stdin: string;
};
