DROP TABLE IF EXISTS schema_operation_logs;
DROP TABLE IF EXISTS schema_operations;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
