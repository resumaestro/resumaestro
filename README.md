# resumaestro

The **control plane**. Owns the Slack surface, the job pipeline state, and the human interaction loop. It does not do intelligence work — it delegates that entirely to the composer.

---

## Responsibilities

- Receive and authenticate all Slack events (slash commands, block actions, view submissions, app home)
- Maintain the canonical pipeline record for every job in D1
- Render the App Home (Jobs view, Pipeline view, Parking Lot) from D1 state
- Open modals and collect structured intent from the user (research depth, apply context)
- Wake the composer for each pipeline step and give it everything it needs
- Receive composer results at `POST /jobs/:id/result` and write them back to D1
- Refresh the App Home after every state change
- Expose raw Cloudflare resources (R2, Vectorize, AI, D1) to the composer via the `/data/*` gateway, bearer-authenticated

## What it does not own

- Intelligence: web research, resume synthesis, form-filling logic — all composer
- Decisions about search depth, query strategy, or credit cost — composer decides based on the intent payload it receives
- Vectorize reads or writes outside of the `/data/vector/*` gateway

---

## Pipeline state model

Every job row carries three orthogonal columns:

| Column | Values | Meaning |
|---|---|---|
| `in_flight` | `SCORING \| RESEARCHING \| TAILORING \| APPLYING \| null` | What the composer is currently doing. `null` = idle, waiting on the user. |
| `job_status` | `EVALUATING \| STAGED \| PARKED` | Where the job sits in the user's pipeline. `EVALUATING` = active board. `STAGED` = committed to applying. `PARKED` = archived. |
| `stage` | `IDLE \| APPLIED \| INTERVIEWING \| OFFERED \| null` | Progress through the application process. Only set once a job is staged or applied to. `null` = not yet in that track. |

A job can appear in both **Jobs view** and **Pipeline view** simultaneously — e.g. `job_status=EVALUATING, stage=APPLIED, in_flight=null` shows in Jobs/Idle and Pipeline/Applied.

---

## Contract with the composer

resumaestro is the **caller**. It initiates every composer interaction and owns the result.

### Outbound — waking the composer

resumaestro POSTs to `AGENT_WEBHOOK_URL/agent` with this shape:

```ts
{
  mode: 'surface_scan' | 'deep_research' | 'tailor' | 'refine' | 'apply'
  job_id: string           // D1 jobs.id
  callback_url: string     // must be POST /jobs/:id/result on this worker
  company?: string
  listing_url?: string     // surface_scan, tailor
  depth?: 'quick' | 'standard' | 'deep'   // deep_research
  facets?: string[]        // deep_research
  manager_name?: string    // deep_research
  concern?: string         // deep_research
  feedback?: string        // refine
  tone?: string            // apply
  emphasis?: string        // apply
}
```

The composer must acknowledge with `202`. resumaestro does not wait for the result — it sets `in_flight` immediately and returns to Slack.

### Inbound — receiving results

The composer delivers results to `POST /jobs/:id/result`. resumaestro expects:

```ts
// surface_scan
{ type: 'surface_scan', company, role, comp, work_model, company_url, job_url, scores_json }

// deep_research
{ type: 'research', summary, signals_json, sources_json, brief_key }

// tailor or refine
{ type: 'tailor', resume_pdf_key }

// apply — completed
{ type: 'apply' }

// apply — composer needs more info from the user
{ type: 'apply_needs_input', questions: [{ field, question }] }
```

On receipt, resumaestro writes the new fields to D1, clears `in_flight`, and refreshes the App Home. For `apply_needs_input` it also posts the questions to the job's Slack thread and surfaces an alert on the Pipeline card.

### Data gateway

resumaestro exposes its Cloudflare bindings to the composer via bearer-authenticated routes:

| Route | What it gives |
|---|---|
| `GET/PUT /data/r2?key=` | R2 read/write |
| `POST /data/embed` | Workers AI embeddings |
| `POST /data/vector/query` | Vectorize query |
| `POST /data/vector/upsert` | Vectorize upsert |
| `GET /data/d1/jobs/:id` | Single job record |

The composer uses these to read source files (experience.yml, listing HTML) and write research artifacts back. The bearer token is `AGENT_API_TOKEN`.

---

## Deploy

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put AGENT_API_TOKEN
npx wrangler deploy
```

Set `AGENT_WEBHOOK_URL` in `wrangler.toml` to the deployed composer URL.

Migrations run automatically on merge to `main` via `.github/workflows/migrate.yml`.
