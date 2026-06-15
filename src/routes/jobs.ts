// ---- Agent result callback route (/jobs/*) --------------------------------

import type { Env } from '#/types';
import { handleJobResult } from '#/handlers/result';

export async function handleJobsRoute(request: Request, env: Env, _executionContext: ExecutionContext): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const resultMatch = pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (resultMatch && request.method === 'POST') {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    return handleJobResult(env, resultMatch.at(1) as string, body);
  }

  return new Response('not found', { status: 404 });
}
