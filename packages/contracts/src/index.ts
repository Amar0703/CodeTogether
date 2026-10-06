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
