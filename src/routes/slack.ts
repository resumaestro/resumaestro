// ---- Slack event + interactivity routes (/slack/*) ------------------------

import type { Env } from '#/types';
import { createResponseInit } from '#/headers';
import { verifySlack } from '#/slack';
import { handleSlackEvent } from '#/handlers/events';
import { handleInteractivity } from '#/handlers/interactivity';

export async function handleSlackRoute(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
  const subpath = new URL(request.url).pathname.split('/').filter(Boolean).at(1);
  const rawBody = await request.text();
  if (env.SLACK_SIGNING_SECRET) {
    const valid = await verifySlack(env, rawBody, request);
    if (!valid) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  if (request.method === 'POST' && subpath === 'events') {
    const body = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    if (body.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: body.challenge }), createResponseInit('json'));
    }
    executionContext.waitUntil(handleSlackEvent(env, body));
    return new Response('', { status: 200 });
  }

  if (request.method === 'POST' && subpath === 'interactivity') {
    const form = new URLSearchParams(rawBody);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(form.get('payload') ?? '{}');
    } catch {
      return new Response('Bad payload', { status: 400 });
    }

    // Modal-opening actions must call views.open synchronously (trigger_id expires in 3s)
    const actions = (payload.actions as Array<Record<string, unknown>>) ?? [];
    const action = payload.type === 'block_actions'
      ? (actions.at(0)?.action_id as string)
      : null;
    const SYNC_ACTIONS = new Set([
      'job_research_deep',
      'job_refine',
      'job_view_modal',
      'job_apply',
      'manager_facet_toggle',
    ]);
    const isModalOpen = action !== null && SYNC_ACTIONS.has(action);

    if (isModalOpen) {
      await handleInteractivity(env, payload);
      return new Response('', { status: 200 });
    }
    executionContext.waitUntil(handleInteractivity(env, payload));
    return new Response('', { status: 200 });
  }

  return new Response('not found', { status: 404 });
}
