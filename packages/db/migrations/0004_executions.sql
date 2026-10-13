BEGIN;
CREATE TABLE IF NOT EXISTS execution_admission (id integer PRIMARY KEY CHECK(id = 1));
INSERT INTO execution_admission VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS executions (
  id uuid PRIMARY KEY, sequence bigserial UNIQUE NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users(id), submitter text NOT NULL,
  session_hash text NOT NULL, idempotency_key uuid NOT NULL, fingerprint text NOT NULL,
  filename text NOT NULL, language text NOT NULL CHECK(language IN ('javascript','python','cpp')),
  source text NOT NULL CHECK(octet_length(source) <= 65536),
  stdin text NOT NULL CHECK(octet_length(stdin) <= 16384), source_hash text NOT NULL, version integer NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED')),
  attempt uuid, revision integer NOT NULL DEFAULT 1, chunks jsonb NOT NULL DEFAULT '[]',
  output_bytes integer NOT NULL DEFAULT 0 CHECK(output_bytes BETWEEN 0 AND 65536),
  truncated boolean NOT NULL DEFAULT false, failure text, exit_code integer, duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  lease_until timestamptz, dispatched_at timestamptz,
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS executions_room_sequence ON executions(room_id, sequence DESC);
CREATE INDEX IF NOT EXISTS executions_user_time ON executions(user_id, created_at);
CREATE INDEX IF NOT EXISTS executions_active ON executions(status, created_at);
-- Revocation is sticky even if the user is promoted/rejoins before the next heartbeat.
CREATE OR REPLACE FUNCTION cancel_revoked_executions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'room_members' THEN
    IF TG_OP = 'DELETE' OR NEW.role = 'VIEWER' THEN
      UPDATE executions SET status='CANCELLED', failure='REVOKED', finished_at=now(), revision=revision+1
      WHERE room_id=OLD.room_id AND user_id=OLD.user_id AND status IN ('QUEUED','RUNNING');
    END IF;
  ELSIF TG_TABLE_NAME = 'sessions' THEN
    UPDATE executions SET status='CANCELLED', failure='REVOKED', finished_at=now(), revision=revision+1
    WHERE session_hash=OLD.token_hash AND status IN ('QUEUED','RUNNING');
  ELSIF TG_TABLE_NAME = 'files' THEN
    UPDATE executions SET status='CANCELLED', failure='REVOKED', finished_at=now(), revision=revision+1
    WHERE file_id=OLD.id AND status IN ('QUEUED','RUNNING');
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS executions_member_revocation ON room_members;
CREATE TRIGGER executions_member_revocation AFTER UPDATE OF role OR DELETE ON room_members FOR EACH ROW EXECUTE FUNCTION cancel_revoked_executions();
DROP TRIGGER IF EXISTS executions_session_revocation ON sessions;
CREATE TRIGGER executions_session_revocation BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION cancel_revoked_executions();
DROP TRIGGER IF EXISTS executions_file_revocation ON files;
CREATE TRIGGER executions_file_revocation BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION cancel_revoked_executions();
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
COMMIT;
