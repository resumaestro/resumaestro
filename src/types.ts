// ---- Shared types and constants -------------------------------------------

export interface Env {
  // Storage
  RESUMAESTRO_SOURCE: R2Bucket;
  DB: D1Database;

  // Slack
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL: string; // #orchestra  (C0BA8G3UFNJ)
  GEOAPIFY_API_KEY: string;

  // Agent
  COMPOSER: Fetcher;

  // Workers AI + Vectorize (data gateway)
  AI: { run: (model: string, inputs: unknown) => Promise<unknown> };
  RESUMAESTRO_CONFIG: KVNamespace;
  RESUMAESTRO_COMPANIES: VectorizeIndex;
  RESUMAESTRO_TEAMMEMBERS: VectorizeIndex;
  RESUMAESTRO_ROLES: VectorizeIndex;
  VEC_CODE: VectorizeIndex;
}

export interface JobRow {
  id: string;
  listing_url: string;
  company_id: string | null; // FK → companies.id (populated after surface_scan)
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
  owner_id: string | null; // Slack user_id of whoever ran /add (for App Home refresh)
  channel_id: string | null;
  root_ts: string | null;
  card_ts: string | null;
  html_key: string | null;
  brief_key: string | null;
  resume_pdf_key: string | null;
  created_at: string;
  updated_at: string;
  in_flight: 'SCORING' | 'RESEARCHING' | 'TAILORING' | 'APPLYING' | null;
  job_status: 'EVALUATING' | 'STAGED' | 'PARKED';
  stage: 'IDLE' | 'APPLIED' | 'INTERVIEWING' | 'OFFERED' | null;
  research_intent: string | null;
  company_url: string | null;
  job_url: string | null;
  research_summary: string | null;
  research_signals_json: string | null;
  research_sources_json: string | null;
  apply_pending_json: string | null;
}

export type ApplyAction = 'apply_requested' | 'edit_updated' | 'input_provided';

export type ResearchFacets = {
  facets?: string[];
  extra?: string;
}

export type InFlight = 'SCORING' | 'RESEARCHING' | 'TAILORING' | 'APPLYING'

export type JobStatus = 'EVALUATING' | 'STAGED' | 'PARKED'

export type Stage = 'IDLE' | 'APPLIED' | 'INTERVIEWING' | 'OFFERED'

export type ResearchDepth = 'quick' | 'standard' | 'deep'

export type ResearchIntent = {
  depth: ResearchDepth
  facets?: string[]
  manager_name?: string
  concern?: string
}

export type ResearchSignal = {
  title: string
  url: string
  snippet: string
}

export type ApplyQuestion = {
  field: string
  question: string
}

export type ListView = 'jobs' | 'pipeline' | 'parked'

export type ListOptions = { sort?: string; filter?: Record<string, string> }
