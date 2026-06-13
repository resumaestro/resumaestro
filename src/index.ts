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

import type { Env, ApplyAction } from './types';
import { JSON_H } from './types';
import { verifySlack } from './slack';
import { handleAddCommand, handleJobsCommand } from './routes/commands';
import { handleSlackEvent } from './routes/events';
import { handleInteractivity } from './routes/interactivity';
import { handleJobResult } from './routes/result';
import { bearerOk, handleData } from './routes/data';
import { handleAction, handleApplyPage } from './routes/apply';

export type { Env };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/health') return new Response('ok');

    // Data gateway — bearer-auth, no Slack sig needed
    if (p === '/data' || p.startsWith('/data/')) return handleData(req, env, url);

    // Admin control plane — bearer-auth, delegates to src/routes/admin.ts
    if (p.startsWith('/admin/')) return handleAdmin(req, env, url);

    // Agent result callback — bearer-auth
    const resultMatch = p.match(/^\/jobs\/([^/]+)\/result$/);
    if (resultMatch && req.method === 'POST') {
      if (!bearerOk(req, env)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_H });
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      return handleJobResult(env, resultMatch[1], body);
    }

    // ---- All Slack routes: verify signature first ----
    const rawBody = await req.text();
    if (env.SLACK_SIGNING_SECRET) {
      const valid = await verifySlack(env, rawBody, req);
      if (!valid) return new Response('Forbidden', { status: 403 });
    }

    // Slack event subscriptions (app_home_opened, app_mention)
    if (req.method === 'POST' && p === '/slack/events') {
      const body = JSON.parse(rawBody || '{}') as Record<string, unknown>;
      if (body.type === 'url_verification') {
        return new Response(JSON.stringify({ challenge: body.challenge }), { headers: JSON_H });
      }
      ctx.waitUntil(handleSlackEvent(env, body));
      return new Response('', { status: 200 });
    }

    // Slash commands
    if (req.method === 'POST' && p.startsWith('/commands/')) {
      const payload = Object.fromEntries(new URLSearchParams(rawBody));
      const cmd = p.slice('/commands/'.length);
      if (cmd === 'add') { ctx.waitUntil(handleAddCommand(env, payload)); return new Response('', { status: 200 }); }
      if (cmd === 'jobs') { ctx.waitUntil(handleJobsCommand(env, payload)); return new Response('', { status: 200 }); }
      return new Response('Unknown command', { status: 404 });
    }

    // Interactivity (buttons + modals)
    if (req.method === 'POST' && p === '/slack/interactivity') {
      const form = new URLSearchParams(rawBody);
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(form.get('payload') ?? '{}'); } catch { return new Response('Bad payload', { status: 400 }); }

      // Modal-opening actions must call views.open synchronously (trigger_id expires in 3s)
      const action = (payload.type === 'block_actions')
        ? ((payload.actions as Array<Record<string, unknown>>)?.[0]?.action_id as string)
        : null;
      const isModalOpen = action === 'job_research_deep' || action === 'job_refine' || action === 'job_view_modal';

      if (isModalOpen) {
        await handleInteractivity(env, payload);
        return new Response('', { status: 200 });
      }
      ctx.waitUntil(handleInteractivity(env, payload));
      return new Response('', { status: 200 });
    }

    // Surface-agnostic action endpoint (Conductor apply flow)
    if (req.method === 'POST' && p === '/action') {
      const body = JSON.parse(rawBody || '{}') as { action: ApplyAction; submissionId: string; token: string; payload?: Record<string, string> };
      const r = await handleAction(env, body);
      return new Response(JSON.stringify(r), { status: r.ok ? 200 : r.status ?? 400, headers: JSON_H });
    }

    // Apply + edit HTML pages
    const parts = p.split('/').filter(Boolean);
    if (parts[0] === 's' && parts.length === 3) {
      return handleApplyPage(env, req, rawBody, parts);
    }

    return new Response('not found', { status: 404 });
  },
};
