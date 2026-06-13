// ---- Cloudflare data gateway (GET|POST /data/*) ---------------------------
// Bearer-authenticated. Exposes R2, Vectorize, and Workers AI embeddings to
// the agent and other internal callers without exposing raw CF credentials.

import type { Env } from '../types';
import { JSON_H } from '../types';

export const EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';

const dj = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_H });

export function bearerOk(req: Request, env: Env): boolean {
  const h = req.headers.get('Authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return Boolean(env.AGENT_API_TOKEN) && tok === env.AGENT_API_TOKEN;
}

function vecIndex(env: Env, name: string): VectorizeIndex | null {
  switch (String(name ?? '').toLowerCase()) {
    case 'company': case 'job-company': return env.VEC_COMPANY;
    case 'people': case 'person': case 'job-people': return env.VEC_PEOPLE;
    case 'role': case 'job-role': return env.VEC_ROLE;
    case 'code': case 'rag': case 'source-code-rag': return env.VEC_CODE;
    default: return null;
  }
}

async function embedText(env: Env, text: string | string[]): Promise<number[][]> {
  const input = Array.isArray(text) ? text : [text];
  const res = await env.AI.run(EMBED_MODEL, { text: input }) as { data?: number[][] } | number[][];
  return (Array.isArray(res) ? res : ((res as { data?: number[][] }).data ?? [])) as number[][];
}

export async function handleData(req: Request, env: Env, url: URL): Promise<Response> {
  if (!bearerOk(req, env)) return dj({ error: 'unauthorized' }, 401);
  const p = url.pathname;

  if (req.method === 'POST' && p === '/data/embed') {
    const b = await req.json().catch(() => ({})) as { text?: string | string[] };
    if (b.text === undefined) return dj({ error: 'missing text' }, 400);
    const vectors = await embedText(env, b.text);
    return dj({ dim: vectors[0]?.length ?? 0, vectors, vector: vectors[0] });
  }

  if (req.method === 'POST' && p === '/data/vector/query') {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const idx = vecIndex(env, b.index as string);
    if (!idx) return dj({ error: `unknown index: ${b.index}` }, 400);
    let vector = b.vector as number[] | undefined;
    if (!vector && b.text !== undefined) vector = (await embedText(env, b.text as string))[0];
    if (!vector) return dj({ error: 'provide text or vector' }, 400);
    const opts: Record<string, unknown> = { topK: b.topK ?? 5, returnMetadata: b.returnMetadata ?? 'all', returnValues: b.returnValues ?? false };
    if (b.filter) opts.filter = b.filter;
    const r = await idx.query(vector, opts) as { count: number; matches: unknown[] };
    return dj({ count: r.count, matches: r.matches ?? [] });
  }

  if (req.method === 'POST' && p === '/data/vector/upsert') {
    const b = await req.json().catch(() => ({})) as { index?: string; records?: Array<Record<string, unknown>> };
    const idx = vecIndex(env, b.index ?? '');
    if (!idx) return dj({ error: `unknown index: ${b.index}` }, 400);
    const records = Array.isArray(b.records) ? b.records : [];
    if (!records.length) return dj({ error: 'no records' }, 400);
    const pending = records.filter(r => !r.values && r.text !== undefined);
    if (pending.length) {
      const vecs = await embedText(env, pending.map(r => r.text as string));
      pending.forEach((r, i) => { r.values = vecs[i]; });
    }
    const vectors = records.map(r => ({ id: r.id as string, values: r.values as number[], metadata: (r.metadata as Record<string, unknown>) ?? {} }));
    const m = await idx.upsert(vectors) as { mutationId?: string };
    return dj({ mutationId: m?.mutationId, count: vectors.length });
  }

  if (req.method === 'GET' && p === '/data/r2/list') {
    const ls = await env.JOB_SOURCE.list({
      prefix: url.searchParams.get('prefix') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: 1000,
    });
    return dj({ keys: (ls.objects ?? []).map(o => o.key), truncated: ls.truncated, cursor: ls.truncated ? ls.cursor : undefined });
  }

  if (p === '/data/r2') {
    const key = url.searchParams.get('key');
    if (!key) return dj({ error: 'missing key' }, 400);
    if (req.method === 'GET') {
      const obj = await env.JOB_SOURCE.get(key);
      if (!obj) return dj({ error: 'not found', key }, 404);
      return new Response(obj.body, { headers: { 'Content-Type': (obj.httpMetadata as { contentType?: string } | undefined)?.contentType ?? 'application/octet-stream' } });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const ct = url.searchParams.get('contentType') ?? req.headers.get('Content-Type') ?? 'application/octet-stream';
      const body = await req.arrayBuffer();
      await env.JOB_SOURCE.put(key, body, { httpMetadata: { contentType: ct } });
      return dj({ ok: true, key, size: body.byteLength });
    }
    return dj({ error: 'method not allowed' }, 405);
  }

  return dj({ error: 'not found' }, 404);
}
