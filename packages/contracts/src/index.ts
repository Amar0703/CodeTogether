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
  'room:join': (payload: { roomId: string }, ack: Ack<Presence>) => void;
  'room:leave': (payload: { roomId: string }, ack: Ack<null>) => void;
  'chat:send': (payload: z.infer<typeof chatSendSchema>, ack: Ack<ChatMessage>) => void;
}
export interface ServerEvents {
  'presence:update': (presence: Presence) => void;
  'chat:message': (message: ChatMessage) => void;
  'room:event': (event: RoomEvent) => void;
  'room:revoked': (payload: { roomId: string; reason: string }) => void;
}
