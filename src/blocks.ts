// ---- Block Kit builders ---------------------------------------------------

import type { JobRow } from './types';

export function btn(text: string, actionId: string, value: string, style?: 'primary' | 'danger'): object {
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

// Footer blocks — the mutable bottom portion of the card (and home row).
// Returns an array of one block: either an actions block, a section-with-accessory,
// or a rich_text blockquote depending on job state.
export function footerBlocks(job: JobRow): object[] {
  const id = job.id;

  switch (job.status) {
    case 'scoring':
      return [{ type: 'section', text: { type: 'mrkdwn', text: '_Scanning listing…_' } }];

    case 'research_depth_select':
      return [{
        type: 'actions',
        elements: [btn('Deep', 'job_research_deep', id), btn('Surface', 'job_research_surface', id)],
      }];

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

    default: { // scored, researched, tailored — the normal action bar
      const elements: object[] = [];

      if (job.research_level === 'none') {
        elements.push(btn('Research', 'job_research', id));
      } else if (job.research_level === 'surface') {
        elements.push(btn('Deep Research', 'job_research_deep', id));
      }
      // research_level === 'deep': already at max depth, no research button

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

// Full card blocks (scores + footer). Posted as a thread reply; edited in-place.
export function cardBlocks(job: JobRow): object[] {
  const title = job.company && job.role
    ? `*${job.company}* — ${job.role}`
    : '_Scanning listing…_';
  const header: object = {
    type: 'section',
    text: { type: 'mrkdwn', text: `${title}\n<${job.listing_url}|View listing>` },
  };

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
    } catch { /* skip */ }
  }

  blocks.push({ type: 'divider' });
  blocks.push(...footerBlocks(job));
  return blocks;
}

// ---- App Home blocks -------------------------------------------------------

// One row per job, matching the user's mockup:
//   divider
//   section: *Company*  <link|Role>  comp  stack-hint     [View]
//   actions: [Research] [Tailor] [Park] [Stage]  (or holding/moving state)
export function homeBlocks(jobs: JobRow[]): object[] {
  if (!jobs.length) {
    return [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Pipeline*\n_No jobs yet. Use `/add {url}` in #orchestra to get started._',
      },
    }];
  }

  const blocks: object[] = [{
    type: 'section',
    text: { type: 'mrkdwn', text: `*Pipeline — ${jobs.length} job${jobs.length !== 1 ? 's' : ''}*` },
  }];

  for (const job of jobs) {
    blocks.push({ type: 'divider' });

    let hint = '';
    if (job.scores_json) {
      try {
        const s = JSON.parse(job.scores_json) as Record<string, string>;
        const parts: string[] = [];
        if (s.comp) parts.push(s.comp);
        if (s.stack) parts.push(s.stack);
        if (parts.length) hint = `\n${parts.join('  ·  ')}`;
      } catch { /* skip */ }
    }

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${job.company ?? 'Unknown Company'}*\n<${job.listing_url}|${job.role ?? 'View listing'}>${hint}`,
      },
      accessory: btn('View', 'job_view_modal', job.id),
    });

    blocks.push(...footerBlocks(job));
  }

  blocks.push({ type: 'divider' });
  return blocks;
}

// ---- Modals ----------------------------------------------------------------

// Detail modal opened by [View] button — shows all scores + status + thread link.
// No action buttons here; those live in the home row and in-channel card.
export function jobDetailModal(job: JobRow): object {
  const blocks: object[] = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `<${job.listing_url}|View full listing>` },
  });

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
    } catch { /* skip */ }
  }

  blocks.push({ type: 'divider' });

  const statusParts = [`*Status:* ${job.status}`];
  if (job.research_level !== 'none') statusParts.push(`*Research:* ${job.research_level}`);
  if (job.research_facets) {
    try {
      const f = JSON.parse(job.research_facets) as { facets?: string[]; extra?: string };
      if (f.facets?.length) statusParts.push(`*Facets:* ${f.facets.join(', ')}`);
      if (f.extra) statusParts.push(`*Extra:* ${f.extra}`);
    } catch { /* skip */ }
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: statusParts.join('  ·  ') } });

  if (job.channel_id && job.root_ts) {
    const tsSafe = job.root_ts.replace('.', '');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<slack://channel?team=T&id=${job.channel_id}&message=${tsSafe}|Open thread in #orchestra>`,
      },
    });
  }

  return {
    type: 'modal',
    callback_id: 'job_detail_modal',
    private_metadata: job.id,
    title: { type: 'plain_text', text: (job.company ?? 'Job Details').slice(0, 24) },
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

export function deepResearchModal(jobId: string, company: string): object {
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

export function refineModal(jobId: string, company: string, role: string): object {
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

// ---- /jobs board (slash command message) -----------------------------------

export function jobsListBlocks(jobs: JobRow[], filter: string): object[] {
  const label = filter && filter !== 'active' ? ` — ${filter}` : '';
  if (!jobs.length) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: `*Pipeline${label}* — no jobs found.` } }];
  }

  const statusEmoji: Record<string, string> = {
    scoring: '⏳', scored: '📋', research_depth_select: '🔎',
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
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} *${job.company ?? 'Unknown'}* — ${job.role ?? 'Role TBD'}${comp}\n${job.status}${model}` },
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
