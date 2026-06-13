import type {
  ActionsBlock,
  Button,
  KnownBlock,
  MrkdwnElement,
  SectionBlock,
} from '@slack/types';
import type { JobRow } from '#/types';
import { createButton, createDivider, createMarkdown, createQuoteBlock } from './primitives';

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

  switch (job.status) {
    case 'scoring':
      return [createMarkdown('_Scanning listing…_', { withSection: true })];

    case 'research_depth_select':
      return [
        {
          type: 'actions',
          elements: [
            createButton('Deep', 'job_research_deep', id),
            createButton('Surface', 'job_research_surface', id),
          ],
        } satisfies ActionsBlock,
      ];

    case 'researching': {
      const queuedTailor = job.queued_next === 'tailor_after_research';
      return [
        {
          type: 'section',
          text: createMarkdown('Researching…'),
          accessory: createButton(
            queuedTailor ? 'Stage when complete' : 'Tailor when complete',
            queuedTailor ? 'job_queue_stage' : 'job_queue_tailor',
            id,
          ),
        } satisfies SectionBlock,
      ];
    }

    case 'tailoring': {
      const queuedStage = job.queued_next === 'stage_after_tailor';
      return [
        {
          type: 'section',
          text: createMarkdown('Tailoring…'),
          accessory: createButton(
            queuedStage ? 'Undo Stage' : 'Stage when complete',
            queuedStage ? 'job_unqueue_stage' : 'job_queue_stage',
            id,
          ),
        } satisfies SectionBlock,
      ];
    }

    case 'parking':
      return [
        createQuoteBlock(
          'Moving thread to #orchestra-parking-lot. This message and thread will soon be deleted.',
        ),
      ];

    case 'staging':
      return [
        createQuoteBlock(
          'Moving thread to #orchestra-stage. This message and thread will soon be deleted.',
        ),
      ];

    default: {
      // scored, researched, tailored — the normal action bar
      const elements: Button[] = [];

      if (job.research_level === 'none') {
        elements.push(createButton('Research', 'job_research', id));
      } else if (job.research_level === 'surface') {
        elements.push(createButton('Deep Research', 'job_research_deep', id));
      }
      // research_level === 'deep': already at max depth, no research button

      const tailorButton =
        job.tailor_state === 'done'
          ? createButton('Refine', 'job_refine', id, { style: 'primary' })
          : createButton('Tailor', 'job_tailor', id, { style: 'primary' });

      elements.push(tailorButton);
      elements.push(createButton('Park', 'job_park', id));
      elements.push(createButton('Stage', 'job_stage', id));

      return [{ type: 'actions', elements } satisfies ActionsBlock];
    }
  }
}
