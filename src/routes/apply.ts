// ---- Apply / edit HTML pages and action handler --------------------------
// Serves the human-facing confirm/edit pages for job applications and
// handles the surface-agnostic /action endpoint the Conductor uses.

import type { Env, ApplyAction } from '../types';
import { HTML_H, JSON_H } from '../types';

// ---- R2 helpers -----------------------------------------------------------

const applyKey = (id: string) => `apply/submissions/${id}.json`;

export async function getSubmission(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const obj = await env.JOB_SOURCE.get(applyKey(id));
  return obj ? obj.json() as Promise<Record<string, unknown>> : null;
}

export async function putSubmission(env: Env, id: string, data: Record<string, unknown>): Promise<void> {
  data.updated_at = new Date().toISOString();
  await env.JOB_SOURCE.put(applyKey(id), JSON.stringify(data, null, 2), { httpMetadata: { contentType: 'application/json' } });
}

// ---- Agent notification ---------------------------------------------------

async function notifyAgent(env: Env, action: ApplyAction, id: string): Promise<void> {
  const mention = env.AGENT_MENTION ? `${env.AGENT_MENTION} ` : '';
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL, text: `${mention}apply-worker | ${action} | ${id}` }),
  });
}

// ---- Action handler (/action + /s/a + /s/e) --------------------------------

export async function handleAction(
  env: Env,
  input: { action: ApplyAction; submissionId: string; token: string; payload?: Record<string, string> },
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const sub = await getSubmission(env, input.submissionId);
  if (!sub) return { ok: false, status: 404, error: 'submission not found' };
  if (!sub.token || sub.token !== input.token) return { ok: false, status: 403, error: 'bad token' };

  if (input.action === 'apply_requested') {
    sub.status = 'submitting';
  } else if (input.action === 'edit_updated' || input.action === 'input_provided') {
    const p = input.payload ?? {};
    sub.fields = ((sub.fields as Array<Record<string, unknown>>) ?? []).map(f =>
      p[f.name as string] !== undefined ? { ...f, value: p[f.name as string], source: 'user' } : f);
    sub.missing = ((sub.missing as string[]) ?? []).filter(n => !(n in p));
    sub.status = input.action === 'edit_updated' ? 'editing' : 'awaiting_input';
  } else {
    return { ok: false, status: 400, error: 'unknown action' };
  }

  await putSubmission(env, input.submissionId, sub);
  await notifyAgent(env, input.action, input.submissionId);
  return { ok: true };
}

// ---- HTML page builders ---------------------------------------------------

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const htmlPage = (title: string, body: string) =>
  `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
  `<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:640px;margin:6vh auto;padding:0 5%;color:#111}` +
  `h1{font-size:1.4rem}label{display:block;font-weight:600;margin:18px 0 6px}` +
  `textarea{width:100%;min-height:64px;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit;box-sizing:border-box}` +
  `button{margin-top:24px;padding:12px 22px;border:0;border-radius:10px;background:#111;color:#fff;font:inherit;cursor:pointer}` +
  `.ok{color:#0a7}.muted{color:#666}</style>${body}`;

const confirmPage = (sub: Record<string, unknown>, token: string) =>
  htmlPage('Submit application',
    `<h1>Submit application to ${esc(sub.company)}?</h1>` +
    `<p class=muted>${esc(sub.role)} &middot; ${esc(sub.ats)}</p>` +
    `<form method=POST><input type=hidden name=token value="${esc(token)}"><button type=submit>Confirm and submit</button></form>`);

const editPage = (sub: Record<string, unknown>, token: string) => {
  const inputs = ((sub.fields as Array<Record<string, unknown>>) ?? [])
    .filter(f => f.class !== 'file')
    .map(f => `<label>${esc(f.label)}${f.required ? ' *' : ''}</label><textarea name="${esc(f.name)}">${esc(f.value)}</textarea>`)
    .join('');
  return htmlPage('Edit application',
    `<h1>Edit application</h1><p class=muted>${esc(sub.company)} &middot; ${esc(sub.role)}</p>` +
    `<form method=POST><input type=hidden name=token value="${esc(token)}">${inputs}<button type=submit>Save changes</button></form>`);
};

// ---- Route handler for GET|POST /s/:kind/:id ----------------------------

export async function handleApplyPage(env: Env, req: Request, rawBody: string, parts: string[]): Promise<Response> {
  const [, kind, id] = parts;
  const url = new URL(req.url);
  const token = url.searchParams.get('t') ?? '';
  const sub = await getSubmission(env, id);
  if (!sub) return new Response(htmlPage('Not found', '<h1>Application not found</h1>'), { status: 404, headers: HTML_H });
  if (sub.token !== token) return new Response(htmlPage('Forbidden', '<h1>Invalid or expired link</h1>'), { status: 403, headers: HTML_H });

  if (req.method === 'GET') {
    return new Response(kind === 'a' ? confirmPage(sub, token) : editPage(sub, token), { headers: HTML_H });
  }

  if (req.method === 'POST') {
    const form = new URLSearchParams(rawBody);
    const ptoken = String(form.get('token') ?? '');
    if (ptoken !== sub.token) return new Response(htmlPage('Forbidden', '<h1>Invalid token</h1>'), { status: 403, headers: HTML_H });
    if (kind === 'a') {
      await handleAction(env, { action: 'apply_requested', submissionId: id, token: ptoken });
      return new Response(htmlPage('Submitting', `<h1 class=ok>Applying now</h1><p>Watch #orchestra for the confirmation.</p>`), { headers: HTML_H });
    }
    const pp: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (k !== 'token') pp[k] = String(v);
    await handleAction(env, { action: 'edit_updated', submissionId: id, token: ptoken, payload: pp });
    return new Response(htmlPage('Saved', `<h1 class=ok>Changes saved</h1><p>The review in #orchestra will refresh.</p>`), { headers: HTML_H });
  }

  return new Response('method not allowed', { status: 405 });
}
