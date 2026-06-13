import type { InputBlock, SectionBlock } from '@slack/types';
import { createMarkdown, createPlainText } from './blocks/primitives';

export function createRefine(jobId: string, company: string, role: string): object {
  const intro: SectionBlock = createMarkdown(
    `What should change${company ? ` for *${company}${role ? ` — ${role}` : ''}*` : ''}?`,
    { withSection: true },
  );

  const feedbackInput: InputBlock = {
    type: 'input',
    block_id: 'feedback',
    label: createPlainText('Changes'),
    element: {
      type: 'plain_text_input',
      action_id: 'feedback_input',
      multiline: true,
      placeholder: createPlainText(
        'e.g. Lead with the design system work, drop the Kubernetes bullet, tighten the summary…',
      ),
    },
  };

  return {
    type: 'modal',
    callback_id: 'refine_modal',
    private_metadata: jobId,
    title: createPlainText('Refine Resume'),
    submit: createPlainText('Refine'),
    close: createPlainText('Cancel'),
    blocks: [intro, feedbackInput],
  };
}
