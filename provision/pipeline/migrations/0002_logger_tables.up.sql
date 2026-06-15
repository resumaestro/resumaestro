-- Logger tables: agent_runs, job_events, slack_actions.

-- Every wakeAgent call. finished_at NULL means still pending (detects frozen scans).
CREATE TABLE IF NOT EXISTS agent_runs (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  type         TEXT NOT NULL,  -- surface_scan | research | tailor | refine
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | success | error
  error        TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_job    ON agent_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

-- Append-only status transition log for each job.
CREATE TABLE IF NOT EXISTS job_events (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  triggered_by  TEXT,  -- user_id for button clicks, 'agent' for result callbacks, 'system' otherwise
  ts            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);

-- Every Slack action (button click) received by the action handler.
CREATE TABLE IF NOT EXISTS slack_actions (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  action_id  TEXT NOT NULL,
  job_id     TEXT REFERENCES jobs(id),
  user_id    TEXT,
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slack_actions_job    ON slack_actions(job_id);
CREATE INDEX IF NOT EXISTS idx_slack_actions_action ON slack_actions(action_id);
