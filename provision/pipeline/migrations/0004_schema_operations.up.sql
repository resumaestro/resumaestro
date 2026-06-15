DROP TABLE IF EXISTS schema_migrations;

CREATE TABLE IF NOT EXISTS schema_operations (
  kind        TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_operation_logs (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  kind        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sha         TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_operations (kind, version) VALUES ('migration', 4);
