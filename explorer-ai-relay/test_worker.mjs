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
// waitUntil work (the spend counter, storing a record) runs after the reply, as on Cloudflare; the test waits for it before checking.
const run = async (r, env) => { const bg = []; const res = await worker.fetch(r, env, {waitUntil: p => { bg.push(p); }}); await Promise.all(bg); const t = await res.text(); return {res, t, j: (() => { try { return JSON.parse(t); } catch (e) { return null; } })()}; };

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

// ---- data collection: /collect and /export against a real SQLite standing in for D1
// (node:sqlite, Node 22.5 or later; skipped with a note on older Node).
let collectNote = "collection skipped (needs Node 22.5+ for node:sqlite)";
let sqlite = null;
try { sqlite = await import("node:sqlite"); } catch (e) { /* older Node */ }
if (sqlite) {
  const d1 = () => { const db = new sqlite.DatabaseSync(":memory:");
    const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a),
      run: async () => { db.prepare(sql).run(...args); return {success: true}; },
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({results: db.prepare(sql).all(...args)}) });
    return {db, prepare: sql => stmt(sql)}; };
  const creq = (body, {origin = ORIGIN, path = "/collect", method = "POST", auth = ""} = {}) =>
    new Request("https://relay.example.workers.dev" + path, {method, headers: {"content-type": "text/plain;charset=utf-8",
      ...(origin ? {Origin: origin} : {}), ...(auth ? {Authorization: auth} : {})},
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined});
  const rows = env => env.DB.db.prepare("SELECT * FROM records ORDER BY id").all();
  const rec = (o = {}) => ({schema: 2, session: "0123456789abcdef", turn: 1, t: "2026-10-21T14:00Z", tab: "ask", kind: "question",
    question: "How much of Iowa is protected?", ai: true, refused: false, tokens_in: 10, ...o});
  let cenv = envOf({DB: d1(), EXPORT_TOKEN: "TEST-EXPORT-TOKEN"});
  x = await run(creq(rec()), cenv); ok(x.res.status === 204 && x.res.headers.get("access-control-allow-origin") === ORIGIN, "collect answers 204 with CORS");
  let r = rows(cenv); ok(r.length === 1 && r[0].question === "How much of Iowa is protected?" && r[0].ai === 1 && r[0].refused === 0 && r[0].exp === null && r[0].received, "record stored: " + JSON.stringify(r[0]));
  await run(creq(rec({exp: "agent_readers", round: "core", cell: "D-on", agent: "r07-A1-sonnet", turn: 2})), cenv);
  await run(creq(rec({round: "core"})), cenv);                                     // tag without exp: dropped
  await run(creq(rec({exp: "agent_readers", agent: "<script>", turn: 3})), cenv);  // bad tag value dropped
  r = rows(cenv);
  ok(r[1].exp === "agent_readers" && r[1].cell === "D-on" && r[1].agent === "r07-A1-sonnet", "experiment tags stored");
  ok(r[2].round === null, "tags ignored without exp");
  ok(r[3].exp === "agent_readers" && r[3].agent === null, "bad tag value dropped");
  const n0 = rows(cenv).length;
  for (const bad of ["not json", JSON.stringify({...rec(), schema: 1}), JSON.stringify({...rec(), session: "XYZ"}), JSON.stringify({...rec(), tab: "other"}), "x".repeat(9000)])
    await run(creq(bad), cenv);
  ok(rows(cenv).length === n0, "junk dropped: bad JSON, schema, session, tab, size");
  await run(creq(rec(), {origin: "https://evil.example"}), cenv); ok(rows(cenv).length === n0, "other origin not stored");
  await run(creq(rec(), {origin: ""}), cenv); ok(rows(cenv).length === n0, "no origin not stored");
  await run(creq(rec()), {...cenv, COLLECT_ON: "false"}); ok(rows(cenv).length === n0, "COLLECT_ON false stops storing");
  x = await run(creq(rec()), envOf()); ok(x.res.status === 204, "no DB: still 204, nothing breaks");
  await run(creq(rec({question: "q".repeat(2000), evil: {a: 1}, received: "1999", turn: 9})), cenv);
  r = rows(cenv).pop(); ok(r.question.length === 600 && JSON.parse(r.extra).evil === '{"a":1}' && r.received !== "1999", "strings capped, unknown fields to extra, received set by the server");
  // per-session cap
  const cap = envOf({DB: d1()});
  for (let i = 0; i < 205; i++) await run(creq(rec({turn: i})), cap);
  ok(rows(cap).length === 200, "at most 200 records per session per six hours, got " + rows(cap).length);
  // the AI relay is unaffected by the collection route
  upstream = []; reply = () => new Response(JSON.stringify({content: [], usage: {input_tokens: 1, output_tokens: 1}}), {status: 200});
  x = await run(req(good), cenv); ok(x.res.status === 200 && upstream.length === 1, "relay still answers with DB bound");
  // export
  x = await run(creq(null, {path: "/export", method: "GET"}), cenv); ok(x.res.status === 404, "export without token: 404");
  x = await run(creq(null, {path: "/export", method: "GET", auth: "Bearer wrong-token-xxxxxx"}), cenv); ok(x.res.status === 404, "export with a wrong token: 404");
  x = await run(creq(null, {path: "/export", method: "GET", auth: "Bearer TEST-EXPORT-TOKEN"}), envOf({DB: cenv.DB})); ok(x.res.status === 404, "export with no token configured: 404");
  x = await run(creq(null, {path: "/export?table=records", method: "GET", auth: "Bearer TEST-EXPORT-TOKEN"}), cenv);
  const lines = x.t.trim().split("\r\n");
  ok(x.res.status === 200 && /text\/csv/.test(x.res.headers.get("content-type")) && lines[0].startsWith("received,schema,session") && !lines[0].includes("exp,"), "records CSV, no tag columns: " + lines[0].slice(0, 60));
  ok(lines.length - 1 === rows(cenv).filter(z => z.exp === null).length, "records CSV holds real readers only");
  x = await run(creq(null, {path: "/export?table=experiments", method: "GET", auth: "Bearer TEST-EXPORT-TOKEN"}), cenv);
  const el = x.t.trim().split("\r\n"); ok(el[0].startsWith("received,exp,round,cell,agent") && el.length - 1 === 2, "experiments CSV holds tagged visits: " + el.length);
  await run(creq(rec({question: "=HYPERLINK(1)", turn: 50})), cenv);
  x = await run(creq(null, {path: "/export", method: "GET", auth: "Bearer TEST-EXPORT-TOKEN"}), cenv); ok(x.t.includes("'=HYPERLINK(1)"), "formula-like cells exported as text");
  x = await run(creq(null, {path: "/export?table=evil", method: "GET", auth: "Bearer TEST-EXPORT-TOKEN"}), cenv); ok(x.res.status === 400, "bad table refused");
  x = await run(creq(null, {path: "/export?since=2026-01-01", method: "GET", auth: "Bearer TEST-EXPORT-TOKEN"}), cenv); ok(x.res.status === 200, "since accepted");
  ok(!x.t.includes("TEST-EXPORT-TOKEN"), "token never echoed");
  collectNote = "collection: stored with tags, junk and other origins dropped, kill switch, no DB is harmless, strings capped, per-session cap, relay unaffected, export only with the token, CSV split into records and experiments, formula cells guarded";
}

if (fails.length) { console.error("test_worker: FAILED\n  " + fails.join("\n  ")); process.exit(1); }
console.log("test_worker: ok — origin check and CORS, kill switch, fails closed without key or KV, visit id, size cap, model forced, answer capped, fields dropped, key never echoed, spend counted, daily and monthly limits pause before any upstream call, per-visit limit, upstream errors passed through; " + collectNote + ".");
