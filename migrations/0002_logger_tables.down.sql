DROP INDEX IF EXISTS idx_slack_actions_action;
DROP INDEX IF EXISTS idx_slack_actions_job;
DROP TABLE IF EXISTS slack_actions;

DROP INDEX IF EXISTS idx_job_events_job;
DROP TABLE IF EXISTS job_events;

DROP INDEX IF EXISTS idx_agent_runs_status;
DROP INDEX IF EXISTS idx_agent_runs_job;
DROP TABLE IF EXISTS agent_runs;
