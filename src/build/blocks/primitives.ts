import type {
  Button,
  DividerBlock,
  MrkdwnElement,
  PlainTextElement,
  RichTextBlock,
  SectionBlock,
} from '@slack/types';

type CreateButtonOptions = {
  style?: 'primary' | 'danger';
  withEmoji?: boolean;
};

export function createButton(
  text: string,
  actionId: string,
  value: string,
  options?: CreateButtonOptions,
): Button {
  const { style, withEmoji } = options ?? {};
  const button: Button = {
    type: 'button',
    text: {
      type: 'plain_text',
      text,
      emoji: withEmoji ?? false,
    },
    action_id: actionId,
    value,
  };
  if (style) {
    button.style = style;
  }
  return button;
}

export function createPlainText(text: string): PlainTextElement {
  return {
    type: 'plain_text',
    text,
  };
}

export function createMarkdown(text: string, options: { withSection: true }): SectionBlock;
export function createMarkdown(text: string, options?: { withSection?: false }): MrkdwnElement;
export function createMarkdown(text: string, options?: { withSection?: boolean }): MrkdwnElement | SectionBlock {
  const markdown: MrkdwnElement = {
    type: 'mrkdwn',
    text,
  };

  if (options?.withSection) {
    return {
      type: 'section',
      text: markdown,
    };
  }

  return markdown;
}

export function createDivider(): DividerBlock {
  return {
    type: 'divider',
  };
}

export function createQuoteBlock(text: string): RichTextBlock {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_quote',
        elements: [
          {
            type: 'text',
            text,
          },
        ],
      },
    ],
  };
}
