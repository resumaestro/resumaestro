// ---- Agent result callback route (/jobs/*) --------------------------------

import type { Env } from '#/types';
import { createResponseInit } from '#/headers';
import { bearerOk } from './data';
import { handleJobResult } from '#/handlers/result';

export async function handleJobsRoute(request: Request, env: Env, _executionContext: ExecutionContext): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const resultMatch = pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (resultMatch && request.method === 'POST') {
    if (!bearerOk(request, env)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), createResponseInit('json', 401));
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    return handleJobResult(env, resultMatch.at(1) as string, body);
  }

  return new Response('not found', { status: 404 });
}
