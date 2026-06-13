import type { KnownBlock, Option, SectionBlock } from '@slack/types';
import type { JobRow } from '#/types';
import { createDivider, createMarkdown, createPlainText } from './blocks/primitives';

const STATUS_EMOJI: Record<string, string> = {
  scoring: '⏳',
  scored: '📋',
  research_depth_select: '🔎',
  researching: '🔬',
  researched: '📊',
  tailoring: '✏️',
  tailored: '📄',
  staging: '🚀',
  staged: '✅',
  parking: '🅿️',
  parked: '🗄️',
};

function createOverflowOption(text: string, action: string, jobId: string): Option {
  return {
    text: createPlainText(text),
    value: `${action}:${jobId}`,
  };
}

export function createJobsList(jobs: JobRow[], filter: string): KnownBlock[] {
  const label = filter && filter !== 'active' ? ` — ${filter}` : '';

  if (!jobs.length) {
    return [createMarkdown(`*Pipeline${label}* — no jobs found.`, { withSection: true })];
  }

  const blocks: KnownBlock[] = [
    createMarkdown(
      `*Pipeline${label}* — ${jobs.length} job${jobs.length !== 1 ? 's' : ''}`,
      { withSection: true },
    ),
    createDivider(),
  ];

  for (const job of jobs) {
    const emoji = STATUS_EMOJI[job.status] ?? '•';
    const comp = job.comp_text ? ` · ${job.comp_text}` : '';
    const model = job.work_model ? ` · ${job.work_model}` : '';

    const jobRow: SectionBlock = {
      type: 'section',
      text: createMarkdown(
        `${emoji} *${job.company ?? 'Unknown'}* — ${job.role ?? 'Role TBD'}${comp}\n${job.status}${model}`,
      ),
      accessory: {
        type: 'overflow',
        action_id: 'jobs_overflow',
        options: [
          createOverflowOption('→ Open thread', 'open', job.id),
          createOverflowOption('🚀 Stage', 'stage', job.id),
          createOverflowOption('🅿️ Park', 'park', job.id),
          createOverflowOption('🗑 Delete', 'delete', job.id),
        ],
      },
    };

    blocks.push(jobRow);
  }

  return blocks;
}
