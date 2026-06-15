import type { DividerBlock, InputBlock, Option, SectionBlock } from '@slack/types';
import { createMarkdown, createPlainText, createDivider } from './blocks/primitives';

export function createApply(jobId: string, company: string, role: string): object {
  const intro: SectionBlock = createMarkdown(
    `*Apply to ${company}${role ? ` — ${role}` : ''}*`,
    { withSection: true },
  );

  const divider: DividerBlock = createDivider();

  const formalOption: Option = {
    text: createPlainText('Formal'),
    value: 'formal',
    description: createPlainText('Professional and structured'),
  };
  const conversationalOption: Option = {
    text: createPlainText('Conversational'),
    value: 'conversational',
    description: createPlainText('Friendly and approachable'),
  };
  const technicalOption: Option = {
    text: createPlainText('Technical'),
    value: 'technical',
    description: createPlainText('Detail-oriented and precise'),
  };

  const coverToneInput: InputBlock = {
    type: 'input',
    block_id: 'cover_tone',
    label: createPlainText('Cover letter tone'),
    element: {
      type: 'radio_buttons',
      action_id: 'tone_input',
      options: [formalOption, conversationalOption, technicalOption],
    },
  };

  const emphasisInput: InputBlock = {
    type: 'input',
    block_id: 'emphasis',
    optional: true,
    label: createPlainText('Anything to emphasize?'),
    element: {
      type: 'plain_text_input',
      action_id: 'emphasis_input',
      placeholder: createPlainText('e.g. my infrastructure work at Acme, or my open source contributions'),
    },
  };

  return {
    type: 'modal',
    callback_id: 'apply_modal',
    private_metadata: jobId,
    title: createPlainText('Apply'),
    submit: createPlainText('Start Application'),
    close: createPlainText('Cancel'),
    blocks: [intro, divider, coverToneInput, emphasisInput],
  };
}
