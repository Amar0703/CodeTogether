BEGIN;
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  sender_name text NOT NULL,
  client_message_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_retry_idx ON messages(room_id, user_id, client_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_room_sequence_idx ON messages(room_id, sequence);
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
COMMIT;
