// ---- Shared types and constants -------------------------------------------

export interface Env {
  // Storage
  JOB_SOURCE: R2Bucket;
  DB: D1Database;

  // Slack
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL: string;        // #orchestra  (C0BA8G3UFNJ)
  STAGE_CHANNEL: string;        // #orchestra-stage
  PARKING_LOT_CHANNEL: string;  // #orchestra-parking-lot
  AGENT_MENTION?: string;       // "<@U...>" if channel is mentions-only

  // Agent
  AGENT_WEBHOOK_URL: string;    // Hyperagent webhook URL for the single Conductor agent
  AGENT_API_TOKEN: string;      // shared bearer for /data/*, /jobs/:id/result, /admin/*

  // Slack config tokens — Secrets Store bindings (read via .get())
  SLACK_APP_ID: string;
  SLACK_CONFIG_TOKEN: { get(): Promise<string> };
  SLACK_CONFIG_REFRESH_TOKEN: { get(): Promise<string> };
  SECRETS_STORE_ID: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;

  // Workers AI + Vectorize (data gateway)
  AI: { run: (model: string, inputs: unknown) => Promise<unknown> };
  VEC_COMPANY: VectorizeIndex;
  VEC_PEOPLE: VectorizeIndex;
  VEC_ROLE: VectorizeIndex;
  VEC_CODE: VectorizeIndex;
}

export interface JobRow {
  id: string;
  listing_url: string;
  company_id: string | null;    // FK → companies.id (populated after surface_scan)
  company: string | null;
  role: string | null;
  location: string | null;
  work_model: string | null;
  comp_text: string | null;
  scores_json: string | null;
  status: string;
  research_level: string;
  research_facets: string | null;
  tailor_state: string;
  queued_next: string;
  owner_id: string | null;      // Slack user_id of whoever ran /add (for App Home refresh)
  channel_id: string | null;
  root_ts: string | null;
  card_ts: string | null;
  html_key: string | null;
  brief_key: string | null;
  resume_pdf_key: string | null;
  created_at: string;
  updated_at: string;
}

export type ApplyAction = 'apply_requested' | 'edit_updated' | 'input_provided';

export const JSON_H = { 'Content-Type': 'application/json' } as const;
export const HTML_H = { 'Content-Type': 'text/html; charset=utf-8' } as const;
