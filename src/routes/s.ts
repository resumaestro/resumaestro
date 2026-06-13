// ---- Apply + edit HTML page route (/s/:kind/:id) --------------------------

import type { Env } from '#/types';
import { handleApplyPage } from '#/handlers/apply';

export async function handleSRoute(request: Request, env: Env, _executionContext: ExecutionContext): Promise<Response> {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);

  if (segments.length !== 3) {
    return new Response('not found', { status: 404 });
  }

  const rawBody = await request.text();
  return handleApplyPage(env, request, rawBody, segments);
}
