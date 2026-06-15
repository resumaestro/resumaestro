import type { ContextBlock, KnownBlock, MrkdwnElement, SectionBlock } from '@slack/types';
import type { JobRow, ResearchFacets, ResearchSignal, ApplyQuestion } from '#/types';
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

  const links: string[] = [];
  if (job.company_url) {
    links.push(`<${job.company_url}|Company Website>`);
  }
  if (job.job_url) {
    links.push(`<${job.job_url}|Job Posting>`);
  }
  if (links.length > 0) {
    blocks.push(createMarkdown(links.join('  ·  '), { withSection: true }));
  }

  if (job.research_summary) {
    blocks.push(createMarkdown(job.research_summary, { withSection: true }));
  }

  if (job.research_signals_json) {
    try {
      const signals = JSON.parse(job.research_signals_json) as ResearchSignal[];
      const signalElements: MrkdwnElement[] = signals
        .slice(0, 5)
        .map(signal => createMarkdown(`<${signal.url}|${signal.title}>  ${signal.snippet}`));
      if (signalElements.length > 0) {
        const signalsBlock: ContextBlock = { type: 'context', elements: signalElements };
        blocks.push(signalsBlock);
      }
    } catch {
      /* skip */
    }
  }

  if (job.research_sources_json) {
    try {
      const sources = JSON.parse(job.research_sources_json) as Array<{ url: string; title: string }>;
      const sourceLines = sources.map(source => `• <${source.url}|${source.title}>`);
      if (sourceLines.length > 0) {
        blocks.push(createMarkdown(sourceLines.join('\n'), { withSection: true }));
      }
    } catch {
      /* skip */
    }
  }

  if (job.apply_pending_json) {
    try {
      const questions = JSON.parse(job.apply_pending_json) as ApplyQuestion[];
      const questionLines = questions.map(question => `• *${question.field}*: ${question.question}`);
      if (questionLines.length > 0) {
        blocks.push(createMarkdown(`_Outstanding questions:_\n${questionLines.join('\n')}`, { withSection: true }));
      }
    } catch {
      /* skip */
    }
  }

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
