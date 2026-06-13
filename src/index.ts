// job-slack — interactivity + data plane for the single Conductor agent.
//
// NEW routes:
//   POST /commands/add              slash command: add a job to the pipeline
//   POST /commands/jobs             slash command: list all pipeline jobs
//   POST /slack/interactivity       all button + modal callbacks (block_actions, view_submission)
//   POST /jobs/:id/result           agent callback: surface_scan / research / tailor / refine done
//
// EXISTING routes (unchanged):
//   POST /data/*                    binding-backed Cloudflare data gateway (R2, Vectorize, AI)
//   POST /action                    surface-agnostic apply/edit core
//   GET|POST /s/a/:id              apply confirm page
//   GET|POST /s/e/:id              edit form page
//   GET /health

// ---- Types ----------------------------------------------------------------

export interface Env {
  // Storage
  JOB_SOURCE: R2Bucket;
  DB: D1Database;

  // Slack
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL: string;         // #orchestra  (C0BA8G3UFNJ)
  STAGE_CHANNEL: string;         // #orchestra-stage
  PARKING_LOT_CHANNEL: string;   // #orchestra-parking-lot
  AGENT_MENTION?: string;        // "<@U...>" if channel is mentions-only

  // Agent
  AGENT_WEBHOOK_URL: string;     // Hyperagent webhook that wakes the single conductor agent
  AGENT_API_TOKEN: string;       // shared bearer for /data/* AND /jobs/:id/result

  // Workers AI + Vectorize (data gateway)
  AI: { run: (model: string, inputs: unknown) => Promise<unknown> };
  VEC_COMPANY: VectorizeIndex;
  VEC_PEOPLE: VectorizeIndex;
  VEC_ROLE: VectorizeIndex;
  VEC_CODE: VectorizeIndex;
}

interface JobRow {
  id: string;
  listing_url: string;
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
  channel_id: string | null;
  root_ts: string | null;
  card_ts: string | null;
  html_key: string | null;
  brief_key: string | null;
  resume_pdf_key: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Slack signature verification ----------------------------------------

async function verifySlack(env: Env, rawBody: string, req: Request): Promise<boolean> {
  const ts = req.headers.get('x-slack-request-timestamp') || '';
  const sig = req.headers.get('x-slack-signature') || '';
  if (!ts || !sig) return false;

  // Replay protection: reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return false;

  const sigBase = `v0:${ts}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBase));
  const computed = 'v0=' + Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time compare
  if (computed.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---- ID generation --------------------------------------------------------

async function makeJobId(url: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return Array.from(new Uint8Array(buf)).slice(0, 6)
    .map(b => b.toString(16).padStart(2, '0')).join(''); // 12 hex chars
}

// ---- D1 helpers -----------------------------------------------------------

async function getJob(env: Env, id: string): Promise<JobRow | null> {
  return env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
}

async function createJob(env: Env, data: Partial<JobRow> & { id: string; listing_url: string }): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO jobs (id, listing_url, company, role, location, work_model, comp_text,
      scores_json, status, research_level, research_facets, tailor_state, queued_next,
      channel_id, root_ts, card_ts, html_key, brief_key, resume_pdf_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(listing_url) DO NOTHING
  `).bind(
    data.id, data.listing_url,
    data.company ?? null, data.role ?? null, data.location ?? null,
    data.work_model ?? null, data.comp_text ?? null, data.scores_json ?? null,
    data.status ?? 'scoring', data.research_level ?? 'none',
    data.research_facets ?? null, data.tailor_state ?? 'none',
    data.queued_next ?? 'none',
    data.channel_id ?? null, data.root_ts ?? null, data.card_ts ?? null,
    data.html_key ?? null, data.brief_key ?? null, data.resume_pdf_key ?? null,
  ).run();
}

async function updateJob(env: Env, id: string, data: Partial<Omit<JobRow, 'id' | 'created_at'>>): Promise<void> {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const set = entries.map(([k]) => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE jobs SET ${set}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), id).run();
}

async function listJobs(env: Env, filter?: string): Promise<JobRow[]> {
  let q = 'SELECT * FROM jobs';
  const allowed = ['active', 'staged', 'parked'];
  if (filter && allowed.includes(filter)) {
    const map: Record<string, string> = {
      active: `status NOT IN ('staged','parked','staging','parking')`,
      staged: `status = 'staged'`,
      parked: `status = 'parked'`,
    };
    q += ` WHERE ${map[filter]}`;
  }
  q += ' ORDER BY updated_at DESC LIMIT 50';
  const { results } = await env.DB.prepare(q).all<JobRow>();
  return results;
}

// ---- Block Kit helpers ----------------------------------------------------

function btn(text: string, actionId: string, value: string, style?: 'primary' | 'danger'): object {
  const b: Record<string, unknown> = {
    type: 'button',
    text: { type: 'plain_text', text, emoji: false },
    action_id: actionId,
    value,
  };
  if (style) b.style = style;
  return b;
}

function quoteBlock(text: string): object {
  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_quote', elements: [{ type: 'text', text }] }],
  };
}

function footerBlocks(job: JobRow): object[] {
  const id = job.id;

  switch (job.status) {
    case 'scoring':
      return [{ type: 'section', text: { type: 'mrkdwn', text: '_Scanning listing…_' } }];

    case 'research_depth_select':
      return [{ type: 'actions', elements: [btn('Deep', 'job_research_deep', id), btn('Surface', 'job_research_surface', id)] }];

    case 'researching': {
      const queuedTailor = job.queued_next === 'tailor_after_research';
      return [{
        type: 'section',
        text: { type: 'mrkdwn', text: 'Researching…' },
        accessory: btn(
          queuedTailor ? 'Stage when complete' : 'Tailor when complete',
          queuedTailor ? 'job_queue_stage' : 'job_queue_tailor',
          id,
        ),
      }];
    }

    case 'tailoring': {
      const queuedStage = job.queued_next === 'stage_after_tailor';
      return [{
        type: 'section',
        text: { type: 'mrkdwn', text: 'Tailoring…' },
        accessory: btn(
          queuedStage ? 'Undo Stage' : 'Stage when complete',
          queuedStage ? 'job_unqueue_stage' : 'job_queue_stage',
          id,
        ),
      }];
    }

    case 'parking':
      return [quoteBlock('Moving thread to #orchestra-parking-lot. This message and thread will soon be deleted.')];

    case 'staging':
      return [quoteBlock('Moving thread to #orchestra-stage. This message and thread will soon be deleted.')];

    default: { // scored, researched, tailored, and any unknown
      const elements: object[] = [];

      if (job.research_level === 'none') {
        elements.push(btn('Research', 'job_research', id));
      } else if (job.research_level === 'surface') {
        elements.push(btn('Deep Research', 'job_research_deep', id));
      }
      // research_level === 'deep': no research button — already at max depth

      elements.push(
        job.tailor_state === 'done'
          ? btn('Refine', 'job_refine', id, 'primary')
          : btn('Tailor', 'job_tailor', id, 'primary'),
      );
      elements.push(btn('Park', 'job_park', id));
      elements.push(btn('Stage', 'job_stage', id));

      return [{ type: 'actions', elements }];
    }
  }
}

function cardBlocks(job: JobRow): object[] {
  // Header: immutable
  const title = job.company && job.role
    ? `*${job.company}* — ${job.role}`
    : '_Scanning listing…_';
  const header: object = {
    type: 'section',
    text: { type: 'mrkdwn', text: `${title}\n<${job.listing_url}|View listing>` },
  };

  // Scores: immutable once set
  const blocks: object[] = [header];
  if (job.scores_json) {
    try {
      const s = JSON.parse(job.scores_json) as Record<string, string>;
      const fields: object[] = [];
      if (s.comp) fields.push({ type: 'mrkdwn', text: `*Comp*\n${s.comp}` });
      if (s.work_model) fields.push({ type: 'mrkdwn', text: `*Work Model*\n${s.work_model}` });
      if (s.commute) fields.push({ type: 'mrkdwn', text: `*Commute*\n${s.commute}` });
      if (s.stack) fields.push({ type: 'mrkdwn', text: `*Stack*\n${s.stack}` });
      if (s.notes) fields.push({ type: 'mrkdwn', text: `*Notes*\n${s.notes}` });
      if (fields.length) blocks.push({ type: 'section', fields });
    } catch { /* skip malformed scores */ }
  }

  blocks.push({ type: 'divider' });
  blocks.push(...footerBlocks(job));
  return blocks;
}

function deepResearchModal(jobId: string, company: string): object {
  return {
    type: 'modal',
    callback_id: 'deep_research_modal',
    private_metadata: jobId,
    title: { type: 'plain_text', text: 'Deep Research' },
    submit: { type: 'plain_text', text: 'Research' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `Select research facets${company ? ` for *${company}*` : ''}:` },
      },
      {
        type: 'input',
        block_id: 'facets',
        label: { type: 'plain_text', text: 'Facets' },
        element: {
          type: 'checkboxes',
          action_id: 'facets_input',
          initial_options: [
            { text: { type: 'plain_text', text: 'Vision' }, value: 'vision' },
            { text: { type: 'plain_text', text: 'Funding' }, value: 'funding' },
          ],
          options: [
            { text: { type: 'plain_text', text: 'Vision' }, value: 'vision' },
            { text: { type: 'plain_text', text: 'Funding' }, value: 'funding' },
            { text: { type: 'plain_text', text: 'Moat' }, value: 'moat' },
            { text: { type: 'plain_text', text: 'Hiring & Leadership Team' }, value: 'hiring_leadership' },
            { text: { type: 'plain_text', text: 'Culture' }, value: 'culture' },
            {
              text: { type: 'plain_text', text: 'Friction / Red Flags' },
              description: { type: 'plain_text', text: 'Lawsuits, compliance issues, complaints' },
              value: 'red_flags',
            },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'extra',
        optional: true,
        label: { type: 'plain_text', text: 'Anything specific to look into?' },
        element: {
          type: 'plain_text_input',
          action_id: 'extra_input',
          placeholder: { type: 'plain_text', text: 'e.g. recent layoffs, specific product concerns' },
        },
      },
    ],
  };
}

function refineModal(jobId: string, company: string, role: string): object {
  return {
    type: 'modal',
    callback_id: 'refine_modal',
    private_metadata: jobId,
    title: { type: 'plain_text', text: 'Refine Resume' },
    submit: { type: 'plain_text', text: 'Refine' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `What should change${company ? ` for *${company}${role ? ` — ${role}` : ''}*` : ''}?`,
        },
      },
      {
        type: 'input',
        block_id: 'feedback',
        label: { type: 'plain_text', text: 'Changes' },
        element: {
          type: 'plain_text_input',
          action_id: 'feedback_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'e.g. Lead with the design system work, drop the Kubernetes bullet, tighten the summary…',
          },
        },
      },
    ],
  };
}

function jobsListBlocks(jobs: JobRow[], filter: string): object[] {
  const label = filter && filter !== 'active' ? ` — ${filter}` : '';
  if (!jobs.length) {
    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: `*Pipeline${label}* — no jobs found.` },
    }];
  }

  const statusEmoji: Record<string, string> = {
    scoring: '⏳', scored: '📋',
    research_depth_select: '🔎',
    researching: '🔬', researched: '📊',
    tailoring: '✏️', tailored: '📄',
    staging: '🚀', staged: '✅',
    parking: '🅿️', parked: '🗄️',
  };

  const blocks: object[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Pipeline${label}* — ${jobs.length} job${jobs.length !== 1 ? 's' : ''}` } },
    { type: 'divider' },
  ];

  for (const job of jobs) {
    const emoji = statusEmoji[job.status] ?? '•';
    const comp = job.comp_text ? ` · ${job.comp_text}` : '';
    const model = job.work_model ? ` · ${job.work_model}` : '';
    const text = `${emoji} *${job.company ?? 'Unknown'}* — ${job.role ?? 'Role TBD'}${comp}\n${job.status}${model}`;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text },
      accessory: {
        type: 'overflow',
        action_id: 'jobs_overflow',
        options: [
          { text: { type: 'plain_text', text: '→ Open thread' }, value: `open:${job.id}` },
          { text: { type: 'plain_text', text: '🚀 Stage' }, value: `stage:${job.id}` },
          { text: { type: 'plain_text', text: '🅿️ Park' }, value: `park:${job.id}` },
          { text: { type: 'plain_text', text: '🗑 Delete' }, value: `delete:${job.id}` },
        ],
      },
    });
  }

  return blocks;
}

// ---- Slack API helpers ----------------------------------------------------

async function slackApi(env: Env, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function postMsg(env: Env, channel: string, text: string, blocks?: object[], threadTs?: string): Promise<string> {
  const body: Record<string, unknown> = { channel, text };
  if (blocks?.length) body.blocks = blocks;
  if (threadTs) body.thread_ts = threadTs;
  const r = await slackApi(env, 'chat.postMessage', body);
  return (r.ts as string) ?? '';
}

async function updateMsg(env: Env, channel: string, ts: string, text: string, blocks: object[]): Promise<void> {
  await slackApi(env, 'chat.update', { channel, ts, text, blocks });
}

async function deleteMsg(env: Env, channel: string, ts: string): Promise<void> {
  await slackApi(env, 'chat.delete', { channel, ts });
}

async function openModal(env: Env, triggerId: string, view: object): Promise<void> {
  await slackApi(env, 'views.open', { trigger_id: triggerId, view });
}

// Upload a file from R2 to a Slack thread using the v2 upload API.
async function uploadToThread(
  env: Env, r2Key: string, channel: string, threadTs: string, title: string, comment: string,
): Promise<void> {
  const obj = await env.JOB_SOURCE.get(r2Key);
  if (!obj) return;
  const bytes = await obj.arrayBuffer();
  const filename = r2Key.split('/').pop() ?? 'file';
  const contentType = (obj.httpMetadata as { contentType?: string } | undefined)?.contentType ?? 'application/octet-stream';

  // Step 1: get an upload URL
  const urlParams = new URLSearchParams({ filename, length: String(bytes.byteLength) });
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: urlParams.toString(),
  }).then(r => r.json()) as { ok: boolean; upload_url?: string; file_id?: string };

  if (!urlRes.ok || !urlRes.upload_url || !urlRes.file_id) return;

  // Step 2: upload bytes to the pre-signed URL
  await fetch(urlRes.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });

  // Step 3: complete — shares into the thread
  await slackApi(env, 'files.completeUploadExternal', {
    files: [{ id: urlRes.file_id, title }],
    channel_id: channel,
    thread_ts: threadTs,
    initial_comment: comment,
  });
}

// ---- Wake agent -----------------------------------------------------------

async function wakeAgent(env: Env, mode: string, jobId: string, extra?: Record<string, unknown>): Promise<void> {
  if (!env.AGENT_WEBHOOK_URL) return;
  await fetch(env.AGENT_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.AGENT_API_TOKEN}`,
    },
    body: JSON.stringify({
      mode,
      job_id: jobId,
      callback_url: `https://job-slack.cameronaziz.workers.dev/jobs/${jobId}/result`,
      ...(extra ?? {}),
    }),
  });
}

// ---- Move thread ----------------------------------------------------------

async function moveThread(env: Env, job: JobRow, destChannel: string): Promise<void> {
  if (!job.channel_id || !job.root_ts) return;

  // Fetch all thread messages so we can collect every ts to delete
  const threadRes = await slackApi(env, 'conversations.replies', {
    channel: job.channel_id,
    ts: job.root_ts,
    limit: 100,
  }) as { messages?: Array<{ ts: string; text?: string }> };
  const messages = threadRes.messages ?? [];
  const rootText = messages[0]?.text ?? job.listing_url ?? '';

  // 1. Post root to destination
  const newRootTs = await postMsg(env, destChannel, rootText);

  // 2. Post card as first thread reply
  const movedJob = { ...job, channel_id: destChannel, root_ts: newRootTs };
  const newCardTs = await postMsg(env, destChannel, `${job.company ?? ''} — ${job.role ?? ''}`, cardBlocks(movedJob as JobRow), newRootTs);

  // 3. Re-upload brief + resume from R2 if available
  if (job.brief_key) {
    await uploadToThread(env, job.brief_key, destChannel, newRootTs, 'Research Brief', 'Re-attached from pipeline move.');
  }
  if (job.resume_pdf_key) {
    await uploadToThread(env, job.resume_pdf_key, destChannel, newRootTs, 'Tailored Resume', 'Re-attached from pipeline move.');
  }

  // 4. Delete original thread (replies first, then root)
  for (const msg of messages.slice(1).reverse()) {
    await deleteMsg(env, job.channel_id, msg.ts).catch(() => {/* best-effort */});
  }
  await deleteMsg(env, job.channel_id, job.root_ts).catch(() => {/* best-effort */});

  // 5. Update D1
  const newStatus = destChannel === env.PARKING_LOT_CHANNEL ? 'parked' : 'staged';
  await updateJob(env, job.id, {
    status: newStatus,
    channel_id: destChannel,
    root_ts: newRootTs,
    card_ts: newCardTs,
  });
}

// ---- /commands/add --------------------------------------------------------

async function handleAddCommand(env: Env, payload: Record<string, string>): Promise<void> {
  const url = (payload.text ?? '').trim();
  if (!url) {
    // Use response_url for ephemeral feedback
    await fetch(payload.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text: 'Usage: `/add {job listing URL}`' }),
    });
    return;
  }

  const id = await makeJobId(url);
  const channel = env.SLACK_CHANNEL;

  // Dedup: if a record already exists for this URL, link to the existing thread
  const existing = await env.DB.prepare('SELECT * FROM jobs WHERE listing_url = ?').bind(url).first<JobRow>();
  if (existing) {
    await fetch(payload.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: existing.root_ts
          ? `Already in pipeline — <slack://channel?team=${payload.team_id}&id=${channel}&message=${existing.root_ts}|open thread>`
          : 'Already in pipeline.',
      }),
    });
    return;
  }

  // 1. Create D1 row immediately (status: scoring)
  await createJob(env, { id, listing_url: url, channel_id: channel, status: 'scoring' });

  // 2. Post root message (the listing URL) as a regular channel message
  const rootTs = await postMsg(env, channel, url);

  // 3. Post scanning card as first thread reply
  const scanningJob: JobRow = {
    id, listing_url: url, company: null, role: null, location: null,
    work_model: null, comp_text: null, scores_json: null,
    status: 'scoring', research_level: 'none', research_facets: null,
    tailor_state: 'none', queued_next: 'none',
    channel_id: channel, root_ts: rootTs, card_ts: null,
    html_key: null, brief_key: null, resume_pdf_key: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const cardTs = await postMsg(env, channel, 'Scanning…', cardBlocks(scanningJob), rootTs);

  // 4. Persist Slack coordinates
  await updateJob(env, id, { root_ts: rootTs, card_ts: cardTs });

  // 5. Wake agent for surface scan
  await wakeAgent(env, 'surface_scan', id, { listing_url: url });
}

// ---- /commands/jobs -------------------------------------------------------

async function handleJobsCommand(env: Env, payload: Record<string, string>): Promise<void> {
  const filter = (payload.text ?? '').trim().toLowerCase() || 'active';
  const jobs = await listJobs(env, filter);
  const blocks = jobsListBlocks(jobs, filter);
  await postMsg(env, payload.channel_id, `Pipeline — ${jobs.length} jobs`, blocks);
}

// ---- Interactivity --------------------------------------------------------

async function handleInteractivity(env: Env, payload: Record<string, unknown>): Promise<void> {
  // Modal submission
  if (payload.type === 'view_submission') {
    const view = payload.view as Record<string, unknown>;
    const jobId = view.private_metadata as string;
    const values = (view.state as Record<string, unknown>).values as Record<string, Record<string, { selected_options?: Array<{ value: string }>; value?: string }>>;

    if (view.callback_id === 'deep_research_modal') {
      const facets = (values.facets?.facets_input?.selected_options ?? []).map(o => o.value);
      const extra = values.extra?.extra_input?.value ?? '';
      const job = await getJob(env, jobId);
      if (!job?.channel_id || !job.card_ts) return;

      await updateJob(env, jobId, {
        status: 'researching',
        research_level: 'deep',
        research_facets: JSON.stringify({ facets, extra }),
        queued_next: 'none',
      });
      const updated = await getJob(env, jobId);
      await updateMsg(env, job.channel_id, job.card_ts, 'Researching…', cardBlocks(updated!));
      await wakeAgent(env, 'deep_research', jobId, { facets, extra });
    }

    if (view.callback_id === 'refine_modal') {
      const feedback = values.feedback?.feedback_input?.value ?? '';
      const job = await getJob(env, jobId);
      if (!job?.channel_id || !job.card_ts) return;

      await updateJob(env, jobId, { status: 'tailoring', tailor_state: 'in_progress' });
      const updated = await getJob(env, jobId);
      await updateMsg(env, job.channel_id, job.card_ts, 'Tailoring…', cardBlocks(updated!));
      await wakeAgent(env, 'refine', jobId, { feedback });
    }
    return;
  }

  // Button click
  if (payload.type === 'block_actions') {
    const actions = payload.actions as Array<Record<string, unknown>>;
    const action = actions[0];
    const actionId = action.action_id as string;
    const triggerId = payload.trigger_id as string;
    const container = payload.container as Record<string, string>;
    const channel = container?.channel_id;
    const cardTs = container?.message_ts;

    // /jobs board overflow menu
    if (actionId === 'jobs_overflow') {
      const selected = (action.selected_option as Record<string, string>).value;
      const [act, ovJobId] = selected.split(':');
      const job = await getJob(env, ovJobId);
      if (!job) return;

      if (act === 'stage' && env.STAGE_CHANNEL) {
        await updateJob(env, ovJobId, { status: 'staging' });
        const updated = await getJob(env, ovJobId);
        if (job.channel_id && job.card_ts)
          await updateMsg(env, job.channel_id, job.card_ts, 'Moving…', cardBlocks(updated!));
        await moveThread(env, updated!, env.STAGE_CHANNEL);
      } else if (act === 'park' && env.PARKING_LOT_CHANNEL) {
        await updateJob(env, ovJobId, { status: 'parking' });
        const updated = await getJob(env, ovJobId);
        if (job.channel_id && job.card_ts)
          await updateMsg(env, job.channel_id, job.card_ts, 'Parking…', cardBlocks(updated!));
        await moveThread(env, updated!, env.PARKING_LOT_CHANNEL);
      } else if (act === 'delete') {
        if (job.card_ts && job.channel_id) await deleteMsg(env, job.channel_id, job.card_ts).catch(() => {});
        if (job.root_ts && job.channel_id) await deleteMsg(env, job.channel_id, job.root_ts).catch(() => {});
        await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(ovJobId).run();
      }
      // 'open' — no-op from worker side; Slack handles the permalink
      return;
    }

    // Job card buttons — all carry the job id as value
    const jobId = action.value as string;
    const job = await getJob(env, jobId);
    if (!job) return;

    // Use container coords as primary; fall back to job record
    const ch = channel ?? job.channel_id ?? '';
    const ct = cardTs ?? job.card_ts ?? '';

    switch (actionId) {
      case 'job_research': {
        await updateJob(env, jobId, { status: 'research_depth_select' });
        const updated = await getJob(env, jobId);
        await updateMsg(env, ch, ct, 'Choose depth', cardBlocks(updated!));
        break;
      }

      case 'job_research_deep': {
        // Open deep research modal — must happen synchronously before trigger_id expires
        await openModal(env, triggerId, deepResearchModal(jobId, job.company ?? ''));
        break;
      }

      case 'job_research_surface': {
        await updateJob(env, jobId, { status: 'researching', research_level: 'surface', queued_next: 'none' });
        const updated = await getJob(env, jobId);
        await updateMsg(env, ch, ct, 'Researching…', cardBlocks(updated!));
        await wakeAgent(env, 'surface_research', jobId);
        break;
      }

      case 'job_tailor': {
        await updateJob(env, jobId, { status: 'tailoring', tailor_state: 'in_progress', queued_next: 'none' });
        const updated = await getJob(env, jobId);
        await updateMsg(env, ch, ct, 'Tailoring…', cardBlocks(updated!));
        await wakeAgent(env, 'tailor', jobId);
        break;
      }

      case 'job_refine': {
        await openModal(env, triggerId, refineModal(jobId, job.company ?? '', job.role ?? ''));
        break;
      }

      case 'job_queue_tailor': {
        await updateJob(env, jobId, { queued_next: 'tailor_after_research' });
        const updated = await getJob(env, jobId);
        await updateMsg(env, ch, ct, 'Research + Tailor queued', cardBlocks(updated!));
        break;
      }

      case 'job_queue_stage': {
        await updateJob(env, jobId, { queued_next: 'stage_after_tailor' });
        const updated = await getJob(env, jobId);
        await updateMsg(env, ch, ct, 'Stage queued', cardBlocks(updated!));
        break;
      }

      case 'job_unqueue_stage': {
        await updateJob(env, jobId, { queued_next: 'none' });
        const updated = await getJob(env, jobId);
        await updateMsg(env, ch, ct, 'Stage unqueued', cardBlocks(updated!));
        break;
      }

      case 'job_park': {
        if (!env.PARKING_LOT_CHANNEL) break;
        await updateJob(env, jobId, { status: 'parking' });
        const updated = await getJob(env, jobId);
        await updateMsg(env, ch, ct, 'Parking…', cardBlocks(updated!));
        await moveThread(env, updated!, env.PARKING_LOT_CHANNEL);
        break;
      }

      case 'job_stage': {
        if (!env.STAGE_CHANNEL) break;
        await updateJob(env, jobId, { status: 'staging' });
        const updated = await getJob(env, jobId);
        await updateMsg(env, ch, ct, 'Staging…', cardBlocks(updated!));
        await moveThread(env, updated!, env.STAGE_CHANNEL);
        break;
      }
    }
  }
}

// ---- Agent result callback (/jobs/:id/result) ----------------------------

async function handleJobResult(env: Env, id: string, body: Record<string, unknown>): Promise<Response> {
  const job = await getJob(env, id);
  if (!job) return new Response(JSON.stringify({ error: 'job not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  if (!job.channel_id || !job.card_ts) return new Response(JSON.stringify({ error: 'no slack coordinates' }), { status: 422, headers: { 'Content-Type': 'application/json' } });

  const ch = job.channel_id;
  const ct = job.card_ts;
  const rootTs = job.root_ts ?? '';

  if (body.type === 'surface_scan') {
    // Agent finished scanning — update the card from "Scanning" to scored
    const scores: Record<string, string> = {};
    if (body.comp) scores.comp = body.comp as string;
    const wm = [body.work_model, body.location].filter(Boolean).join(' · ');
    if (wm) scores.work_model = wm;
    if (body.commute) scores.commute = body.commute as string;
    if (body.stack) scores.stack = body.stack as string;
    if (body.notes) scores.notes = body.notes as string;

    await updateJob(env, id, {
      company: (body.company as string) || job.company,
      role: (body.role as string) || job.role,
      location: (body.location as string) || job.location,
      work_model: (body.work_model as string) || job.work_model,
      comp_text: (body.comp as string) || job.comp_text,
      scores_json: JSON.stringify(scores),
      status: 'scored',
    });
    const updated = await getJob(env, id);
    await updateMsg(env, ch, ct, `${updated!.company ?? ''} — ${updated!.role ?? ''}`, cardBlocks(updated!));
  }

  if (body.type === 'research') {
    const queuedTailor = job.queued_next === 'tailor_after_research';
    await updateJob(env, id, {
      status: queuedTailor ? 'tailoring' : 'researched',
      brief_key: (body.brief_key as string) || job.brief_key,
      tailor_state: queuedTailor ? 'in_progress' : job.tailor_state,
      queued_next: 'none',
    });
    const updated = await getJob(env, id);
    await updateMsg(env, ch, ct, 'Research complete', cardBlocks(updated!));

    // Post brief as thread reply
    if (body.brief_key && rootTs) {
      await uploadToThread(env, body.brief_key as string, ch, rootTs,
        'Research Brief', (body.summary as string) || 'Research complete.');
    } else if (body.summary && rootTs) {
      await postMsg(env, ch, body.summary as string, undefined, rootTs);
    }

    if (queuedTailor) await wakeAgent(env, 'tailor', id);
  }

  if (body.type === 'tailor' || body.type === 'refine') {
    const queuedStage = job.queued_next === 'stage_after_tailor';
    await updateJob(env, id, {
      status: 'tailored',
      tailor_state: 'done',
      resume_pdf_key: (body.resume_pdf_key as string) || job.resume_pdf_key,
      queued_next: 'none',
    });
    const updated = await getJob(env, id);
    await updateMsg(env, ch, ct, 'Tailoring complete', cardBlocks(updated!));

    // Post resume PDF as thread reply
    if (body.resume_pdf_key && rootTs) {
      await uploadToThread(env, body.resume_pdf_key as string, ch, rootTs,
        'Tailored Resume', (body.decisions as string) || 'Tailoring complete.');
    }

    if (queuedStage && env.STAGE_CHANNEL) {
      const stageJob = await getJob(env, id);
      if (stageJob) {
        await updateJob(env, id, { status: 'staging' });
        await updateMsg(env, ch, ct, 'Staging…', cardBlocks({ ...stageJob, status: 'staging' } as JobRow));
        await moveThread(env, stageJob, env.STAGE_CHANNEL);
      }
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

// ---- Data gateway (unchanged from original) ------------------------------

const JSON_H = { 'Content-Type': 'application/json' };
const dj = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_H });
const EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';

function vecIndex(env: Env, name: string): VectorizeIndex | null {
  switch (String(name ?? '').toLowerCase()) {
    case 'company': case 'job-company': return env.VEC_COMPANY;
    case 'people': case 'person': case 'job-people': return env.VEC_PEOPLE;
    case 'role': case 'job-role': return env.VEC_ROLE;
    case 'code': case 'rag': case 'source-code-rag': return env.VEC_CODE;
    default: return null;
  }
}

async function embedText(env: Env, text: string | string[]): Promise<number[][]> {
  const input = Array.isArray(text) ? text : [text];
  const res = await env.AI.run(EMBED_MODEL, { text: input }) as { data?: number[][] } | number[][];
  return (Array.isArray(res) ? res : ((res as { data?: number[][] }).data ?? [])) as number[][];
}

function bearerOk(req: Request, env: Env): boolean {
  const h = req.headers.get('Authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return Boolean(env.AGENT_API_TOKEN) && tok === env.AGENT_API_TOKEN;
}

async function handleData(req: Request, env: Env, url: URL): Promise<Response> {
  if (!bearerOk(req, env)) return dj({ error: 'unauthorized' }, 401);
  const p = url.pathname;

  if (req.method === 'POST' && p === '/data/embed') {
    const b = await req.json().catch(() => ({})) as { text?: string | string[] };
    if (b.text === undefined) return dj({ error: 'missing text' }, 400);
    const vectors = await embedText(env, b.text);
    return dj({ dim: vectors[0]?.length ?? 0, vectors, vector: vectors[0] });
  }

  if (req.method === 'POST' && p === '/data/vector/query') {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const idx = vecIndex(env, b.index as string);
    if (!idx) return dj({ error: `unknown index: ${b.index}` }, 400);
    let vector = b.vector as number[] | undefined;
    if (!vector && b.text !== undefined) vector = (await embedText(env, b.text as string))[0];
    if (!vector) return dj({ error: 'provide text or vector' }, 400);
    const opts: Record<string, unknown> = { topK: b.topK ?? 5, returnMetadata: b.returnMetadata ?? 'all', returnValues: b.returnValues ?? false };
    if (b.filter) opts.filter = b.filter;
    const r = await idx.query(vector, opts) as { count: number; matches: unknown[] };
    return dj({ count: r.count, matches: r.matches ?? [] });
  }

  if (req.method === 'POST' && p === '/data/vector/upsert') {
    const b = await req.json().catch(() => ({})) as { index?: string; records?: Array<Record<string, unknown>> };
    const idx = vecIndex(env, b.index ?? '');
    if (!idx) return dj({ error: `unknown index: ${b.index}` }, 400);
    const records = Array.isArray(b.records) ? b.records : [];
    if (!records.length) return dj({ error: 'no records' }, 400);
    const pending = records.filter(r => !r.values && r.text !== undefined);
    if (pending.length) {
      const vecs = await embedText(env, pending.map(r => r.text as string));
      pending.forEach((r, i) => { r.values = vecs[i]; });
    }
    const vectors = records.map(r => ({ id: r.id as string, values: r.values as number[], metadata: (r.metadata as Record<string, unknown>) ?? {} }));
    const m = await idx.upsert(vectors) as { mutationId?: string };
    return dj({ mutationId: m?.mutationId, count: vectors.length });
  }

  if (req.method === 'GET' && p === '/data/r2/list') {
    const ls = await env.JOB_SOURCE.list({
      prefix: url.searchParams.get('prefix') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: 1000,
    });
    return dj({ keys: (ls.objects ?? []).map(o => o.key), truncated: ls.truncated, cursor: ls.truncated ? ls.cursor : undefined });
  }

  if (p === '/data/r2') {
    const key = url.searchParams.get('key');
    if (!key) return dj({ error: 'missing key' }, 400);
    if (req.method === 'GET') {
      const obj = await env.JOB_SOURCE.get(key);
      if (!obj) return dj({ error: 'not found', key }, 404);
      return new Response(obj.body, { headers: { 'Content-Type': (obj.httpMetadata as { contentType?: string } | undefined)?.contentType ?? 'application/octet-stream' } });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const ct = url.searchParams.get('contentType') ?? req.headers.get('Content-Type') ?? 'application/octet-stream';
      const body = await req.arrayBuffer();
      await env.JOB_SOURCE.put(key, body, { httpMetadata: { contentType: ct } });
      return dj({ ok: true, key, size: body.byteLength });
    }
    return dj({ error: 'method not allowed' }, 405);
  }

  return dj({ error: 'not found' }, 404);
}

// ---- Apply/edit pages (unchanged from original) --------------------------

const HTML = { 'Content-Type': 'text/html; charset=utf-8' };
const keyFor = (id: string) => `apply/submissions/${id}.json`;

async function getSubmission(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const obj = await env.JOB_SOURCE.get(keyFor(id));
  return obj ? obj.json() as Promise<Record<string, unknown>> : null;
}

async function putSubmission(env: Env, id: string, data: Record<string, unknown>): Promise<void> {
  data.updated_at = new Date().toISOString();
  await env.JOB_SOURCE.put(keyFor(id), JSON.stringify(data, null, 2), { httpMetadata: { contentType: 'application/json' } });
}

type Action = 'apply_requested' | 'edit_updated' | 'input_provided';

async function notifyAgent(env: Env, action: Action, id: string): Promise<void> {
  const mention = env.AGENT_MENTION ? `${env.AGENT_MENTION} ` : '';
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL, text: `${mention}apply-worker | ${action} | ${id}` }),
  });
}

async function handleAction(env: Env, input: { action: Action; submissionId: string; token: string; payload?: Record<string, string> }): Promise<{ ok: boolean; status?: number; error?: string }> {
  const sub = await getSubmission(env, input.submissionId);
  if (!sub) return { ok: false, status: 404, error: 'submission not found' };
  if (!sub.token || sub.token !== input.token) return { ok: false, status: 403, error: 'bad token' };

  if (input.action === 'apply_requested') {
    sub.status = 'submitting';
  } else if (input.action === 'edit_updated' || input.action === 'input_provided') {
    const p = input.payload ?? {};
    sub.fields = ((sub.fields as Array<Record<string, unknown>>) ?? []).map(f => p[f.name as string] !== undefined ? { ...f, value: p[f.name as string], source: 'user' } : f);
    sub.missing = ((sub.missing as string[]) ?? []).filter(n => !(n in p));
    sub.status = input.action === 'edit_updated' ? 'editing' : 'awaiting_input';
  } else {
    return { ok: false, status: 400, error: 'unknown action' };
  }

  await putSubmission(env, input.submissionId, sub);
  await notifyAgent(env, input.action, input.submissionId);
  return { ok: true };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const page = (title: string, body: string) =>
  `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
  `<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:640px;margin:6vh auto;padding:0 5%;color:#111}` +
  `h1{font-size:1.4rem}label{display:block;font-weight:600;margin:18px 0 6px}` +
  `textarea{width:100%;min-height:64px;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit;box-sizing:border-box}` +
  `button{margin-top:24px;padding:12px 22px;border:0;border-radius:10px;background:#111;color:#fff;font:inherit;cursor:pointer}` +
  `.ok{color:#0a7}.muted{color:#666}</style>${body}`;

const confirmPage = (sub: Record<string, unknown>, token: string) =>
  page('Submit application',
    `<h1>Submit application to ${esc(sub.company)}?</h1>` +
    `<p class=muted>${esc(sub.role)} &middot; ${esc(sub.ats)}</p>` +
    `<form method=POST><input type=hidden name=token value="${esc(token)}"><button type=submit>Confirm and submit</button></form>`);

const editPage = (sub: Record<string, unknown>, token: string) => {
  const inputs = ((sub.fields as Array<Record<string, unknown>>) ?? [])
    .filter(f => f.class !== 'file')
    .map(f => `<label>${esc(f.label)}${f.required ? ' *' : ''}</label><textarea name="${esc(f.name)}">${esc(f.value)}</textarea>`)
    .join('');
  return page('Edit application',
    `<h1>Edit application</h1><p class=muted>${esc(sub.company)} &middot; ${esc(sub.role)}</p>` +
    `<form method=POST><input type=hidden name=token value="${esc(token)}">${inputs}<button type=submit>Save changes</button></form>`);
};

// ---- Main fetch handler --------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/health') return new Response('ok');

    // Data gateway
    if (p === '/data' || p.startsWith('/data/')) return handleData(req, env, url);

    // Agent result callback — bearer-authenticated, no Slack sig needed
    const resultMatch = p.match(/^\/jobs\/([^/]+)\/result$/);
    if (resultMatch && req.method === 'POST') {
      if (!bearerOk(req, env)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_H });
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      return handleJobResult(env, resultMatch[1], body);
    }

    // All Slack-originated routes — verify signature first
    const rawBody = await req.text();
    if (env.SLACK_SIGNING_SECRET) {
      const valid = await verifySlack(env, rawBody, req);
      if (!valid) return new Response('Forbidden', { status: 403 });
    }

    // Slash commands
    if (req.method === 'POST' && p.startsWith('/commands/')) {
      const payload = Object.fromEntries(new URLSearchParams(rawBody));
      const cmd = p.slice('/commands/'.length);

      if (cmd === 'add') {
        ctx.waitUntil(handleAddCommand(env, payload));
        return new Response('', { status: 200 }); // Slack ack
      }
      if (cmd === 'jobs') {
        ctx.waitUntil(handleJobsCommand(env, payload));
        return new Response('', { status: 200 });
      }
      return new Response('Unknown command', { status: 404 });
    }

    // Interactivity (buttons + modals)
    if (req.method === 'POST' && p === '/slack/interactivity') {
      const form = new URLSearchParams(rawBody);
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(form.get('payload') ?? '{}'); } catch { return new Response('Bad payload', { status: 400 }); }

      // For modal-opening actions, views.open must be called while trigger_id is still valid.
      // Open the modal synchronously; let the card update happen in the background.
      const action = (payload.type === 'block_actions')
        ? ((payload.actions as Array<Record<string, unknown>>)?.[0]?.action_id as string)
        : null;

      if (action === 'job_research_deep' || action === 'job_refine') {
        // Open modal before acking — trigger_id expires in 3s
        await handleInteractivity(env, payload);
        return new Response('', { status: 200 });
      }

      ctx.waitUntil(handleInteractivity(env, payload));
      return new Response('', { status: 200 });
    }

    // Surface-agnostic action endpoint (for Conductor apply flow)
    if (req.method === 'POST' && p === '/action') {
      const body = JSON.parse(rawBody || '{}') as { action: Action; submissionId: string; token: string; payload?: Record<string, string> };
      const r = await handleAction(env, body);
      return new Response(JSON.stringify(r), { status: r.ok ? 200 : r.status ?? 400, headers: JSON_H });
    }

    // Apply + edit pages
    const parts = p.split('/').filter(Boolean);
    if (parts[0] === 's' && parts.length === 3) {
      const [, kind, id] = parts;
      const token = url.searchParams.get('t') ?? '';
      const sub = await getSubmission(env, id);
      if (!sub) return new Response(page('Not found', '<h1>Application not found</h1>'), { status: 404, headers: HTML });
      if (sub.token !== token) return new Response(page('Forbidden', '<h1>Invalid or expired link</h1>'), { status: 403, headers: HTML });

      if (req.method === 'GET') {
        return new Response(kind === 'a' ? confirmPage(sub, token) : editPage(sub, token), { headers: HTML });
      }
      if (req.method === 'POST') {
        const form = new URLSearchParams(rawBody);
        const ptoken = String(form.get('token') ?? '');
        if (ptoken !== sub.token) return new Response(page('Forbidden', '<h1>Invalid token</h1>'), { status: 403, headers: HTML });
        if (kind === 'a') {
          await handleAction(env, { action: 'apply_requested', submissionId: id, token: ptoken });
          return new Response(page('Submitting', `<h1 class=ok>Applying now</h1><p>Watch #orchestra for the confirmation.</p>`), { headers: HTML });
        }
        const pp: Record<string, string> = {};
        for (const [k, v] of form.entries()) if (k !== 'token') pp[k] = String(v);
        await handleAction(env, { action: 'edit_updated', submissionId: id, token: ptoken, payload: pp });
        return new Response(page('Saved', `<h1 class=ok>Changes saved</h1><p>The review in #orchestra will refresh.</p>`), { headers: HTML });
      }
    }

    return new Response('not found', { status: 404 });
  },
};
