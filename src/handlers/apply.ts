import type { Env, ApplyAction } from '#/types';
import { createResponseInit } from '#/headers';
import { createPage, createConfirmPage, createEditPage } from '#/handlers/html';

const applyKey = (id: string) => `apply/submissions/${id}.json`;

export async function getSubmission(
  env: Env,
  id: string,
): Promise<Record<string, unknown> | null> {
  const obj = await env.RESUMAESTRO_SOURCE.get(applyKey(id));
  return obj ? (obj.json() as Promise<Record<string, unknown>>) : null;
}

export async function putSubmission(
  env: Env,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  data.updated_at = new Date().toISOString();
  await env.RESUMAESTRO_SOURCE.put(applyKey(id), JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function notifyAgent(
  env: Env,
  action: ApplyAction,
  id: string,
): Promise<void> {
  const mention = env.AGENT_MENTION ? `${env.AGENT_MENTION} ` : '';
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: env.SLACK_CHANNEL,
      text: `${mention}apply-worker | ${action} | ${id}`,
    }),
  });
}

export async function handleAction(
  env: Env,
  input: {
    action: ApplyAction;
    submissionId: string;
    token: string;
    body?: string;
  },
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const form = input.body ? new URLSearchParams(input.body) : null;
  const payload: Record<string, string> = {};
  if (form) {
    for (const [key, value] of form.entries()) {
      if (key !== 'token') {
        payload[key] = String(value);
      }
    }
  }
  const submission = await getSubmission(env, input.submissionId);
  if (!submission) {
    return { ok: false, status: 404, error: 'submission not found' };
  }
  if (!submission.token || submission.token !== input.token) {
    return { ok: false, status: 403, error: 'bad token' };
  }

  if (input.action === 'apply_requested') {
    submission.status = 'submitting';
  } else if (
    input.action === 'edit_updated' ||
    input.action === 'input_provided'
  ) {

    submission.fields = (
      (submission.fields as Array<Record<string, unknown>>) ?? []
    ).map((field) => {
      const fieldName = field.name as string;
      return payload[fieldName] !== undefined
        ? { ...field, value: payload[fieldName], source: 'user' }
        : field;
    });
    submission.missing = ((submission.missing as string[]) ?? []).filter(
      (name) => !(name in payload),
    );
    submission.status =
      input.action === 'edit_updated' ? 'editing' : 'awaiting_input';
  } else {
    return { ok: false, status: 400, error: 'unknown action' };
  }

  await putSubmission(env, input.submissionId, submission);
  await notifyAgent(env, input.action, input.submissionId);
  return { ok: true };
}

export async function handleApplyPage(
  env: Env,
  req: Request,
  rawBody: string,
  parts: string[],
): Promise<Response> {
  const action = parts.at(1);
  const id = parts.at(2) ?? '';
  const url = new URL(req.url);
  const token = url.searchParams.get('t') ?? '';
  const submission = await getSubmission(env, id);

  if (!submission) {
    return new Response(
      createPage('Not found', '<h1>Application Not Found</h1>'),
      createResponseInit('html', 404),
    );
  }

  if (submission.token !== token) {
    return new Response(
      createPage('Forbidden', '<h1>Invalid or Expired Link</h1>'),
      createResponseInit('html', 403),
    );
  }

  if (req.method === 'GET') {
    switch (action) {
      case 'a':
        return new Response(
          createConfirmPage(submission, token),
          createResponseInit('html'),
        );
      default:
        return new Response(
          createEditPage(submission, token),
          createResponseInit('html'),
        );
    }
  }

  if (req.method === 'POST') {
    const form = new URLSearchParams(rawBody);
    const postToken = String(form.get('token') ?? '');
    if (postToken !== submission.token) {
      return new Response(
        createPage('Forbidden', '<h1>Invalid token</h1>'),
        createResponseInit('html', 403),
      );
    }
    switch (action) {
      case 'a':
        await handleAction(env, {
          action: 'apply_requested',
          submissionId: id,
          token: postToken,
        });
        return new Response(
          createPage(
            'Submitting',
            `<h1 class=ok>Applying now</h1><p>Watch #orchestra for the confirmation.</p>`,
          ),
          createResponseInit('html'),
        );
      default:
        await handleAction(env, {
          action: 'edit_updated',
          submissionId: id,
          token: postToken,
          body: rawBody,
        });
        return new Response(
          createPage(
            'Saved',
            `<h1 class=ok>Changes saved</h1><p>The review in #orchestra will refresh.</p>`,
          ),
          createResponseInit('html'),
        );
    }
  }

  return new Response('method not allowed', { status: 405 });
}
