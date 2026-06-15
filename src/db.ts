// ---- D1 + company helpers --------------------------------------------------

import type { Env, JobRow, ListView, ListOptions } from './types';

// ---- ID generation --------------------------------------------------------

export async function makeJobId(url: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return Array.from(new Uint8Array(buf)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Job CRUD -------------------------------------------------------------

export async function getJob(env: Env, id: string): Promise<JobRow | null> {
  return env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
}

export async function createJob(env: Env, data: Partial<JobRow> & { id: string; listing_url: string }): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO jobs (id, listing_url, company_id, company, role, location, work_model, comp_text,
      scores_json, status, research_level, research_facets, tailor_state, queued_next,
      owner_id, channel_id, root_ts, card_ts, html_key, brief_key, resume_pdf_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(listing_url) DO NOTHING
  `).bind(
    data.id, data.listing_url,
    data.company_id ?? null,
    data.company ?? null, data.role ?? null, data.location ?? null,
    data.work_model ?? null, data.comp_text ?? null, data.scores_json ?? null,
    data.status ?? 'scoring', data.research_level ?? 'none',
    data.research_facets ?? null, data.tailor_state ?? 'none',
    data.queued_next ?? 'none',
    data.owner_id ?? null, data.channel_id ?? null,
    data.root_ts ?? null, data.card_ts ?? null,
    data.html_key ?? null, data.brief_key ?? null, data.resume_pdf_key ?? null,
  ).run();
}

export async function updateJob(env: Env, id: string, data: Partial<Omit<JobRow, 'id' | 'created_at'>>): Promise<void> {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const set = entries.map(([k]) => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE jobs SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), id).run();
}

export async function listJobs(env: Env, view: ListView, options?: ListOptions): Promise<JobRow[]> {
  const filterEntries = options?.filter ? Object.entries(options.filter) : [];

  let whereClause: string;
  let orderClause: string;

  const sortField = options?.sort === 'created' ? 'created_at' : 'updated_at';

  if (view === 'jobs') {
    whereClause = `job_status = 'EVALUATING'`;
    orderClause = `in_flight IS NOT NULL DESC, ${sortField} DESC`;
  } else if (view === 'pipeline') {
    whereClause = `stage IS NOT NULL`;
    orderClause = `CASE stage WHEN 'IDLE' THEN 0 WHEN 'APPLIED' THEN 1 WHEN 'INTERVIEWING' THEN 2 WHEN 'OFFERED' THEN 3 ELSE 4 END, ${sortField} DESC`;
  } else {
    whereClause = `job_status = 'PARKED'`;
    orderClause = `${sortField} DESC`;
  }

  const filterClauses = filterEntries.map(([field]) => `${field} = ?`);
  const allClauses = [whereClause, ...filterClauses];
  const q = `SELECT * FROM jobs WHERE ${allClauses.join(' AND ')} ORDER BY ${orderClause} LIMIT 50`;
  const bindings = filterEntries.map(([, value]) => value);
  const { results } = await env.DB.prepare(q).bind(...bindings).all<JobRow>();
  return results;
}

// ---- Company helpers -------------------------------------------------------

// Upsert a company row and return its id (slug).
// Called from handleJobResult(surface_scan) once the agent resolves the company name.
export async function upsertCompany(env: Env, name: string, domain?: string | null): Promise<string> {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await env.DB.prepare(`
    INSERT INTO companies (id, name, domain)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = datetime('now')
  `).bind(id, name, domain ?? null).run();
  return id;
}

// Return the best research_level already completed for a company across all its jobs.
// Returns null when no research exists yet. Used to skip redundant company research.
export async function getCompanyResearchLevel(env: Env, companyId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT research_level FROM jobs
     WHERE company_id = ? AND research_level != 'none'
     ORDER BY CASE research_level WHEN 'deep' THEN 0 WHEN 'surface' THEN 1 ELSE 2 END, updated_at DESC
     LIMIT 1`,
  ).bind(companyId).first<{ research_level: string }>();
  return row?.research_level ?? null;
}
