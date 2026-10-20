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
 * WHAT IT KEEPS: one small record per UTC month of dollars spent (and per day).
 * Nothing about the questions, the answers or the reader.
 */

const DEFAULTS = {
  RELAY_ON: "true", ALLOWED_ORIGINS: "https://arpc-ndsu.github.io", MODEL: "claude-haiku-4-5",
  MAX_TOKENS: "1500", MAX_BODY: "262144", PER_VISIT_CALLS: "40", DAILY_USD: "5", MONTHLY_USD: "50",
  PRICE_IN: "1", PRICE_OUT: "5"
};
const UPSTREAM = "https://api.anthropic.com/v1/messages";
const KEEP = ["model", "max_tokens", "system", "messages", "tools", "tool_choice", "thinking", "output_config", "temperature", "stop_sequences"];
const visits = new Map();                    // visit id -> {day, n}; per instance, best effort

function settings(env) {
  const g = k => (env && env[k] != null && String(env[k]) !== "" ? String(env[k]) : DEFAULTS[k]);
  const num = k => { const x = Number(g(k)); return Number.isFinite(x) && x >= 0 ? x : Number(DEFAULTS[k]); };
  return {
    on: g("RELAY_ON").toLowerCase() !== "false",
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
