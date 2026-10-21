# NDSU ARPC AI relay for the Coverage Explorer

A Cloudflare Worker that lets the explorer's AI help (Ask's interpreter and the AI
Analyst) run on **ARPC's** Anthropic account, so readers need no key. The explorer
posts the same request it would send to Anthropic; the Worker adds ARPC's key (kept
as a Cloudflare secret, never in a page or this repo), enforces the guards, and
passes it on.


**Copy for deployment.** The master is in the arpcFCIPcoverage package,
`data-raw/scripts/explorer_ai_relay/`. Cloudflare (ARPC account) deploys this folder
on every push that changes it. No key or secret is in these files.

```
reader's page ──(question, figures)──► this Worker ──(+ ARPC's key)──► Anthropic
             ◄────────(answer)──────── (checks the limits) ◄──────────
```

| File | What |
|---|---|
| `worker.js` | the relay |
| `wrangler.toml` | its name, settings (the guards) and the spend-counter binding |
| `test_worker.mjs` | offline test with stand-ins for Anthropic and KV: `node test_worker.mjs` |

## Guards (settings in `wrangler.toml`, or the dashboard)

| Setting | Default | What |
|---|---|---|
| `RELAY_ON` | `true` | the kill switch; `false` stops all AI calls at once |
| `ALLOWED_ORIGINS` | `https://arpc-ndsu.github.io,https://arpc-coverage-explorer.ftsiboe.workers.dev` | only the explorer's sites (public notice, private copy) may call it |
| `MODEL` | `claude-haiku-4-5` | the only model used, whatever the page asks for |
| `MAX_TOKENS` | `1500` | cap on each answer |
| `MAX_BODY` | `262144` | cap on each request (bytes) |
| `PER_VISIT_CALLS` | `40` | calls per page visit (best effort) |
| `DAILY_USD` / `MONTHLY_USD` | `5` / `50` | spend limits, counted from Anthropic's reported token use |
| `PRICE_IN` / `PRICE_OUT` | `1` / `5` | US$ per million tokens for `MODEL` |

When a limit is reached the explorer answers from the page alone and says AI help is
paused. Without the secret or the KV namespace the Worker refuses everything (fails
closed). It keeps one small record per month of dollars spent, and nothing about the
questions, the answers or the reader.

Also set a **spend limit on the Anthropic Console workspace** whose key you use (a
workspace just for this relay), as a backstop.

## Set up (about 15 minutes)

You need a free Cloudflare account; create it under an ARPC or NDSU address.

**1. The Anthropic key.** In the Claude Console create a workspace for the relay,
set its spend limit (for example US$50 a month), and create an API key in it.

**2. The Worker**, either way:

- *From GitHub (recommended: redeploys on every push).* Cloudflare dashboard →
  Workers & Pages → Create → Import a repository → `arpc-ndsu/arpc-ndsu`. Set the
  **root directory** (under advanced settings) to `explorer-ai-relay`, leave the
  deploy command as `npx wrangler deploy`, and create it. Optionally set the build
  watch path to `explorer-ai-relay/*` so pushes elsewhere in the repo don't redeploy.
- *By hand.* Workers & Pages → Create → Create Worker, name it
  `arpc-explorer-ai-relay`, Deploy, then Edit code, replace everything with
  `worker.js`, and Deploy. Add the settings under Settings → Variables and Secrets
  (type Text), using the table above.

Menu names in the dashboard may differ slightly from these.

**3. The spend counter.** Storage & Databases → KV → Create a namespace
(`arpc-relay-spend`). Its id is already in `wrangler.toml`
(`751af4b0c8a0414f8895e39fe848db7e`, ARPC account) for the GitHub route; by hand, Worker → Settings → Bindings → Add → KV namespace, variable name
`RELAY_KV`.

**4. The secret.** Worker → Settings → Variables and Secrets → Add → type
**Secret**, name `ANTHROPIC_API_KEY`, value the key from step 1.

**5. Check.** Open the Worker's address (`https://arpc-explorer-ai-relay.<your
subdomain>.workers.dev`). It should show `{"ok":true,"relay":"on"}`.

**6. Point the explorer at it.** At the top of `data-raw/scripts/199_deploy_explorer.R`:

```r
AI_RELAY          <- "experiments"   # or "everyone"; "off" to stop using it
AI_RELAY_ENDPOINT <- "https://arpc-explorer-ai-relay.<your subdomain>.workers.dev"
```

Re-run 199 and publish. `"experiments"` gives AI help only to tagged experiment
visits in the AI-on cells (D-on, W-on) of `data-raw/experiments/agent_readers/`;
`"everyone"` gives it to every reader.

To test a local copy of the explorer (opened as a file), add `null` to
`ALLOWED_ORIGINS` for the test and remove it afterwards.

## Limits of the free plan

Cloudflare's free plan allows about 1,000 writes a day to KV; the relay writes once
per AI call, so it serves roughly 1,000 AI calls a day before the counter stops
updating. Well above expected use; Workers Paid removes it if needed.

## Turning it off

Set `RELAY_ON = "false"` (dashboard or `wrangler.toml` and push): every AI call stops
at once and the explorer answers alone. Or set `AI_RELAY <- "off"` in 199 and publish.
