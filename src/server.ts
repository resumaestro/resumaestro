import { handleAdmin } from './routes/admin';

// job-slack — interactivity + data plane for the single Conductor agent.
//
// Routes:
//   POST /admin/*                   bearer-auth: admin control plane (see src/routes/admin.ts)
//   POST /commands/add              slash command: add one or more jobs to the pipeline
//   POST /commands/jobs             slash command: list all pipeline jobs (message)
//   POST /slack/events              Slack event subscriptions (app_home_opened, app_mention)
//   POST /slack/interactivity       all button + modal callbacks (block_actions, view_submission)
//   POST /jobs/:id/result           agent callback: surface_scan / research / tailor / refine done
//   GET|POST /data/*                binding-backed Cloudflare data gateway (R2, Vectorize, AI)
//   POST /action                    surface-agnostic apply/edit core
//   GET|POST /s/a/:id              apply confirm page
//   GET|POST /s/e/:id              edit form page
//   GET /health

import type { Env } from './types';
import { handleData } from './routes/data';
import { handleJobsRoute } from './routes/jobs';
import { handleCommandsRoute } from './routes/commands';
import { handleSlackRoute } from './routes/slack';
import { handleActionRoute } from './routes/action';
import { handleSRoute } from './routes/s';

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    const domain = new URL(request.url).pathname
      .split('/')
      .filter(Boolean)
      .at(0);

    switch (domain) {
      case 'action':
        return handleActionRoute(request, env, executionContext);
      case 'admin':
        return handleAdmin(request, env, executionContext);
      case 'commands':
        return handleCommandsRoute(request, env, executionContext);
      case 'data':
        return handleData(request, env, executionContext);
      case 'health':
        return new Response('ok');
      case 'jobs':
        return handleJobsRoute(request, env, executionContext);
      case 's':
        return handleSRoute(request, env, executionContext);
      case 'slack':
        return handleSlackRoute(request, env, executionContext);
    }

    return new Response('not found', { status: 404 });
  },
};
