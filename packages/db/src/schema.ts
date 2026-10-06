import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
export const users = pgTable('users', {
  id: uuid().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_expiry_idx').on(t.expiresAt)],
);
export const rooms = pgTable('rooms', {
  id: uuid().primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  name: text().notNull(),
  description: text().notNull().default(''),
  visibility: text().$type<'PRIVATE' | 'PUBLIC'>().notNull().default('PRIVATE'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
export const members = pgTable(
  'room_members',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().$type<'OWNER' | 'EDITOR' | 'VIEWER'>().notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index('members_user_idx').on(t.userId)],
);
export const files = pgTable(
  'files',
  {
    id: uuid().primaryKey(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text().notNull(),
    path: text().notNull(),
    kind: text().$type<'FILE' | 'FOLDER'>().notNull(),
    content: text().notNull().default(''),
    version: integer().notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('files_room_path_idx').on(t.roomId, t.path)],
);
export const invites = pgTable('invites', {
  id: uuid().primaryKey(),
  roomId: uuid('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  role: text().$type<'EDITOR' | 'VIEWER'>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
