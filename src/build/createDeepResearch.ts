import type { InputBlock, Option, SectionBlock } from '@slack/types';
import { createMarkdown, createPlainText } from './blocks/primitives';

function createFacetOption(text: string, value: string): Option {
  return {
    text: createPlainText(text),
    value,
  };
}

export function createDeepResearch(jobId: string, company: string): object {
  const facetsInput: InputBlock = {
    type: 'input',
    block_id: 'facets',
    label: createPlainText('Facets'),
    element: {
      type: 'checkboxes',
      action_id: 'facets_input',
      initial_options: [
        createFacetOption('Vision', 'vision'),
        createFacetOption('Funding', 'funding'),
      ],
      options: [
        createFacetOption('Vision', 'vision'),
        createFacetOption('Funding', 'funding'),
        createFacetOption('Moat', 'moat'),
        createFacetOption('Hiring & Leadership Team', 'hiring_leadership'),
        createFacetOption('Culture', 'culture'),
        {
          text: createPlainText('Friction / Red Flags'),
          description: createPlainText('Lawsuits, compliance issues, complaints'),
          value: 'red_flags',
        },
      ],
    },
  };

  const extraInput: InputBlock = {
    type: 'input',
    block_id: 'extra',
    optional: true,
    label: createPlainText('Anything specific to look into?'),
    element: {
      type: 'plain_text_input',
      action_id: 'extra_input',
      placeholder: createPlainText('e.g. recent layoffs, specific product concerns'),
    },
  };

  const intro: SectionBlock = createMarkdown(
    `Select research facets${company ? ` for *${company}*` : ''}:`,
    { withSection: true },
  );

  return {
    type: 'modal',
    callback_id: 'deep_research_modal',
    private_metadata: jobId,
    title: createPlainText('Deep Research'),
    submit: createPlainText('Research'),
    close: createPlainText('Cancel'),
    blocks: [intro, facetsInput, extraInput],
  };
}
