// ---- Slash command handlers: /add, /jobs ----------------------------------

import type { Env, JobRow } from '../types';
import { makeJobId, createJob, updateJob, listJobs } from '../db';
import { cardBlocks, jobsListBlocks } from '../blocks';
import { slackApi, postMsg, wakeAgent, publishHome } from '../slack';

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

    // Dedup — check whether the URL is already in the pipeline.
    const existing = await env.DB.prepare('SELECT * FROM jobs WHERE listing_url = ?').bind(url).first<JobRow>();
    if (existing) {
      // Probe whether the Slack card still exists.
      const cardAlive = existing.card_ts && existing.channel_id
        ? (await slackApi(env, 'chat.getPermalink', { channel: existing.channel_id, message_ts: existing.card_ts }) as Record<string, unknown>).ok === true
        : false;

      if (!cardAlive) {
        // Card is gone — also check whether the root message still exists.
        // If root is alive we can thread under it; if not we need a fresh root.
        const rootAlive = existing.root_ts && existing.channel_id
          ? (await slackApi(env, 'chat.getPermalink', { channel: existing.channel_id, message_ts: existing.root_ts }) as Record<string, unknown>).ok === true
          : false;

        let rootTs = existing.root_ts;
        if (!rootAlive) {
          // Root is also gone — post a new root message and record it.
          rootTs = await postMsg(env, channel, url);
          await updateJob(env, existing.id, { root_ts: rootTs, channel_id: channel });
        }

        // Re-post the card under the (existing or new) root.
        const freshJob = { ...existing, root_ts: rootTs, card_ts: null, status: 'scoring' } as JobRow;
        const newCardTs = await postMsg(env, channel, 'Scanning…', cardBlocks(freshJob), rootTs!);
        await updateJob(env, existing.id, {
          card_ts: newCardTs,
          status: 'scoring',
          owner_id: ownerId ?? existing.owner_id,
        });
        await wakeAgent(env, 'surface_scan', existing.id, { listing_url: url });
        if (ownerId) await publishHome(env, ownerId);
        continue;
      }

      // Thread is alive — show its current status as an ephemeral.
      const tsSafe = existing.root_ts?.replace('.', '') ?? '';
      const threadLink = tsSafe
        ? `<slack://channel?team=${payload.team_id}&id=${existing.channel_id ?? channel}&message=${tsSafe}|open thread>`
        : '';
      const statusLine = existing.status === 'scoring'
        ? `Still scanning${threadLink ? ` — ${threadLink}` : ''}. Delete the thread and re-add to restart.`
        : `Already in pipeline *(${existing.status})*${threadLink ? ` — ${threadLink}` : ''}.`;
      await fetch(payload.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', text: statusLine }),
      });
      continue;
    }

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
    const cardTs = await postMsg(env, channel, 'Scanning…', cardBlocks(scanningJob), rootTs);

    // 4. Persist Slack coordinates + wake agent
    await updateJob(env, id, { root_ts: rootTs, card_ts: cardTs });
    await wakeAgent(env, 'surface_scan', id, { listing_url: url });

    // 5. Warn if the agent webhook isn't configured yet.
    if (!env.AGENT_WEBHOOK_URL) {
      await fetch(payload.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: '⚠️ `AGENT_WEBHOOK_URL` is not set — job added but the scan will not start until it is configured in `wrangler.toml`.',
        }),
      });
    }
  }

  // Refresh the owner's App Home once after all jobs are queued.
  if (ownerId) await publishHome(env, ownerId);
}

// ---- /commands/jobs --------------------------------------------------------

export async function handleJobsCommand(env: Env, payload: Record<string, string>): Promise<void> {
  const filter = (payload.text ?? '').trim().toLowerCase() || 'active';
  const jobs = await listJobs(env, filter);
  const blocks = jobsListBlocks(jobs, filter);
  await postMsg(env, payload.channel_id, `Pipeline — ${jobs.length} jobs`, blocks);
}
