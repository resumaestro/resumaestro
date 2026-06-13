// ---- Slack API helpers + agent wake + thread management ------------------

import type { Env, JobRow } from './types';
import { updateJob, listJobs } from './db';
import { cardBlocks, homeBlocks } from './blocks';

// ---- Signature verification -----------------------------------------------

export async function verifySlack(env: Env, rawBody: string, req: Request): Promise<boolean> {
  const ts = req.headers.get('x-slack-request-timestamp') ?? '';
  const sig = req.headers.get('x-slack-signature') ?? '';
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return false; // replay guard

  const sigBase = `v0:${ts}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBase));
  const computed = 'v0=' + Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computed.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---- Core Slack API -------------------------------------------------------

export async function slackApi(env: Env, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

export async function postMsg(env: Env, channel: string, text: string, blocks?: object[], threadTs?: string): Promise<string> {
  const body: Record<string, unknown> = { channel, text };
  if (blocks?.length) body.blocks = blocks;
  if (threadTs) body.thread_ts = threadTs;
  const r = await slackApi(env, 'chat.postMessage', body);
  return (r.ts as string) ?? '';
}

export async function updateMsg(env: Env, channel: string, ts: string, text: string, blocks: object[]): Promise<void> {
  await slackApi(env, 'chat.update', { channel, ts, text, blocks });
}

// Safe card update — if the card message has been deleted, re-posts it into
// the same thread and writes the new card_ts back to D1. Use this everywhere
// a job's card block is mutated; use updateMsg only for non-card messages.
export async function safeUpdateCard(env: Env, job: JobRow, text: string, blocks: object[]): Promise<void> {
  if (!job.channel_id || !job.card_ts) return;
  const r = await slackApi(env, 'chat.update', { channel: job.channel_id, ts: job.card_ts, text, blocks }) as Record<string, unknown>;
  if (r.ok) return;
  if (r.error === 'message_not_found' && job.root_ts) {
    // Card was deleted — re-post it into the thread and record the new ts
    const newCardTs = await postMsg(env, job.channel_id, text, blocks, job.root_ts);
    await updateJob(env, job.id, { card_ts: newCardTs });
  }
}

export async function deleteMsg(env: Env, channel: string, ts: string): Promise<void> {
  await slackApi(env, 'chat.delete', { channel, ts });
}

export async function openModal(env: Env, triggerId: string, view: object): Promise<void> {
  await slackApi(env, 'views.open', { trigger_id: triggerId, view });
}

// Publish the App Home view for a specific user (idempotent, always replaces).
export async function publishHome(env: Env, userId: string): Promise<void> {
  if (!userId) return;
  const jobs = await listJobs(env, 'active');
  await slackApi(env, 'views.publish', {
    user_id: userId,
    view: { type: 'home', blocks: homeBlocks(jobs) },
  });
}

// Upload a file from R2 into a Slack thread using the v2 upload API.
export async function uploadToThread(
  env: Env, r2Key: string, channel: string, threadTs: string, title: string, comment: string,
): Promise<void> {
  const obj = await env.JOB_SOURCE.get(r2Key);
  if (!obj) return;
  const bytes = await obj.arrayBuffer();
  const filename = r2Key.split('/').pop() ?? 'file';
  const contentType = (obj.httpMetadata as { contentType?: string } | undefined)?.contentType ?? 'application/octet-stream';

  const urlParams = new URLSearchParams({ filename, length: String(bytes.byteLength) });
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: urlParams.toString(),
  }).then(r => r.json()) as { ok: boolean; upload_url?: string; file_id?: string };

  if (!urlRes.ok || !urlRes.upload_url || !urlRes.file_id) return;

  await fetch(urlRes.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });

  await slackApi(env, 'files.completeUploadExternal', {
    files: [{ id: urlRes.file_id, title }],
    channel_id: channel,
    thread_ts: threadTs,
    initial_comment: comment,
  });
}

// ---- Wake agent ------------------------------------------------------------

export async function wakeAgent(env: Env, mode: string, jobId: string | null, extra?: Record<string, unknown>): Promise<void> {
  if (!env.AGENT_WEBHOOK_URL) return;
  const body: Record<string, unknown> = { mode, ...(extra ?? {}) };
  if (jobId) {
    body.job_id = jobId;
    body.callback_url = `https://job-slack.cameronaziz.workers.dev/jobs/${jobId}/result`;
  }
  await fetch(env.AGENT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AGENT_API_TOKEN}` },
    body: JSON.stringify(body),
  });
}

// ---- Move thread -----------------------------------------------------------

export async function moveThread(env: Env, job: JobRow, destChannel: string): Promise<void> {
  if (!job.channel_id || !job.root_ts) return;

  const threadRes = await slackApi(env, 'conversations.replies', {
    channel: job.channel_id,
    ts: job.root_ts,
    limit: 100,
  }) as { messages?: Array<{ ts: string; text?: string }> };
  const messages = threadRes.messages ?? [];
  const rootText = messages[0]?.text ?? job.listing_url ?? '';

  // Post root + card to destination
  const newRootTs = await postMsg(env, destChannel, rootText);
  const movedJob = { ...job, channel_id: destChannel, root_ts: newRootTs } as JobRow;
  const newCardTs = await postMsg(env, destChannel, `${job.company ?? ''} — ${job.role ?? ''}`, cardBlocks(movedJob), newRootTs);

  // Re-upload brief + resume if stored in R2
  if (job.brief_key) {
    await uploadToThread(env, job.brief_key, destChannel, newRootTs, 'Research Brief', 'Re-attached from pipeline move.');
  }
  if (job.resume_pdf_key) {
    await uploadToThread(env, job.resume_pdf_key, destChannel, newRootTs, 'Tailored Resume', 'Re-attached from pipeline move.');
  }

  // Delete original thread (replies first, then root) — best-effort
  for (const msg of messages.slice(1).reverse()) {
    await deleteMsg(env, job.channel_id, msg.ts).catch(() => {});
  }
  await deleteMsg(env, job.channel_id, job.root_ts).catch(() => {});

  // Update D1
  const newStatus = destChannel === env.PARKING_LOT_CHANNEL ? 'parked' : 'staged';
  await updateJob(env, job.id, { status: newStatus, channel_id: destChannel, root_ts: newRootTs, card_ts: newCardTs });
}
