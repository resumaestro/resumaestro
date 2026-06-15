// ---- Cloudflare data gateway (GET|POST /data/*) ---------------------------
// Internal — only reachable via service binding from composer.

import type { Env, JobRow } from '#/types';
import { createResponseInit } from '#/headers';
import { makeJobId, createJob, getJob, listJobs } from '#/db';

export const EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';

const dj = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), createResponseInit('json', status));

function vecIndex(env: Env, name: string): VectorizeIndex | null {
  switch (String(name ?? '').toLowerCase()) {
    case 'resumaestro-companies':
    case 'companies':
      return env.RESUMAESTRO_COMPANIES;
    case 'resumaestro-teammembers':
    case 'teammembers':
      return env.RESUMAESTRO_TEAMMEMBERS;
    case 'resumaestro-roles':
    case 'roles':
      return env.RESUMAESTRO_ROLES;
    case 'source-code-rag':
    case 'source-code':
      return env.VEC_CODE;
    default:
      return null;
  }
}

async function embedText(
  env: Env,
  text: string | string[],
): Promise<number[][]> {
  const input = Array.isArray(text) ? text : [text];
  const res = (await env.AI.run(EMBED_MODEL, { text: input })) as
    | { data?: number[][] }
    | number[][];
  return (
    Array.isArray(res) ? res : ((res as { data?: number[][] }).data ?? [])
  ) as number[][];
}

export async function handleData(
  request: Request,
  env: Env,
  _executionContext: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const p = url.pathname;

  // ---- D1: job record CRUD ------------------------------------------------

  // POST /data/d1/jobs - create (or skip-on-conflict) a job row.
  if (request.method === 'POST' && p === '/data/d1/jobs') {
    const b = (await request.json().catch(() => ({}))) as Partial<JobRow> & {
      listing_url?: string;
    };
    if (!b.listing_url) return dj({ error: 'missing listing_url' }, 400);
    const id = b.id ?? (await makeJobId(b.listing_url));
    await createJob(env, { ...b, id, listing_url: b.listing_url });
    const inserted = await getJob(env, id);
    return dj({ ok: true, id, job: inserted });
  }

  // GET /data/d1/jobs - list jobs (accepts ?filter=active|staged|parked)
  if (request.method === 'GET' && p === '/data/d1/jobs') {
    const viewParam = url.searchParams.get('view') ?? url.searchParams.get('filter') ?? 'jobs';
    const view = (viewParam === 'pipeline' || viewParam === 'parked') ? viewParam : 'jobs';
    const jobs = await listJobs(env, view);
    return dj({ jobs, count: jobs.length });
  }

  // GET /data/d1/jobs/:id - fetch single job
  if (request.method === 'GET' && p.startsWith('/data/d1/jobs/')) {
    const id = p.slice('/data/d1/jobs/'.length);
    if (!id) return dj({ error: 'missing id' }, 400);
    const job = await getJob(env, id);
    if (!job) return dj({ error: 'not found' }, 404);
    return dj({ job });
  }

  // ---- Embeddings ---------------------------------------------------------

  if (request.method === 'POST' && p === '/data/embed') {
    const b = (await request.json().catch(() => ({}))) as {
      text?: string | string[];
    };
    if (b.text === undefined) return dj({ error: 'missing text' }, 400);
    const vectors = await embedText(env, b.text);
    return dj({ dim: vectors[0]?.length ?? 0, vectors, vector: vectors[0] });
  }

  if (request.method === 'POST' && p === '/data/vector/query') {
    const b = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const idx = vecIndex(env, b.index as string);
    if (!idx) return dj({ error: `unknown index: ${b.index}` }, 400);
    let vector = b.vector as number[] | undefined;
    if (!vector && b.text !== undefined)
      vector = (await embedText(env, b.text as string))[0];
    if (!vector) return dj({ error: 'provide text or vector' }, 400);
    const opts: Record<string, unknown> = {
      topK: b.topK ?? 5,
      returnMetadata: b.returnMetadata ?? 'all',
      returnValues: b.returnValues ?? false,
    };
    if (b.filter) opts.filter = b.filter;
    const r = (await idx.query(vector, opts)) as {
      count: number;
      matches: unknown[];
    };
    return dj({ count: r.count, matches: r.matches ?? [] });
  }

  if (request.method === 'POST' && p === '/data/vector/upsert') {
    const b = (await request.json().catch(() => ({}))) as {
      index?: string;
      records?: Array<Record<string, unknown>>;
    };
    const idx = vecIndex(env, b.index ?? '');
    if (!idx) return dj({ error: `unknown index: ${b.index}` }, 400);
    const records = Array.isArray(b.records) ? b.records : [];
    if (!records.length) return dj({ error: 'no records' }, 400);
    const pending = records.filter((r) => !r.values && r.text !== undefined);
    if (pending.length) {
      const vecs = await embedText(
        env,
        pending.map((r) => r.text as string),
      );
      pending.forEach((r, i) => {
        r.values = vecs[i];
      });
    }
    const vectors = records.map((r) => ({
      id: r.id as string,
      values: r.values as number[],
      metadata: (r.metadata as Record<string, VectorizeVectorMetadata>) ?? {},
    }));
    const m = (await idx.upsert(vectors)) as { mutationId?: string };
    return dj({ mutationId: m?.mutationId, count: vectors.length });
  }

  if (request.method === 'GET' && p === '/data/r2/list') {
    const ls = await env.RESUMAESTRO_SOURCE.list({
      prefix: url.searchParams.get('prefix') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: 1000,
    });
    return dj({
      keys: (ls.objects ?? []).map((o) => o.key),
      truncated: ls.truncated,
      cursor: ls.truncated ? ls.cursor : undefined,
    });
  }

  if (p === '/data/r2') {
    const key = url.searchParams.get('key');
    if (!key) return dj({ error: 'missing key' }, 400);
    if (request.method === 'GET') {
      const obj = await env.RESUMAESTRO_SOURCE.get(key);
      if (!obj) return dj({ error: 'not found', key }, 404);
      return new Response(obj.body, {
        headers: {
          'Content-Type':
            (obj.httpMetadata as { contentType?: string } | undefined)
              ?.contentType ?? 'application/octet-stream',
        },
      });
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      const ct =
        url.searchParams.get('contentType') ??
        request.headers.get('Content-Type') ??
        'application/octet-stream';
      const body = await request.arrayBuffer();
      await env.RESUMAESTRO_SOURCE.put(key, body, {
        httpMetadata: { contentType: ct },
      });
      return dj({ ok: true, key, size: body.byteLength });
    }
    return dj({ error: 'method not allowed' }, 405);
  }

  return dj({ error: 'not found' }, 404);
}
