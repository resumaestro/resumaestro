-- 0003_pipeline_columns.up.sql
-- Adds new pipeline state columns to jobs, backfills from legacy status,
-- and creates supporting indexes.

ALTER TABLE jobs ADD COLUMN in_flight TEXT;
-- SCORING | RESEARCHING | TAILORING | APPLYING | null

ALTER TABLE jobs ADD COLUMN job_status TEXT NOT NULL DEFAULT 'EVALUATING';
-- EVALUATING | STAGED | PARKED

ALTER TABLE jobs ADD COLUMN stage TEXT;
-- null | IDLE | APPLIED | INTERVIEWING | OFFERED

ALTER TABLE jobs ADD COLUMN research_intent TEXT;
-- JSON: { depth: 'quick'|'standard'|'deep', facets?: string[], manager_name?: string, concern?: string }

ALTER TABLE jobs ADD COLUMN company_url TEXT;
ALTER TABLE jobs ADD COLUMN job_url TEXT;
ALTER TABLE jobs ADD COLUMN research_summary TEXT;

ALTER TABLE jobs ADD COLUMN research_signals_json TEXT;
-- JSON: [{title,url,snippet}]

ALTER TABLE jobs ADD COLUMN research_sources_json TEXT;
-- JSON: [url]

ALTER TABLE jobs ADD COLUMN apply_pending_json TEXT;
-- JSON: [{field,question}] unknowns from apply agent

-- Backfill in_flight from legacy status
UPDATE jobs SET in_flight = 'SCORING'     WHERE status = 'scoring';
UPDATE jobs SET in_flight = 'RESEARCHING' WHERE status = 'researching';
UPDATE jobs SET in_flight = 'TAILORING'   WHERE status IN ('tailoring', 'staging');

-- Backfill job_status from legacy status
UPDATE jobs SET job_status = 'STAGED' WHERE status IN ('staged', 'staging');
UPDATE jobs SET job_status = 'PARKED' WHERE status IN ('parked', 'parking');

-- Backfill stage for newly-STAGED rows
UPDATE jobs SET stage = 'IDLE' WHERE job_status = 'STAGED';

-- New indexes
CREATE INDEX IF NOT EXISTS idx_jobs_job_status ON jobs(job_status);
CREATE INDEX IF NOT EXISTS idx_jobs_in_flight  ON jobs(in_flight);
CREATE INDEX IF NOT EXISTS idx_jobs_stage      ON jobs(stage);
