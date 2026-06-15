-- 0003_pipeline_columns.down.sql
-- Removes the 10 new pipeline columns added in 0003 by recreating the jobs table
-- without them (SQLite does not support DROP COLUMN in older versions).

-- 1. Back up rows keeping only original columns
CREATE TABLE jobs_backup AS
  SELECT
    id,
    listing_url,
    company_id,
    company,
    role,
    location,
    work_model,
    comp_text,
    scores_json,
    status,
    research_level,
    research_facets,
    tailor_state,
    queued_next,
    owner_id,
    channel_id,
    root_ts,
    card_ts,
    html_key,
    brief_key,
    resume_pdf_key,
    created_at,
    updated_at
  FROM jobs;

-- 2. Drop current (extended) table and its indexes
DROP TABLE jobs;

-- 3. Recreate original schema
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  listing_url     TEXT NOT NULL UNIQUE,

  company_id      TEXT REFERENCES companies(id),
  company         TEXT,
  role            TEXT,
  location        TEXT,
  work_model      TEXT,
  comp_text       TEXT,
  scores_json     TEXT,

  status          TEXT NOT NULL DEFAULT 'scoring',
  research_level  TEXT NOT NULL DEFAULT 'none',
  research_facets TEXT,
  tailor_state    TEXT NOT NULL DEFAULT 'none',
  queued_next     TEXT NOT NULL DEFAULT 'none',

  owner_id        TEXT,
  channel_id      TEXT,
  root_ts         TEXT,
  card_ts         TEXT,

  html_key        TEXT,
  brief_key       TEXT,
  resume_pdf_key  TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4. Restore rows
INSERT INTO jobs SELECT * FROM jobs_backup;

-- 5. Drop backup
DROP TABLE jobs_backup;

-- 6. Recreate original indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_owner    ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_company  ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_updated  ON jobs(updated_at DESC);
