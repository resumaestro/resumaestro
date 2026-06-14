import type {
  ActionsBlock,
  Button,
  KnownBlock,
  MrkdwnElement,
} from '@slack/types';
import type { JobRow } from '#/types';
import { createButton, createMarkdown } from './primitives';

export function createField(label: string, value: string | undefined): MrkdwnElement | null {
  if (!value) {
    return null;
  }
  return createMarkdown(`*${label}*\n${value}`);
}

type CreateScoreFieldsOptions = {
  withNotes?: boolean;
};

export function createScoreFields(
  scoresJson: string,
  options?: CreateScoreFieldsOptions,
): MrkdwnElement[] {
  const { withNotes = true } = options ?? {};
  const scores = JSON.parse(scoresJson) as Record<string, string>;
  const fields: MrkdwnElement[] = [];

  type ScoreCandidate = [string, string | undefined];

  const candidates: ScoreCandidate[] = [
    ['Comp', scores.comp],
    ['Work Model', scores.work_model],
    ['Commute', scores.commute],
    ['Stack', scores.stack],
  ];

  if (withNotes) {
    candidates.push(['Notes', scores.notes]);
  }

  for (const [label, value] of candidates) {
    const field = createField(label, value);
    if (field) {
      fields.push(field);
    }
  }

  return fields;
}

export function createFooterBlocks(job: JobRow): KnownBlock[] {
  const { id } = job;

  switch (job.in_flight) {
    case 'SCORING':
      return [createMarkdown('_Scanning listing…_', { withSection: true })];
    case 'RESEARCHING':
      return [createMarkdown('_Researching…_', { withSection: true })];
    case 'TAILORING':
      return [createMarkdown('_Tailoring…_', { withSection: true })];
    case 'APPLYING':
      return [createMarkdown('_Applying…_', { withSection: true })];
    default: {
      const elements: Button[] = [];

      if (job.research_level === 'none') {
        elements.push(createButton('Research', 'job_research_deep', id));
      } else if (job.research_level === 'surface') {
        elements.push(createButton('Research', 'job_research_deep', id));
      }

      const tailorButton =
        job.tailor_state === 'done'
          ? createButton('Refine', 'job_refine', id, { style: 'primary' })
          : createButton('Tailor', 'job_tailor', id, { style: 'primary' });

      elements.push(tailorButton);

      return [{ type: 'actions', elements } satisfies ActionsBlock];
    }
  }
}
