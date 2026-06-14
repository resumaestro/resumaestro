import type { DividerBlock, InputBlock, Option, SectionBlock } from '@slack/types';
import { createMarkdown, createPlainText, createDivider } from './blocks/primitives';

export function createDeepResearch(jobId: string, company: string, showManagerName?: boolean): object {
  const intro: SectionBlock = createMarkdown(
    `*Research for ${company || 'this company'}*`,
    { withSection: true },
  );

  const divider: DividerBlock = createDivider();

  const quickOption: Option = {
    text: createPlainText('Quick Scan'),
    value: 'quick',
    description: createPlainText('Overview and red flags'),
  };
  const standardOption: Option = {
    text: createPlainText('Standard'),
    value: 'standard',
    description: createPlainText('Company profile, culture, and stack'),
  };
  const deepOption: Option = {
    text: createPlainText('Deep Dive'),
    value: 'deep',
    description: createPlainText('Full intel, exec profiles, and competition'),
  };

  const depthInput: InputBlock = {
    type: 'input',
    block_id: 'research_depth',
    label: createPlainText('How thorough?'),
    element: {
      type: 'radio_buttons',
      action_id: 'depth_input',
      initial_option: standardOption,
      options: [quickOption, standardOption, deepOption],
    },
  };

  const visionOption: Option = {
    text: createPlainText('Vision & Strategy'),
    value: 'vision',
    description: createPlainText('Roadmaps, priorities, trajectory'),
  };
  const fundingOption: Option = {
    text: createPlainText('Funding & Moat'),
    value: 'funding',
    description: createPlainText('Investors, financials, defensibility'),
  };
  const cultureOption: Option = {
    text: createPlainText('Culture & Glassdoor'),
    value: 'culture',
    description: createPlainText('Work-life balance, reviews, WFH policy'),
  };
  const techStackOption: Option = {
    text: createPlainText('Tech Stack'),
    value: 'tech_stack',
    description: createPlainText('Architecture, tools, open source'),
  };
  const redFlagsOption: Option = {
    text: createPlainText('Red Flags'),
    value: 'red_flags',
    description: createPlainText('Lawsuits, layoffs, compliance issues'),
  };
  const managerOption: Option = {
    text: createPlainText('Interviewer / Manager'),
    value: 'manager',
    description: createPlainText('Profile, background, thought leadership'),
  };

  const facetsInput: InputBlock = {
    type: 'input',
    block_id: 'research_facets',
    optional: true,
    label: createPlainText('Additional focus areas (optional)'),
    element: {
      type: 'checkboxes',
      action_id: 'manager_facet_toggle',
      options: [visionOption, fundingOption, cultureOption, techStackOption, redFlagsOption, managerOption],
    },
  };

  const blocks: object[] = [intro, divider, depthInput, facetsInput];

  if (showManagerName === true) {
    const managerNameInput: InputBlock = {
      type: 'input',
      block_id: 'manager_name',
      optional: true,
      label: createPlainText('Interviewer / Manager Name'),
      element: {
        type: 'plain_text_input',
        action_id: 'manager_name_input',
        placeholder: createPlainText('e.g. Jane Doe (Engineering Manager)'),
      },
    };
    blocks.push(managerNameInput);
  }

  const concernInput: InputBlock = {
    type: 'input',
    block_id: 'concern',
    optional: true,
    label: createPlainText('Anything specific?'),
    element: {
      type: 'plain_text_input',
      action_id: 'concern_input',
      placeholder: createPlainText('e.g. recent layoffs, their cloud migration, the new VP of Eng'),
    },
  };

  blocks.push(concernInput);

  return {
    type: 'modal',
    callback_id: 'deep_research_modal',
    private_metadata: JSON.stringify({ jobId, company }),
    title: createPlainText('Research'),
    submit: createPlainText('Run Research'),
    close: createPlainText('Cancel'),
    blocks,
  };
}
