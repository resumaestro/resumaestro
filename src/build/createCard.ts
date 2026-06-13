import type { KnownBlock, SectionBlock } from '@slack/types';
import type { JobRow } from '#/types';
import { createScoreFields, createFooterBlocks } from './blocks/components';
import { createDivider, createMarkdown } from './blocks/primitives';

export function createCard(job: JobRow): KnownBlock[] {
  const title =
    job.company && job.role
      ? `*${job.company}* — ${job.role}`
      : '_Scanning listing…_';

  const header: SectionBlock = {
    type: 'section',
    text: createMarkdown(`${title}\n<${job.listing_url}|View listing>`),
  };

  const blocks: KnownBlock[] = [header];

  if (job.scores_json) {
    try {
      const fields = createScoreFields(job.scores_json);
      if (fields.length) {
        blocks.push({ type: 'section', fields } satisfies SectionBlock);
      }
    } catch {
      /* skip */
    }
  }

  blocks.push(createDivider());
  blocks.push(...createFooterBlocks(job));
  return blocks;
}
