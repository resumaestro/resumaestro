// job-slack — interactivity + input plane for the "Job Application Apply" agent.
//
// Expandable by design: Slack is the FIRST adapter, not the only one. New surfaces
// (email links, a web dashboard, Telegram) just translate their request into the
// surface-agnostic core action handler (handleAction). Re-triggering the agent is
// isolated to notifyAgent(); swap it for a dedicated agent webhook later without
// touching anything else.

export interface Env {
  JOB_SOURCE: R2Bucket;          // R2 binding (bucket: job-source)
  SLACK_BOT_TOKEN: string;       // secret: wrangler secret put SLACK_BOT_TOKEN
  SLACK_CHANNEL: string;         // #orchestra channel id (C0BA8G3UFNJ)
  AGENT_MENTION?: string;        // optional "<@U...>" to force the agent's mention trigger
}

type Action = "apply_requested" | "edit_updated" | "input_provided";

const HTML = { "Content-Type": "text/html; charset=utf-8" };
const keyFor = (id: string) => `apply/submissions/${id}.json`;

async function getSubmission(env: Env, id: string): Promise<any | null> {
  const obj = await env.JOB_SOURCE.get(keyFor(id));
  return obj ? await obj.json() : null;
}

async function putSubmission(env: Env, id: string, data: any): Promise<void> {
  data.updated_at = new Date().toISOString();
  await env.JOB_SOURCE.put(keyFor(id), JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

// Wake the agent. Today: post a control line into #orchestra so the inbound Slack
// trigger re-invokes the agent, which then resumes from the R2 record. <-- seam
async function notifyAgent(env: Env, action: Action, id: string): Promise<void> {
  const mention = env.AGENT_MENTION ? `${env.AGENT_MENTION} ` : "";
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: env.SLACK_CHANNEL,
      text: `${mention}apply-worker | ${action} | ${id}`,
    }),
  });
}

// Surface-agnostic core. Every adapter (Slack now, others later) funnels here. <-- seam
async function handleAction(
  env: Env,
  input: { action: Action; submissionId: string; token: string; payload?: Record<string, string> }
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const sub = await getSubmission(env, input.submissionId);
  if (!sub) return { ok: false, status: 404, error: "submission not found" };
  if (!sub.token || sub.token !== input.token) return { ok: false, status: 403, error: "bad token" };

  if (input.action === "apply_requested") {
    sub.status = "submitting";
  } else if (input.action === "edit_updated" || input.action === "input_provided") {
    const payload = input.payload || {};
    sub.fields = (sub.fields || []).map((f: any) =>
      payload[f.name] !== undefined ? { ...f, value: payload[f.name], source: "user" } : f
    );
    sub.missing = (sub.missing || []).filter((n: string) => !(n in payload));
    sub.status = input.action === "edit_updated" ? "editing" : "awaiting_input";
  } else {
    return { ok: false, status: 400, error: "unknown action" };
  }

  await putSubmission(env, input.submissionId, sub);
  await notifyAgent(env, input.action, input.submissionId);
  return { ok: true };
}

// ---- minimal, dependency-free HTML ----
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const page = (title: string, body: string) =>
  `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
  `<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:640px;margin:6vh auto;padding:0 5%;color:#111}` +
  `h1{font-size:1.4rem}label{display:block;font-weight:600;margin:18px 0 6px}` +
  `textarea{width:100%;min-height:64px;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit;box-sizing:border-box}` +
  `button{margin-top:24px;padding:12px 22px;border:0;border-radius:10px;background:#111;color:#fff;font:inherit;cursor:pointer}` +
  `.ok{color:#0a7}.muted{color:#666}</style>${body}`;

const confirmPage = (sub: any, token: string) =>
  page("Submit application",
    `<h1>Submit application to ${esc(sub.company)}?</h1>` +
    `<p class=muted>${esc(sub.role)} &middot; ${esc(sub.ats)}</p>` +
    `<form method=POST><input type=hidden name=token value="${esc(token)}">` +
    `<button type=submit>Confirm and submit</button></form>`);

const editPage = (sub: any, token: string) => {
  const inputs = (sub.fields || [])
    .filter((f: any) => f.class !== "file")
    .map((f: any) =>
      `<label>${esc(f.label)}${f.required ? " *" : ""}</label>` +
      `<textarea name="${esc(f.name)}">${esc(f.value)}</textarea>`)
    .join("");
  return page("Edit application",
    `<h1>Edit application</h1>` +
    `<p class=muted>${esc(sub.company)} &middot; ${esc(sub.role)}</p>` +
    `<form method=POST><input type=hidden name=token value="${esc(token)}">${inputs}` +
    `<button type=submit>Save changes</button></form>`);
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");

    // ---- surface-agnostic JSON endpoint (reused by every future surface) ----
    if (req.method === "POST" && url.pathname === "/action") {
      const body = await req.json().catch(() => ({}));
      const r = await handleAction(env, body as any);
      return new Response(JSON.stringify(r), {
        status: r.ok ? 200 : r.status || 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ---- Slack adapter: /s/a/<id> (apply) and /s/e/<id> (edit) ----
    const parts = url.pathname.split("/").filter(Boolean); // ["s","a","<id>"]
    if (parts[0] === "s" && parts.length === 3) {
      const [, kind, id] = parts;
      const token = url.searchParams.get("t") || "";
      const sub = await getSubmission(env, id);
      if (!sub) return new Response(page("Not found", "<h1>Application not found</h1>"), { status: 404, headers: HTML });
      if (sub.token !== token) return new Response(page("Forbidden", "<h1>Invalid or expired link</h1>"), { status: 403, headers: HTML });

      // GET renders the page (link-buttons are GETs; a confirm click POSTs).
      if (req.method === "GET") {
        return new Response(kind === "a" ? confirmPage(sub, token) : editPage(sub, token), { headers: HTML });
      }
      if (req.method === "POST") {
        const form = await req.formData();
        const ptoken = String(form.get("token") || "");
        if (ptoken !== sub.token) return new Response(page("Forbidden", "<h1>Invalid token</h1>"), { status: 403, headers: HTML });

        if (kind === "a") {
          await handleAction(env, { action: "apply_requested", submissionId: id, token: ptoken });
          return new Response(page("Submitting", `<h1 class=ok>Applying now</h1><p>Watch #orchestra for the confirmation.</p>`), { headers: HTML });
        }
        const payload: Record<string, string> = {};
        for (const [k, v] of form.entries()) if (k !== "token") payload[k] = String(v);
        await handleAction(env, { action: "edit_updated", submissionId: id, token: ptoken, payload });
        return new Response(page("Saved", `<h1 class=ok>Changes saved</h1><p>The review in #orchestra will refresh.</p>`), { headers: HTML });
      }
    }

    return new Response("not found", { status: 404 });
  },
};
