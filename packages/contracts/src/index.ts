import { z } from 'zod';

export const idSchema = z.uuid();
export const roleSchema = z.enum(['OWNER', 'EDITOR', 'VIEWER']);
export type Role = z.infer<typeof roleSchema>;
export const signupSchema = z.object({
  name: z.string().trim().min(2).max(60),
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(10).max(128),
});
export const loginSchema = signupSchema.omit({ name: true });
export const roomSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).default(''),
  visibility: z.enum(['PRIVATE', 'PUBLIC']).default('PRIVATE'),
});
export const inviteSchema = z.object({
  role: z.enum(['EDITOR', 'VIEWER']).default('EDITOR'),
  expiresInHours: z.number().int().min(1).max(168).default(24),
});
export const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (v) => !/[\\/\x00-\x1f]/.test(v) && v !== '.' && v !== '..',
    'Use a file name without slashes or control characters',
  );
export const createFileSchema = z.object({
  name: fileNameSchema,
  parentId: idSchema.nullable().default(null),
  kind: z.enum(['FILE', 'FOLDER']).default('FILE'),
});
export const saveFileSchema = z.object({
  content: z.string().max(200_000),
  version: z.number().int().min(1),
});
export const renameFileSchema = z.object({ name: fileNameSchema });
export const memberSchema = z.object({ role: z.enum(['EDITOR', 'VIEWER']) });
export interface User {
  id: string;
  name: string;
  email: string;
}
export interface Room {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  createdAt: string;
  updatedAt: string;
  role: Role;
}
export interface RoomFile {
  id: string;
  roomId: string;
  parentId: string | null;
  name: string;
  path: string;
  kind: 'FILE' | 'FOLDER';
  content: string;
  version: number;
  updatedAt: string;
}
export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
}
export interface RoomDetail {
  room: Room;
  members: Member[];
  files: RoomFile[];
}

export const roomSubscriptionSchema = z.object({ roomId: idSchema }).strict();
export const chatSendSchema = roomSubscriptionSchema
  .extend({
    clientMessageId: idSchema,
    body: z.string().trim().min(1).max(2000),
  })
  .strict();
export const messageCursorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const chatHistorySchema = z
  .object({
    before: messageCursorSchema.optional(),
    after: messageCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((value) => !(value.before && value.after), 'Use before or after, not both');
export interface ChatMessage {
  id: string;
  sequence: string;
  roomId: string;
  clientMessageId: string;
  sender: { id: string; name: string };
  body: string;
  createdAt: string;
}
export interface ChatHistory {
  messages: ChatMessage[];
  nextCursor: string | null;
}
export interface Presence {
  roomId: string;
  members: { id: string; name: string; role: Role }[];
}
export type RoomEvent = { roomId: string; actorId: string } & (
  | { type: 'membership.changed'; userId: string }
  | { type: 'file.changed'; fileId: string; change: 'created' | 'saved' | 'renamed' | 'deleted' }
  | { type: 'room.updated' }
  | { type: 'room.deleted' }
);
export type RealtimeResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export type Ack<T> = (result: RealtimeResult<T>) => void;
export interface ClientEvents {
  'doc:join': (payload: z.infer<typeof documentJoinSchema>, ack: Ack<DocumentSync>) => void;
  'doc:update': (payload: z.infer<typeof documentUpdateSchema>, ack: Ack<DocumentSync>) => void;
  'doc:leave': (payload: z.infer<typeof documentSchema>, ack: Ack<null>) => void;
  'doc:awareness': (payload: z.infer<typeof documentAwarenessSchema>, ack: Ack<null>) => void;
  'room:join': (payload: { roomId: string }, ack: Ack<Presence>) => void;
  'room:leave': (payload: { roomId: string }, ack: Ack<null>) => void;
  'chat:send': (payload: z.infer<typeof chatSendSchema>, ack: Ack<ChatMessage>) => void;
}
export interface ServerEvents {
  'doc:update': (payload: { fileId: string; update: string }) => void;
  'doc:awareness': (payload: { fileId: string; peers: DocumentPeer[] }) => void;
  'doc:revoked': (payload: { fileId: string; reason: string }) => void;
  'presence:update': (presence: Presence) => void;
  'chat:message': (message: ChatMessage) => void;
  'room:event': (event: RoomEvent) => void;
  'room:revoked': (payload: { roomId: string; reason: string }) => void;
}

// Base64 is used consistently by both PostgreSQL drivers and the JSON socket protocol.
export const MAX_DOCUMENT_BYTES = 2_097_152;
const encoded = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const documentSchema = roomSubscriptionSchema.extend({ fileId: idSchema }).strict();
export const documentJoinSchema = documentSchema
  .extend({
    clientId: z.number().int().min(0).max(4294967295),
    vector: encoded(32_768),
  })
  .strict();
export const documentUpdateSchema = documentSchema
  .extend({ update: encoded(2_796_204), vector: encoded(32_768) })
  .strict();
const itemId = z
  .object({
    client: z.number().int().min(0).max(4294967295),
    clock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const relativePosition = z
  .object({
    type: itemId.nullable().optional(),
    tname: z.literal('content').nullable().optional(),
    item: itemId.nullable().optional(),
    assoc: z.number().int().min(-1).max(1).optional(),
  })
  .strict();
export const documentAwarenessSchema = documentSchema
  .extend({
    cursor: z.object({ anchor: relativePosition, head: relativePosition }).strict().nullable(),
  })
  .strict();
export interface DocumentPeer {
  clientId: number;
  user: { name: string; color: string; colorLight: string };
  cursor: z.infer<typeof documentAwarenessSchema>['cursor'];
}
export interface DocumentSync {
  userId: string;
  update: string;
  vector: string;
  version: number;
  role: Role;
}
