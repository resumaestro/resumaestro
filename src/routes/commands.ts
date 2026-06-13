// ---- Slash command handlers: /add, /jobs ----------------------------------

import type { Env, JobRow } from '#/types';
import { verifySlack } from '#/slack';
import { makeJobId, createJob, updateJob, listJobs } from '#/db';
import { createCard } from '#/build/createCard';
import { createJobsList } from '#/build/createJobsList';
import { postMsg, wakeAgent, publishHome } from '#/slack';

// ---- /commands/add --------------------------------------------------------
//
// Accepts one or more whitespace/comma-separated job listing URLs.
// Each URL gets its own root channel message (the thread anchor) and a
// scanning card posted as the first thread reply. The slash command itself
// returns an empty 200 — no ephemeral noise in the channel.
//
// Jobs from the same company are linked via the companies table (populated
// after surface_scan returns) so the agent can skip redundant company
// research when multiple postings land at once.

export async function handleAddCommand(env: Env, payload: Record<string, string>): Promise<void> {
  // Support multiple URLs separated by whitespace or commas.
  const raw = (payload.text ?? '').trim();
  if (!raw) {
    await fetch(payload.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text: 'Usage: `/add {url} [{url2} …]`' }),
    });
    return;
  }

  const urls = raw.split(/[\s,]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
  if (!urls.length) {
    await fetch(payload.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text: 'No valid URLs found. Usage: `/add {url} [{url2} …]`' }),
    });
    return;
  }

  const channel = env.SLACK_CHANNEL;
  const ownerId = payload.user_id ?? null;

  for (const url of urls) {
    const id = await makeJobId(url);

    // Dedup — silently skip URLs already in the pipeline.
    const existing = await env.DB.prepare('SELECT id FROM jobs WHERE listing_url = ?').bind(url).first<{ id: string }>();
    if (existing) continue;

    // 1. Create D1 row (status: scoring)
    await createJob(env, { id, listing_url: url, channel_id: channel, owner_id: ownerId, status: 'scoring' });

    // 2. Post root message — one per job, no thread_ts; this IS the thread anchor
    const rootTs = await postMsg(env, channel, url);

    // 3. Post scanning card as first thread reply
    const scanningJob: JobRow = {
      id, listing_url: url, company_id: null, company: null, role: null, location: null,
      work_model: null, comp_text: null, scores_json: null,
      status: 'scoring', research_level: 'none', research_facets: null,
      tailor_state: 'none', queued_next: 'none',
      owner_id: ownerId, channel_id: channel, root_ts: rootTs, card_ts: null,
      html_key: null, brief_key: null, resume_pdf_key: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const cardTs = await postMsg(env, channel, 'Scanning…', createCard(scanningJob), rootTs);

    // 4. Persist Slack coordinates + wake agent
    await updateJob(env, id, { root_ts: rootTs, card_ts: cardTs });
    await wakeAgent(env, 'surface_scan', id, { listing_url: url });
  }

  // Refresh the owner's App Home once after all jobs are queued.
  if (ownerId) await publishHome(env, ownerId);
}

// ---- HTTP route handler (/commands/*) -------------------------------------

export async function handleCommandsRoute(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
  const command = new URL(request.url).pathname.split('/').filter(Boolean).at(1);
  const rawBody = await request.text();
  if (env.SLACK_SIGNING_SECRET) {
    const valid = await verifySlack(env, rawBody, request);
    if (!valid) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const payload = Object.fromEntries(new URLSearchParams(rawBody));
  if (command === 'add') {
    executionContext.waitUntil(handleAddCommand(env, payload));
    return new Response('', { status: 200 });
  }
  if (command === 'jobs') {
    executionContext.waitUntil(handleJobsCommand(env, payload));
    return new Response('', { status: 200 });
  }
  return new Response('Unknown command', { status: 404 });
}

// ---- /commands/jobs --------------------------------------------------------

export async function handleJobsCommand(env: Env, payload: Record<string, string>): Promise<void> {
  const filter = (payload.text ?? '').trim().toLowerCase() || 'active';
  const jobs = await listJobs(env, filter);
  const blocks = createJobsList(jobs, filter);
  await postMsg(env, payload.channel_id, `Pipeline — ${jobs.length} jobs`, blocks);
}
