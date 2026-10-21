# NDSU ARPC AI relay and data collection for the Coverage Explorer

A Cloudflare Worker that lets the explorer's AI help (Ask's interpreter and the AI
Analyst) run on **ARPC's** Anthropic account, so readers need no key. The explorer
posts the same request it would send to Anthropic; the Worker adds ARPC's key (kept
as a Cloudflare secret, never in a page or this repo), enforces the guards, and
passes it on.

The same Worker also receives the explorer's anonymous development records
(`POST /collect`), sent only by readers who agree to share and by tagged experiment
visits, and stores them in a Cloudflare D1 database. They are read back only with a
secret export token (`GET /export`, or `explorer_collection/pull_records.R`). See
**Data collection** below.


**Where it is deployed from.** Cloudflare (ARPC account) deploys the copy in the
public `arpc-ndsu/arpc-ndsu` repo, folder `explorer-ai-relay/`. This folder in the
package is the master: edit here, then copy the four files there and push.

```
reader's page ──(question, figures)──► this Worker ──(+ ARPC's key)──► Anthropic
             ◄────────(answer)──────── (checks the limits) ◄──────────
```

| File | What |
|---|---|
| `worker.js` | the relay |
| `wrangler.toml` | its name, settings (the guards) and the spend-counter binding |
| `test_worker.mjs` | offline test with stand-ins for Anthropic, KV and D1: `node test_worker.mjs` (the D1 part needs Node 22.5 or later) |

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
| `COLLECT_ON` | `true` | data collection; `false` stops storing records at once (the AI is unaffected) |

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
visits in the AI-on cells (D-on, W-on) of the agent-reader experiment (`experiment/` in the ai-tools-policy-evidence repository);
`"everyone"` gives it to every reader.

To test a local copy of the explorer (opened as a file), add `null` to
`ALLOWED_ORIGINS` for the test and remove it afterwards.

## Data collection

**What is stored.** One row per record in the D1 table `records`: the fields
`share.js` sends (question as typed, how the page read it, AI used or refused,
tokens, cost, coarse context; see the `COLUMNS` list in `worker.js`), the
server's time (`received`) and, for experiment visits, `exp`, `round`, `cell` and
`agent`. Never the sender's network address, never the answers, never a key.
Junk is limited, not prevented: only the explorer's sites (`ALLOWED_ORIGINS`), JSON
with schema 2, a hex session id and a known tab; strings capped at 600
characters; unknown fields kept in `extra`; at most 200 records per session per
six hours. `/collect` answers 204 whatever happens.

**Set up (about 5 minutes), in the ARPC Cloudflare account:**

1. *The database.* Storage & Databases → D1 → Create database, name
   `arpc-explorer-records` (or `npx wrangler d1 create arpc-explorer-records`).
   Copy its database id.
2. *The binding.* In `wrangler.toml`, remove the `#` from the four
   `[[d1_databases]]` lines at the end and paste the id into `database_id`. Copy
   the files to the deploying repo and push (or bind it by hand: Worker →
   Settings → Bindings → Add → D1 database, variable name `DB`). The table is
   created on the first record.
3. *The export token.* Make a long random string (for example in R:
   `paste(sample(c(letters, LETTERS, 0:9), 40, TRUE), collapse = "")`). Worker →
   Settings → Variables and Secrets → Add → type **Secret**, name `EXPORT_TOKEN`.
   Keep the same string on your computer as the environment variable
   `EXPLORER_EXPORT_TOKEN` (in `.Renviron`), never in a file in a repo.
4. *Point the explorer at it.* At the top of `data-raw/scripts/199_deploy_explorer.R`,
   `SHARE_ENDPOINT <- "https://arpc-explorer-ai-relay.arpc-bd4.workers.dev/collect"`
   (already set). Re-run 199 and publish.
5. *Check.* Open the explorer, accept the sharing invitation, ask a question, then
   in R: `source("data-raw/scripts/explorer_collection/pull_records.R")`. The
   question appears in `records.csv`.

**Reading records.** `pull_records.R` downloads `records` (real readers) and
`experiments` (tagged visits) as CSV. By hand:
`curl -H "Authorization: Bearer $EXPLORER_EXPORT_TOKEN" "https://arpc-explorer-ai-relay.arpc-bd4.workers.dev/export?table=experiments"`.
The D1 console in the dashboard also runs SQL on the table directly.

**Deleting records.** D1 console: for example
`DELETE FROM records WHERE received < '2026-01-01'`, or
`UPDATE records SET question = NULL WHERE received < date('now', '-12 months')`
to blank old question text.

## Limits of the free plan

Cloudflare's free plan allows about 1,000 writes a day to KV; the relay writes once
per AI call, so it serves roughly 1,000 AI calls a day before the counter stops
updating. D1's free plan allows 100,000 row writes and 5 million row reads a day
and 5 GB of storage; each record is one write and one small read. Both are well
above expected use; Workers Paid removes them if needed.

## Turning it off

Set `RELAY_ON = "false"` (dashboard or `wrangler.toml` and push): every AI call stops
at once and the explorer answers alone. Or set `AI_RELAY <- "off"` in 199 and publish.
`COLLECT_ON = "false"` stops storing records the same way; `SHARE_COLLECT <- FALSE` in
199 removes collection from the page.
