/* NDSU ARPC AI relay for the Coverage Explorer (Cloudflare Worker).
 *
 * The explorer's AI help (Ask's interpreter, the AI Analyst) can run on ARPC's
 * Anthropic account instead of a reader's own key. The page never holds ARPC's
 * key: it posts the same request it would send to Anthropic here, and this Worker
 * adds the key (a Worker secret), applies the guards below, and passes the
 * request on. Setup and settings: README.md beside this file.
 *
 * GUARDS, each a setting (wrangler.toml [vars] or the dashboard):
 *   RELAY_ON          "true" / "false": the kill switch
 *   ALLOWED_ORIGINS   comma list of sites allowed to call (the browser's Origin header)
 *   MODEL             the only model used, whatever the page asks for
 *   MAX_TOKENS        cap on each answer's length
 *   MAX_BODY          cap on each request's size, in bytes
 *   PER_VISIT_CALLS   calls per page visit (best effort: counted per Worker instance)
 *   DAILY_USD         spend limit per UTC day, counted from Anthropic's reported token use
 *   MONTHLY_USD       spend limit per UTC month
 *   PRICE_IN, PRICE_OUT   US$ per million input / output tokens for MODEL
 * Bindings: ANTHROPIC_API_KEY (secret), RELAY_KV (a KV namespace for the spend
 * counter). Without either, the relay refuses every request: it fails closed.
 *
 * WHAT IT KEEPS for the AI: one small record per UTC month of dollars spent (and
 * per day). Nothing about the questions, the answers or the reader.
 *
 * DATA COLLECTION, the second job (POST /collect, GET /export). The explorer's
 * anonymous development records (data-raw/explorer/src/share.js), sent only by
 * readers who agreed to share and by tagged experiment visits, are stored in a
 * Cloudflare D1 database bound as DB: one row per record in the table "records".
 * Experiment visits carry exp, round, cell and agent; the rest leave them empty.
 *   COLLECT_ON    "true" / "false": stops storing records at once
 *   EXPORT_TOKEN  (secret) the only way to read records back: GET /export with
 *                 "Authorization: Bearer <token>" returns CSV. Unset = no export.
 * /collect answers 204 whatever happens, like any beacon receiver; junk is
 * limited, not prevented: JSON, schema 2, a hex session id, a known tab, known
 * fields only (others go to "extra"), strings capped, at most MAX_PER_SESSION
 * records per session per six hours. The sender's network address is never
 * stored. Without DB, records are dropped quietly and the AI relay is unaffected.
 */

const DEFAULTS = {
  RELAY_ON: "true", ALLOWED_ORIGINS: "https://arpc-ndsu.github.io", MODEL: "claude-haiku-4-5",
  MAX_TOKENS: "1500", MAX_BODY: "262144", PER_VISIT_CALLS: "40", DAILY_USD: "5", MONTHLY_USD: "50",
  PRICE_IN: "1", PRICE_OUT: "5", COLLECT_ON: "true"
};
const UPSTREAM = "https://api.anthropic.com/v1/messages";
const KEEP = ["model", "max_tokens", "system", "messages", "tools", "tool_choice", "thinking", "output_config", "temperature", "stop_sequences"];
const visits = new Map();                    // visit id -> {day, n}; per instance, best effort

/* ---- data collection ---------------------------------------------------------- */
// One column per field, in this order; "received" is the server's time, "t" the
// explorer's hour. Fields the explorer adds later land in "extra".
const COLUMNS = [
  "received", "exp", "round", "cell", "agent",
  "schema", "session", "turn", "t", "build", "tab", "kind",
  "question", "query", "confidence", "ai", "refused", "error", "model",
  "tokens_in", "tokens_out", "ms",
  "quoted", "found", "unverified", "fetched", "care_added", "vote",
  "tz", "browser", "browser_major", "device", "width", "lang", "opened",
  "ai_route", "ai_off", "setting", "value", "cost_usd", "copy_id", "extra"
];
const TAGS = ["exp", "round", "cell", "agent"];
const TAG_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const TABS = ["ask", "analyst"];
const IGNORED = ["received", "extra"];       // never taken from the sender
const MAX_RECORD = 8000, MAX_STR = 600, MAX_PER_SESSION = 200, MAX_EXPORT = 100000;
const tablesReady = new WeakSet();           // per instance and database: CREATE TABLE IF NOT EXISTS once

async function ensureTable(db) {
  if (tablesReady.has(db)) return;
  const cols = COLUMNS.map(c => `"${c}"` + (c === "received" ? " TEXT NOT NULL" : "")).join(", ");
  await db.prepare(`CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols})`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS records_session ON records (session, received)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS records_exp ON records (exp, received)").run();
  tablesReady.add(db);
}
const capStr = v => { v = String(v); return v.length > MAX_STR ? v.slice(0, MAX_STR) : v; };
function cleanValue(v) {
  if (v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") return capStr(v);
  if (typeof v === "object") { try { return capStr(JSON.stringify(v)); } catch (e) { return undefined; } }
  return undefined;
}
/* A clean record, or null when the body is not one of ours. */
function parseRecord(text) {
  if (typeof text !== "string" || !text || text.length > MAX_RECORD) return null;
  let r; try { r = JSON.parse(text); } catch (e) { return null; }
  if (!r || typeof r !== "object" || Array.isArray(r) || r.schema !== 2) return null;
  if (typeof r.session !== "string" || !/^[0-9a-f]{8,32}$/.test(r.session) || !TABS.includes(r.tab)) return null;
  const out = {}, extra = {};
  for (const k of Object.keys(r)) {
    if (IGNORED.includes(k)) continue;
    if (TAGS.includes(k)) { if (typeof r[k] === "string" && TAG_RE.test(r[k])) out[k] = r[k]; continue; }
    const v = cleanValue(r[k]);
    if (v === undefined) continue;
    if (COLUMNS.includes(k)) out[k] = v; else if (Object.keys(extra).length < 10 && k.length <= 40) extra[k] = v;
  }
  if (Object.keys(extra).length) out.extra = capStr(JSON.stringify(extra));
  if (!out.exp) for (const k of TAGS) delete out[k];          // tags count only with exp
  return out;
}
async function collect(text, env) {
  const rec = parseRecord(text);
  if (!rec) return;
  await ensureTable(env.DB);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE session = ?1 AND received > ?2")
    .bind(rec.session, new Date(Date.now() - 6 * 3600 * 1000).toISOString()).first();
  if (n && n.n >= MAX_PER_SESSION) return;
  rec.received = new Date().toISOString();
  const cols = COLUMNS.filter(c => rec[c] !== undefined);
  await env.DB.prepare(`INSERT INTO records (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")})`)
    .bind(...cols.map(c => rec[c])).run();
}
/* CSV of the records: table=records (real readers) or experiments (tagged visits);
   since=YYYY-MM-DD optional. A cell starting with = + - @ gets a leading ' so a
   spreadsheet reads it as text. */
function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function exportCsv(url, env) {
  const which = url.searchParams.get("table") || "records";
  if (!["records", "experiments"].includes(which)) return err(400, "bad_table", "table is records or experiments.");
  const since = url.searchParams.get("since") || "";
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return err(400, "bad_since", "since is YYYY-MM-DD.");
  await ensureTable(env.DB);
  const where = (which === "experiments" ? "exp IS NOT NULL" : "exp IS NULL") + (since ? " AND received >= ?1" : "");
  const st = env.DB.prepare(`SELECT ${COLUMNS.map(c => `"${c}"`).join(", ")} FROM records WHERE ${where} ORDER BY id LIMIT ${MAX_EXPORT}`);
  const res = await (since ? st.bind(since) : st).all();
  const cols = which === "experiments" ? COLUMNS : COLUMNS.filter(c => !TAGS.includes(c));
  const lines = [cols.join(",")].concat((res.results || []).map(r => cols.map(c => csvCell(r[c])).join(",")));
  return new Response(lines.join("\r\n") + "\r\n", {status: 200, headers: {"content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="explorer-${which}.csv"`, "cache-control": "no-store"}});
}

function settings(env) {
  const g = k => (env && env[k] != null && String(env[k]) !== "" ? String(env[k]) : DEFAULTS[k]);
  const num = k => { const x = Number(g(k)); return Number.isFinite(x) && x >= 0 ? x : Number(DEFAULTS[k]); };
  return {
    on: g("RELAY_ON").toLowerCase() !== "false", collectOn: g("COLLECT_ON").toLowerCase() !== "false",
    origins: g("ALLOWED_ORIGINS").split(",").map(s => s.trim()).filter(Boolean),
    model: g("MODEL"), maxTokens: num("MAX_TOKENS"), maxBody: num("MAX_BODY"), perVisit: num("PER_VISIT_CALLS"),
    daily: num("DAILY_USD"), monthly: num("MONTHLY_USD"), priceIn: num("PRICE_IN"), priceOut: num("PRICE_OUT")
  };
}
const json = (status, obj, headers) => new Response(JSON.stringify(obj), {status, headers: {"content-type": "application/json", ...headers}});
const err = (status, type, message, headers) => json(status, {type: "error", error: {type, message}}, headers);
const today = () => new Date().toISOString().slice(0, 10);       // UTC
const monthKey = d => "spend:" + d.slice(0, 7);

async function readSpend(env, d) {
  const raw = await env.RELAY_KV.get(monthKey(d));
  const s = raw ? JSON.parse(raw) : {month: 0, days: {}};
  return {doc: s, day: s.days[d] || 0, month: s.month || 0};
}
async function addSpend(env, usd) {
  if (!(usd > 0)) return;
  const d = today(), {doc} = await readSpend(env, d);           // read-modify-write: a race can undercount by one call, never lose the month
  doc.month = (doc.month || 0) + usd; doc.days[d] = (doc.days[d] || 0) + usd;
  await env.RELAY_KV.put(monthKey(d), JSON.stringify(doc), {expirationTtl: 60 * 60 * 24 * 400});
}

export default {
  async fetch(request, env, ctx) {
    const cfg = settings(env), url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = cfg.origins.includes(origin);
    const cors = allowed ? {"Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "86400"} : {"Vary": "Origin"};

    if (request.method === "OPTIONS") return new Response(null, {status: allowed ? 204 : 403, headers: cors});

    // data collection: store a record (204 whatever happens) or read them back with the export token
    if (url.pathname === "/collect") {
      if (request.method === "POST" && allowed && cfg.collectOn && env.DB) {
        const text = await request.text().catch(() => "");
        const w = collect(text, env).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(w); else await w;
      }
      return new Response(null, {status: 204, headers: cors});
    }
    if (url.pathname === "/export") {
      const auth = request.headers.get("Authorization") || "";
      if (request.method !== "GET" || !env.EXPORT_TOKEN || !env.DB || !sameSecret(auth, "Bearer " + env.EXPORT_TOKEN))
        return err(404, "not_found", "Not found.");
      return exportCsv(url, env);
    }

    if (request.method === "GET") return json(200, {ok: true, relay: cfg.on ? "on" : "off"}, cors);   // health check; says nothing else
    if (request.method !== "POST") return err(405, "method_not_allowed", "POST only.", cors);
    if (!allowed) return err(403, "forbidden_origin", "This relay serves the NDSU ARPC Coverage Explorer only.", cors);
    if (!cfg.on) return err(503, "relay_off", "AI help is switched off.", cors);
    if (!env.ANTHROPIC_API_KEY || !env.RELAY_KV) return err(500, "relay_not_configured", "The relay is not configured.", cors);

    const visit = url.searchParams.get("v") || "";
    if (!/^[0-9a-f]{8,32}$/.test(visit)) return err(400, "bad_visit", "Missing visit id.", cors);
    const text = await request.text();
    if (text.length > cfg.maxBody) return err(413, "too_large", "The request is too large.", cors);
    let body; try { body = JSON.parse(text); } catch (e) { return err(400, "bad_json", "The request is not JSON.", cors); }
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return err(400, "bad_request", "No messages.", cors);

    // per visit (best effort; the spend limits are the real guard)
    const d = today(), v = visits.get(visit);
    const n = v && v.day === d ? v.n + 1 : 1;
    if (n > cfg.perVisit) return err(429, "visit_limit", "AI help for this visit has reached its limit; answers come from the page alone.", cors);
    visits.set(visit, {day: d, n});
    if (visits.size > 5000) visits.delete(visits.keys().next().value);

    // spend limits
    const spent = await readSpend(env, d);
    if (spent.day >= cfg.daily || spent.month >= cfg.monthly)
      return err(429, "budget", `AI help is paused ${spent.month >= cfg.monthly ? "for the month" : "for today"}; answers come from the page alone.`, cors);

    // the request ARPC pays for: our model, a capped answer, only the fields Anthropic needs
    const up = {};
    for (const k of KEEP) if (body[k] !== undefined) up[k] = body[k];
    up.model = cfg.model;
    up.max_tokens = Math.max(1, Math.min(Number(body.max_tokens) || 1024, cfg.maxTokens));

    let r;
    try {
      r = await fetch(UPSTREAM, {method: "POST", body: JSON.stringify(up),
        headers: {"content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01"}});
    } catch (e) { return err(502, "upstream_unreachable", "The AI provider could not be reached.", cors); }
    const out = await r.text();
    if (r.ok) {
      try { const u = JSON.parse(out).usage || {};
        const inp = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), o = u.output_tokens || 0;
        const usd = (inp * cfg.priceIn + o * cfg.priceOut) / 1e6;
        const w = addSpend(env, usd); if (ctx && ctx.waitUntil) ctx.waitUntil(w); else await w;
      } catch (e) { /* no usage to count; the request still answers */ }
    }
    return new Response(out, {status: r.status, headers: {"content-type": "application/json", ...cors}});
  }
};
