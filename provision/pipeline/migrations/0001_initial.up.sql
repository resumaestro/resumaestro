-- job-slack D1 schema — the queryable pipeline record.
-- Apply with:  npx wrangler d1 execute job-pipeline --file=./schema.sql
--
-- R2 still holds the blobs (listing HTML, research brief, tailored PDF, and the
-- existing companies/ roles/ people/ payloads). D1 holds the *record* so we can
-- dedupe re-adds, list "what's staged / parked", and render the App Home + /jobs board.

CREATE TABLE IF NOT EXISTS companies (
  id          TEXT PRIMARY KEY,                 -- slug, e.g. "acme" or domain-derived
  name        TEXT NOT NULL,
  domain      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,             -- stable 12-char hash of listing_url
  listing_url     TEXT NOT NULL UNIQUE,         -- dedup key: re-/add of same URL resumes

  company_id      TEXT REFERENCES companies(id),
  company         TEXT,                         -- denormalized for fast home/board render
  role            TEXT,
  location        TEXT,
  work_model      TEXT,                         -- remote | hybrid | onsite
  comp_text       TEXT,                         -- raw comp string from the listing
  scores_json     TEXT,                         -- {salary, location, commute, stack, ...} — informational, no gate

  -- pipeline state
  status          TEXT NOT NULL DEFAULT 'scoring',
                  -- scoring | scored | research_depth_select | researching | researched
                  -- tailoring | tailored | staging | staged | parking | parked
  research_level  TEXT NOT NULL DEFAULT 'none', -- none | surface | deep
  research_facets TEXT,                         -- JSON: { facets: string[], extra: string } (deep only)
  tailor_state    TEXT NOT NULL DEFAULT 'none', -- none | in_progress | done
  queued_next     TEXT NOT NULL DEFAULT 'none', -- none | tailor_after_research | stage_after_tailor

  -- slack coordinates
  owner_id        TEXT,                         -- Slack user_id of whoever ran /add (for App Home refresh)
  channel_id      TEXT,
  root_ts         TEXT,                         -- the original /add message (thread root)
  card_ts         TEXT,                         -- the scores+footer card (first thread reply)

  -- r2 blob keys
  html_key        TEXT,
  brief_key       TEXT,
  resume_pdf_key  TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_owner    ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_company  ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_updated  ON jobs(updated_at DESC);
