import type { KnownBlock, SectionBlock } from '@slack/types';
import type { JobRow, ResearchFacets } from '#/types';
import { createScoreFields } from './blocks/components';
import { createDivider, createMarkdown, createPlainText } from './blocks/primitives';

function createStatusLine(job: JobRow): string {
  const parts = [`*Status:* ${job.status}`];

  if (job.research_level !== 'none') {
    parts.push(`*Research:* ${job.research_level}`);
  }

  if (job.research_facets) {
    try {
      const researchFacets = JSON.parse(job.research_facets) as ResearchFacets;
      if (researchFacets.facets?.length) {
        parts.push(`*Facets:* ${researchFacets.facets.join(', ')}`);
      }
      if (researchFacets.extra) {
        parts.push(`*Extra:* ${researchFacets.extra}`);
      }
    } catch {
      /* skip */
    }
  }

  return parts.join('  ·  ');
}

export function createJobDetail(job: JobRow): object {
  const blocks: KnownBlock[] = [];

  blocks.push(createMarkdown(`<${job.listing_url}|View full listing>`, { withSection: true }));

  if (job.scores_json) {
    try {
      const fields = createScoreFields(job.scores_json);
      if (fields.length) {
        blocks.push({ type: 'section', fields } satisfies SectionBlock);
        blocks.push(createDivider());
      }
    } catch {
      /* skip */
    }
  }

  blocks.push(createMarkdown(createStatusLine(job), { withSection: true }));

  if (job.channel_id && job.root_ts) {
    const tsSafe = job.root_ts.replace('.', '');
    blocks.push(
      createMarkdown(
        `<slack://channel?team=T&id=${job.channel_id}&message=${tsSafe}|Open thread in #orchestra>`,
        { withSection: true },
      ),
    );
  }

  return {
    type: 'modal',
    callback_id: 'job_detail_modal',
    private_metadata: job.id,
    title: createPlainText((job.company ?? 'Job Details').slice(0, 24)),
    close: createPlainText('Close'),
    blocks,
  };
}
