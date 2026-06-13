// ---- Surface-agnostic action endpoint (/action) ---------------------------

import type { Env, ApplyAction } from '#/types';
import { createResponseInit } from '#/headers';
import { verifySlack } from '#/slack';
import { handleAction } from '#/handlers/apply';

export async function handleActionRoute(request: Request, env: Env, _executionContext: ExecutionContext): Promise<Response> {
  const rawBody = await request.text();
  if (env.SLACK_SIGNING_SECRET) {
    const valid = await verifySlack(env, rawBody, request);
    if (!valid) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const body = JSON.parse(rawBody || '{}') as { action: ApplyAction; submissionId: string; token: string; payload?: Record<string, string> };
  const result = await handleAction(env, body);
  return new Response(JSON.stringify(result), createResponseInit('json', result.ok ? 200 : result.status ?? 400));
}
