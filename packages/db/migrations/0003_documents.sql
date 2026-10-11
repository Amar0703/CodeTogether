BEGIN;
CREATE TABLE IF NOT EXISTS documents (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (length(state) <= 2796204)
);
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
COMMIT;
