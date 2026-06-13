// job-slack — /admin/* control plane.
//
// Same bearer as the /data gateway (AGENT_API_TOKEN). Today it exposes one action,
// /admin/update-manifest, which a GitHub Action calls whenever slack-app/manifest.yml
// changes: the action converts the YAML manifest to JSON and POSTs it here. This
// worker holds the Slack *config* tokens (in Secrets Store) and never returns them.
//
// Slack config tokens (xoxe-xoxp-...) expire ~12h and ship with a refresh token
// (xoxe-1-...). Rotating via tooling.tokens.rotate returns a NEW pair and invalidates
// the old refresh token, so updateManifest writes the new pair back to the store.
// The Secrets Store binding is read-only at runtime, so write-back goes through the
// Secrets Store REST API (needs CF_API_TOKEN). If write-back is not configured, the
// new tokens are returned in the response for the caller to persist instead.

import type { Env } from "../index";

const SLACK_API = "https://slack.com/api";
const CF_API = "https://api.cloudflare.com/client/v4";
const JSON_H = { "Content-Type": "application/json" };
const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_H });

// Store secret names — MUST match the `secret_name` values in wrangler.toml.
const SECRET_ACCESS = "SLACK_CONFIG_TOKEN";
const SECRET_REFRESH = "SLACK_CONFIG_REFRESH_TOKEN";
const EXPIRED = new Set(["token_expired", "not_authed", "invalid_auth"]);

function bearerOk(req: Request, env: Env): boolean {
  const h = req.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return Boolean(env.AGENT_API_TOKEN) && tok === env.AGENT_API_TOKEN;
}

// ---- Slack Web API (config-token tooling) ----
async function slackForm(method: string, params: Record<string, string>, bearer?: string): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${SLACK_API}/${method}`, { method: "POST", headers, body: new URLSearchParams(params) });
  return res.json();
}

async function rotateConfigToken(refreshToken: string): Promise<{ token: string; refresh_token: string; exp?: number }> {
  const data = await slackForm("tooling.tokens.rotate", { refresh_token: refreshToken });
  if (!data.ok) throw new Error(`tooling.tokens.rotate failed: ${data.error}`);
  return data;
}

// ---- Secrets Store write-back (binding is read-only at runtime → REST API) ----
async function patchStoreSecret(env: Env, name: string, value: string): Promise<void> {
  const base = `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores/${env.SECRETS_STORE_ID}/secrets`;
  const headers = { Authorization: `Bearer ${env.CF_API_TOKEN}`, ...JSON_H };
  // PATCH is keyed by secret id, so resolve name → id first.
  const listed: any = await (await fetch(`${base}?per_page=100`, { headers })).json();
  if (!listed.success) throw new Error(`list secrets failed: ${JSON.stringify(listed.errors)}`);
  const match = (listed.result || []).find((s: any) => s.name === name);
  if (!match) throw new Error(`secret not found in store: ${name}`);
  const patched: any = await (
    await fetch(`${base}/${match.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ value, comment: `rotated ${new Date().toISOString()}` }),
    })
  ).json();
  if (!patched.success) throw new Error(`patch ${name} failed: ${JSON.stringify(patched.errors)}`);
}

async function writeBackTokens(
  env: Env,
  pair: { token: string; refresh_token: string }
): Promise<{ persisted: boolean; detail?: string }> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.SECRETS_STORE_ID) {
    return { persisted: false, detail: "write-back not configured (need CF_API_TOKEN, CF_ACCOUNT_ID, SECRETS_STORE_ID)" };
  }
  try {
    await patchStoreSecret(env, SECRET_ACCESS, pair.token);
    await patchStoreSecret(env, SECRET_REFRESH, pair.refresh_token);
    return { persisted: true };
  } catch (e: any) {
    return { persisted: false, detail: String(e?.message || e) };
  }
}

// ---- action: POST /admin/update-manifest ----
// body: { manifest: object | string (required), app_id?: string }
async function updateManifest(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return j({ error: "method not allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return j({ error: "body must be JSON" }, 400);
  }

  const rawManifest = body?.manifest ?? body; // accept { manifest: ... } or a bare manifest object
  if (!rawManifest || (typeof rawManifest === "object" && Object.keys(rawManifest).length === 0)) {
    return j({ error: "missing manifest in request body" }, 400);
  }
  const manifest = typeof rawManifest === "string" ? rawManifest : JSON.stringify(rawManifest);
  const appId = body?.app_id || env.SLACK_APP_ID;
  if (!appId) return j({ error: "missing app_id (body.app_id or SLACK_APP_ID var)" }, 400);

  try {
    // Tokens live in Secrets Store (read-only binding).
    const accessToken = await env.SLACK_CONFIG_TOKEN.get();
    const refreshToken = await env.SLACK_CONFIG_REFRESH_TOKEN.get();

    let result = await slackForm("apps.manifest.update", { app_id: appId, manifest }, accessToken);
    let rotated: { token: string; refresh_token: string; exp?: number } | null = null;

    // Config token expired → rotate with the refresh token, then retry once.
    if (!result.ok && EXPIRED.has(result.error)) {
      rotated = await rotateConfigToken(refreshToken);
      result = await slackForm("apps.manifest.update", { app_id: appId, manifest }, rotated.token);
    }

    const writeBack = rotated ? await writeBackTokens(env, rotated) : null;
    const ok = Boolean(result.ok);

    const out: any = {
      ok,
      app_id: appId,
      slack: ok ? { permissions_updated: result.permissions_updated ?? false } : result,
      rotated: rotated ? { write_back: writeBack } : null,
    };
    // If we rotated but couldn't persist, return the new pair so the caller can store it.
    if (rotated && writeBack && !writeBack.persisted) {
      out.rotated.new_tokens = { token: rotated.token, refresh_token: rotated.refresh_token, exp: rotated.exp };
    }
    return j(out, ok ? 200 : 502);
  } catch (e: any) {
    return j({ error: "update-manifest failed", detail: String(e?.message || e) }, 500);
  }
}

// ---- router: everything under /admin/* lands here ----
export async function handleAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!bearerOk(req, env)) return j({ error: "unauthorized" }, 401);
  const path = url.pathname.replace(/^\/+/, ""); // e.g. "admin/update-manifest"
  switch (path) {
    case "admin/update-manifest":
      return updateManifest(req, env);
    default:
      return j({ error: "not found", path }, 404);
  }
}
