# job-slack

Interactivity and input plane for the **Job Application Apply** agent. It serves the
Slack Apply/Edit pages, persists input to the `job-source` R2 bucket, and wakes the
agent. Slack is the first adapter; the `POST /action` core and the `notifyAgent()`
seam are built so new surfaces (email, web, Telegram) and a direct agent webhook can
be added without reworking the core.

## Deploy

```bash
npm install
npx wrangler secret put SLACK_BOT_TOKEN   # xoxb- token with chat:write to #orchestra
npx wrangler deploy
```

## Configure

- `wrangler.toml` > `[vars] SLACK_CHANNEL` — #orchestra channel id (preset to `C0BA8G3UFNJ`).
- `wrangler.toml` > `[vars] AGENT_MENTION` — set to `"<@U...>"` if #orchestra is mentions-only, so the worker's control line force-triggers the agent. Leave blank if the channel is "always respond".
- After deploy, paste the worker URL into the agent's `JOB_SLACK_URL`.

## Routes

| Route | Purpose |
|---|---|
| `GET`/`POST` `/s/a/<id>?t=<token>` | Slack Apply confirm page |
| `GET`/`POST` `/s/e/<id>?t=<token>` | Slack Edit free-text form |
| `POST /action` | surface-agnostic core (reused by every future surface) |
| `GET /health` | health check |

## How the loop closes

1. The agent builds an `apply/submissions/<id>.json` record in R2 with an unguessable `token` and posts a review card to #orchestra with link-buttons to `/s/a` and `/s/e`.
2. Cameron clicks Apply or Edit. This worker validates the token, writes the change to R2, and calls `notifyAgent()`.
3. `notifyAgent()` posts a control line into #orchestra, which re-invokes the agent. The agent resumes from the R2 record.

> If your inbound Slack trigger ignores bot-authored messages, swap `notifyAgent()`
> to POST a dedicated agent webhook instead. That function is the only thing to change.
