// Offline test of worker.js: Anthropic and KV replaced by stand-ins. node test_worker.mjs
import worker from "./worker.js";
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const ORIGIN = "https://arpc-ndsu.github.io";
let upstream = [];
let reply = () => new Response(JSON.stringify({content: [{type: "text", text: "{}"}], usage: {input_tokens: 1000, output_tokens: 100}}), {status: 200});
globalThis.fetch = async (url, init) => { upstream.push({url, init}); return reply(); };
const kv = () => { const m = new Map(); return {m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }}; };
const envOf = (over = {}) => ({ANTHROPIC_API_KEY: "TEST-ARPC-SECRET", RELAY_KV: kv(), ...over});
const req = (body, {origin = ORIGIN, v = "abcdef0123456789", method = "POST"} = {}) =>
  new Request("https://relay.example.workers.dev/?v=" + v, {method, headers: {"content-type": "text/plain;charset=utf-8", ...(origin ? {Origin: origin} : {})},
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined});
const good = {model: "claude-opus-5-5", max_tokens: 99999, system: "s", messages: [{role: "user", content: "q"}], thinking: {type: "disabled"}, evil: "x", stream: true};
const run = async (r, env) => { const res = await worker.fetch(r, env, {waitUntil: p => p}); const t = await res.text(); return {res, t, j: (() => { try { return JSON.parse(t); } catch (e) { return null; } })()}; };

let env = envOf(), x;
x = await run(req(null, {method: "OPTIONS"}), env); ok(x.res.status === 204 && x.res.headers.get("access-control-allow-origin") === ORIGIN, "preflight from the site");
x = await run(req(null, {method: "OPTIONS", origin: "https://evil.example"}), env); ok(x.res.status === 403 && !x.res.headers.get("access-control-allow-origin"), "preflight from elsewhere refused");
x = await run(req(null, {method: "GET"}), env); ok(x.res.status === 200 && x.j.relay === "on" && !/spend|usd/i.test(x.t), "health check says on, nothing else");
x = await run(req(good, {origin: "https://evil.example"}), env); ok(x.res.status === 403 && upstream.length === 0, "other origin refused, nothing sent upstream");
x = await run(req(good, {origin: ""}), env); ok(x.res.status === 403, "no origin refused");
x = await run(req(good), envOf({RELAY_ON: "false"})); ok(x.res.status === 503 && x.j.error.type === "relay_off", "kill switch");
x = await run(req(good), {RELAY_KV: kv()}); ok(x.res.status === 500 && x.j.error.type === "relay_not_configured", "no key: fails closed");
x = await run(req(good), {ANTHROPIC_API_KEY: "k"}); ok(x.res.status === 500, "no KV: fails closed");
x = await run(req(good, {v: "zz"}), env); ok(x.res.status === 400 && x.j.error.type === "bad_visit", "visit id required");
x = await run(req("x".repeat(300000)), env); ok(x.res.status === 413, "oversize refused");
x = await run(req("not json"), env); ok(x.res.status === 400 && x.j.error.type === "bad_json", "bad json");
upstream = [];
x = await run(req(good), env);
ok(x.res.status === 200 && x.res.headers.get("access-control-allow-origin") === ORIGIN, "answered, with CORS");
const sent = JSON.parse(upstream[0].init.body), hd = upstream[0].init.headers;
ok(upstream[0].url === "https://api.anthropic.com/v1/messages", "upstream is Anthropic");
ok(sent.model === "claude-haiku-4-5" && sent.max_tokens === 1500 && !("evil" in sent) && !("stream" in sent) && sent.thinking.type === "disabled", "model forced, answer capped, unknown fields dropped: " + JSON.stringify(sent));
ok(hd["x-api-key"] === "TEST-ARPC-SECRET" && !x.t.includes("SECRET"), "key added upstream, never echoed");
const doc = JSON.parse([...env.RELAY_KV.m.values()][0]); ok(Math.abs(doc.month - 0.0015) < 1e-9, "spend counted from usage: " + JSON.stringify(doc));
// spend limit: with a tiny daily cap the next call is paused, and nothing goes upstream
env = envOf({DAILY_USD: "0.002"}); upstream = [];
await run(req(good), env); x = await run(req(good), env); x = await run(req(good), env);
ok(x.res.status === 429 && x.j.error.type === "budget" && /paused for today/.test(x.j.error.message), "daily limit pauses: " + x.t);
ok(upstream.length === 2, "no upstream call once paused, got " + upstream.length);
x = await run(req(good), envOf({MONTHLY_USD: "0"})); ok(x.res.status === 429 && /for the month/.test(x.j.error.message), "monthly limit");
// per visit
env = envOf({PER_VISIT_CALLS: "2"});
await run(req(good, {v: "aaaa1111"}), env); await run(req(good, {v: "aaaa1111"}), env); x = await run(req(good, {v: "aaaa1111"}), env);
ok(x.res.status === 429 && x.j.error.type === "visit_limit", "visit limit");
x = await run(req(good, {v: "bbbb2222"}), env); ok(x.res.status === 200, "another visit still served");
// upstream errors pass through (the page reads Anthropic's thinking-form hint from a 400)
reply = () => new Response(JSON.stringify({type: "error", error: {type: "invalid_request_error", message: 'send "thinking": {"type": "between_tools"}'}}), {status: 400});
x = await run(req(good), envOf()); ok(x.res.status === 400 && /between_tools/.test(x.t) && x.res.headers.get("access-control-allow-origin") === ORIGIN, "upstream 400 passed through with CORS");
reply = () => { throw new Error("down"); };
x = await run(req(good), envOf()); ok(x.res.status === 502, "upstream unreachable");

if (fails.length) { console.error("test_worker: FAILED\n  " + fails.join("\n  ")); process.exit(1); }
console.log("test_worker: ok — origin check and CORS, kill switch, fails closed without key or KV, visit id, size cap, model forced, answer capped, fields dropped, key never echoed, spend counted, daily and monthly limits pause before any upstream call, per-visit limit, upstream errors passed through.");
