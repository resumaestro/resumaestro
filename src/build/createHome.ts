import type { KnownBlock, SectionBlock } from '@slack/types';
import type { JobRow } from '#/types';
import { createFooterBlocks } from './blocks/components';
import {
  createButton,
  createDivider,
  createMarkdown,
} from './blocks/primitives';

function createJobHint(scoresJson: string): string {
  const scores = JSON.parse(scoresJson) as Record<string, string>;
  const parts: string[] = [];

  if (scores.comp) {
    parts.push(scores.comp);
  }
  if (scores.stack) {
    parts.push(scores.stack);
  }

  if (parts.length === 0) {
    return '';
  }

  return `\n${parts.join('  ·  ')}`;
}

const addJob = (job: JobRow): KnownBlock[] => {
  let hint = '';
  if (job.scores_json) {
    try {
      hint = createJobHint(job.scores_json);
    } catch {
      /* skip */
    }
  }

  const jobRow: SectionBlock = createMarkdown(
    `*${job.company ?? 'Unknown Company'}*\n<${job.listing_url}|${job.role ?? 'View listing'}>${hint}`,
    {
      withSection: true,
      accessory: createButton('View', 'job_view_modal', job.id),
    },
  );
  const footerBlocks = createFooterBlocks(job);

  return [jobRow, ...footerBlocks];
};

export function createHome(jobs: JobRow[]): KnownBlock[] {
  if (!jobs.length) {
    return [
      createMarkdown(
        '*Pipeline*\n_No jobs yet. Use `/add-job {url}` in #orchestra to get started._',
        { withSection: true },
      ),
    ];
  }

  const blocks: KnownBlock[] = [
    createMarkdown(`*Jobs*`, {
      withSection: true,
    }),
  ];

  for (const job of jobs) {
    blocks.push(createDivider());
    const row = addJob(job);
    blocks.push(...row);
  }

  blocks.push(createDivider());
  return blocks;
}
