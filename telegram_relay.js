// Telegram relay — chhota Render service. HF Space (app.py) yahan POST karta hai,
// ye aage Telegram Bot API ko forward karta hai. Koi npm dependency nahi (Node 20+).
//
// ENV (Render → Environment):
//   TELEGRAM_BOT_TOKEN  BotFather wala token
//   TELEGRAM_CHAT_ID    userinfobot wala chat id
//   RELAY_SECRET        koi lamba random password (min 16 chars); app.py me bhi wahi
//   HF_PLAN_URL         HF Space ka URL, jaise https://krishan162627-trade.hf.space — "today plan" aur baaki commands (/api/cmd) ke liye
//   HF_ACCESS_TOKEN     (optional) sirf Space private ho to
//   PORT                Render khud set karta hai
//   RENDER_EXTERNAL_URL Render khud set karta hai (webhook apne aap isi se register hota hai)
//
// Endpoints:
//   GET  /health        -> 200 "ok"
//   POST /send          header X-Relay-Secret, body {"text": "...", "reply_markup": {inline_keyboard}?}  -> {"ok":true}  (4000+ char ho to apne aap tukdon me)
//   POST /senddoc       header X-Relay-Secret, body {"filename":"x.zip","b64":"...","caption":"..."} -> file Telegram par (backup ke liye, max ~12 MB)
//   GET/POST /api/routine_resp   (v1.2) raat ki email wala ✅/❌ jawab-page HF se laakar dikhata hai (private Space ka gate relay paar karta hai,
//                       HF_ACCESS_TOKEN se). Email ka link ab Render ka hota hai: HF Space me ROUTINE_BASE_URL = https://<service>.onrender.com
//   POST /tg            Telegram webhook (header secret se verify). Sirf TELEGRAM_CHAT_ID ka message sunta hai.
//                       MYENGINE-STEP-10A (2026-10-03): har message ka text + update_id HF ke POST /api/cmd par jaata hai
//                       (header X-Relay-Secret); HF jo jawab text deta hai wahi Telegram par wapas jaata hai. Parsing sab HF (app.py) me —
//                       relay patla hai. "today plan" bhi isi raste se (HF /api/cmd), purana /api/plan_now sirf fallback ke liye bacha hai.

const http = require("node:http");
const crypto = require("node:crypto");

const env = (k) => (process.env[k] || "").trim();
const PORT = Number(env("PORT")) || 10000;
const TOKEN = env("TELEGRAM_BOT_TOKEN");
const CHAT = env("TELEGRAM_CHAT_ID");
const SECRET = env("RELAY_SECRET");
const HF_URL = env("HF_PLAN_URL").replace(/\/+$/, "");
const HF_ACCESS = env("HF_ACCESS_TOKEN");
const PUBLIC_URL = env("RENDER_EXTERNAL_URL").replace(/\/+$/, "");
// Telegram webhook ka secret header — RELAY_SECRET se bana hua (alag se kuch set nahi karna)
const HOOK_SECRET = crypto.createHash("sha256").update("tg-hook:" + SECRET).digest("hex").slice(0, 48);
const MAX_BODY = 16 * 1024;
const MAX_DOC_BODY = 16 * 1024 * 1024;   // /senddoc (base64 zip)
const MAX_TEXT = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────── Render log — is service (telegram-aib3) ka APNA ALAG log ─────────
// replay-qda7 (main.ts) ka log "log" store me jaata hai; ye service "log_telegram" store me (HF: render_log_telegram.jsonl). Dono mix nahi hote.
// Row format main.ts jaisa hi (kind: summary|fail|event|order, hop, src, endpoint, calls, fails, avg_ms, max_ms, status, msg, extra) + service:"telegram".
// hop: "render>telegram" (Telegram API call) | "render>hf" (HF /api/cmd call) | "hf>render" (HF ne is relay ko call kiya: /send, /senddoc) | "render" (boot/shutdown).
// Poori guide: RENDER_LOG_GUIDE.md
// ENV (optional): HF_STORE_TOKEN = app.py wale RENDER_STORE_TOKEN jaisa; HF_STORE_URL (na ho to HF_PLAN_URL). Token na ho to log band (kuch nahi bigadta).
// Rows me message ka text / token / chat id KABHI nahi jaata — sirf type, status, ms.
const STORE_URL = (env("HF_STORE_URL") || HF_URL).replace(/\/+$/, "");
const STORE_TOKEN = env("HF_STORE_TOKEN");
const STORE_ON = !!(STORE_URL && STORE_TOKEN);
const STARTED = Date.now();
const rlogAgg = new Map();
let rlogRows = [];
let rlogPending = [];
let rlogBusy = false;
const minuteIso = () => { const d = new Date(); d.setSeconds(0, 0); return d.toISOString(); };
function rlogCall(hop, src, endpoint, ms, ok, status, err) {
  try {
    const m = minuteIso();
    const k = `s|${m}|${hop}|${src}`;
    let a = rlogAgg.get(k);
    if (!a) { a = { ts: m, kind: "summary", hop, src, endpoint: null, calls: 0, fails: 0, ms_sum: 0, ms_max: 0, status: null, msg: null }; rlogAgg.set(k, a); }
    a.calls++; a.ms_sum += ms; if (ms > a.ms_max) a.ms_max = ms;
    if (!ok) {
      a.fails++;
      const em = String(err == null ? "" : err).split(TOKEN || "\u0000").join("***").slice(0, 200);
      const fk = `f|${m}|${hop}|${src}|${endpoint}|${status}|${em.slice(0, 80)}`;
      let f = rlogAgg.get(fk);
      if (!f) { f = { ts: m, kind: "fail", hop, src, endpoint, calls: 0, fails: 0, ms_sum: 0, ms_max: 0, status, msg: em }; rlogAgg.set(fk, f); }
      f.calls++; f.fails++; f.ms_sum += ms; if (ms > f.ms_max) f.ms_max = ms;
    }
    if (rlogAgg.size > 4000) { const first = rlogAgg.keys().next().value; if (first !== undefined) rlogAgg.delete(first); }
  } catch { /* log kabhi kaam nahi bigadta */ }
}
function rlogRow(kind, hop, src, endpoint, ok, msg, extra = null) {
  try {
    rlogRows.push({ ts: new Date().toISOString(), kind, hop, src, endpoint, calls: 1, fails: ok ? 0 : 1, avg_ms: null, max_ms: null, status: null, msg: String(msg).slice(0, 300), extra });
    if (rlogRows.length > 2000) rlogRows.splice(0, rlogRows.length - 2000);
  } catch { /* ignore */ }
}
function rlogFinalize(all) {
  const rows = [];
  const cur = minuteIso();
  for (const [k, a] of rlogAgg) {
    if (!all && a.ts >= cur) continue;
    rows.push({ service: "telegram", ts: a.ts, kind: a.kind, hop: a.hop, src: a.src, endpoint: a.endpoint, calls: a.calls, fails: a.fails,
      avg_ms: a.calls ? Math.round(a.ms_sum / a.calls) : null, max_ms: Math.round(a.ms_max), status: a.status, msg: a.msg, extra: null });
    rlogAgg.delete(k);
  }
  for (const r of rlogRows.splice(0)) rows.push({ service: "telegram", ...r });
  return rows;
}
async function rlogFlush(reason) {
  const fresh = rlogFinalize(reason === "shutdown");
  if (fresh.length) rlogPending.push(...fresh);
  if (!STORE_ON) { rlogPending = []; return; }
  if (!rlogPending.length || rlogBusy) return;
  rlogBusy = true;
  try {
    const headers = { "x-store-token": STORE_TOKEN, "content-type": "application/json" };
    if (HF_ACCESS) headers.authorization = `Bearer ${HF_ACCESS}`;
    while (rlogPending.length) {
      const batch = rlogPending.slice(0, 500);
      const bid = crypto.createHash("sha1").update(JSON.stringify(batch)).digest("hex").slice(0, 20);
      const r = await fetch(`${STORE_URL}/api/render_store/log_telegram`, { method: "POST", headers, body: JSON.stringify({ batch_id: bid, rows: batch }), signal: AbortSignal.timeout(reason === "shutdown" ? 4000 : 12000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok === false) { console.error(new Date().toISOString(), "render_log store fail:", r.status); break; }
      rlogPending.splice(0, batch.length);
    }
  } catch (e) {
    console.error(new Date().toISOString(), "render_log store error:", e instanceof Error ? e.name : "error");
  } finally {
    rlogBusy = false;
    if (rlogPending.length > 5000) rlogPending.splice(0, rlogPending.length - 5000);
  }
}

if (!TOKEN || !CHAT || SECRET.length < 16) {
  console.error("TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID aur RELAY_SECRET (min 16 chars) set karo.");
  process.exit(1);
}

const secretOk = (given) => {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(SECRET).digest();
  return crypto.timingSafeEqual(a, b);
};

const reply = (res, code, obj) => {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "content-type": typeof obj === "string" ? "text/plain" : "application/json" });
  res.end(body);
};

const readBody = (req, max = MAX_BODY) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// Telegram API call: 429 / 5xx / network error par 3 baar tak retry (retry_after ka dhyan rakhta hai).
// makeBody() har try par naya body deta hai (FormData dobara use nahi hota).
async function tgCallInner(method, makeBody, tries = 3) {
  let last = { ok: false, status: 0, msg: "telegram error" };
  for (let a = 0; a < tries; a++) {
    try {
      const b = makeBody();
      const init = { method: "POST", signal: AbortSignal.timeout(25000) };
      if (b instanceof FormData) init.body = b;
      else {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(b);
      }
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, init);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) return { ok: true, result: j.result };
      last = { ok: false, status: r.status, msg: String(j.description || "telegram error").slice(0, 200) };
      if (r.status === 429 || r.status >= 500) {
        const wait = Math.min(10, Number(j.parameters && j.parameters.retry_after) || 1 + a);
        await sleep(wait * 1000);
        continue;
      }
      return last;
    } catch (e) {
      last = { ok: false, status: 0, msg: e instanceof Error ? e.name : "error" };
      await sleep(1000 * (a + 1));
    }
  }
  return last;
}

async function tgCall(method, makeBody, tries = 3) {
  const t0 = Date.now();
  const out = await tgCallInner(method, makeBody, tries);
  rlogCall("render>telegram", method, "/" + method, Date.now() - t0, !!out.ok, out.status || null, out.ok ? null : out.msg);
  return out;
}

// lamba text newline par tukdon me (har tukda <= MAX_TEXT)
function splitText(text) {
  const out = [];
  let rest = String(text);
  while (rest.length > MAX_TEXT) {
    let cut = rest.lastIndexOf("\n", MAX_TEXT);
    if (cut < MAX_TEXT / 2) cut = MAX_TEXT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) out.push(rest);
  return out.slice(0, 5);   // max 5 tukde
}

// inline keyboard sahi shape ka hai? ({inline_keyboard:[[{text, callback_data}]]}, <=100 buttons, callback_data <=64 bytes)
function validMarkup(m) {
  if (!m || typeof m !== "object" || !Array.isArray(m.inline_keyboard)) return false;
  let n = 0;
  for (const row of m.inline_keyboard) {
    if (!Array.isArray(row) || !row.length) return false;
    for (const b of row) {
      n++;
      if (!b || typeof b.text !== "string" || !b.text) return false;
      if (typeof b.callback_data !== "string" || Buffer.byteLength(b.callback_data) > 64) return false;
    }
  }
  return n > 0 && n <= 100;
}

async function sendTelegram(text, markup) {
  const parts = splitText(text);
  let out = { ok: true };
  for (let i = 0; i < parts.length; i++) {
    const body = { chat_id: CHAT, text: parts[i] };
    if (markup && i === parts.length - 1) body.reply_markup = markup;
    out = await tgCall("sendMessage", () => body);
    if (!out.ok) break;
  }
  return out.ok ? { ok: true } : { ok: false, status: out.status, msg: out.msg };
}

async function sendDocument(filename, buf, caption) {
  const out = await tgCall("sendDocument", () => {
    const f = new FormData();
    f.append("chat_id", CHAT);
    if (caption) f.append("caption", String(caption).slice(0, 1000));
    f.append("document", new Blob([buf], { type: "application/zip" }), filename);
    return f;
  });
  return out.ok ? { ok: true } : { ok: false, status: out.status, msg: out.msg };
}

const hashEq = (x, y) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(String(x || "")).digest(),
    crypto.createHash("sha256").update(String(y || "")).digest(),
  );

// MYENGINE-STEP-10A (2026-10-03): purana dheela match ("plan" shabd kahin bhi — "todo add plan banana" bhi plan bhej deta tha) ab
// SIRF fallback hai (jab HF me /api/cmd abhi deploy nahi hua, 404) aur ab sirf poore exact phrases par ("plan", "today plan", "aaj ka plan", "/plan").
// Asli parsing HF me hoti hai: pehle exact commands, "plan" sabse aakhir me, chhote message par.
const PLAN_PHRASES = new Set(["plan", "today plan", "aaj ka plan", "today's plan", "todays plan"]);
const isPlanFallback = (t) => PLAN_PHRASES.has(t.toLowerCase().replace(/^\//, "").replace(/@\w+$/, "").replace(/\s+/g, " ").trim());

async function sendPlan() {
  if (!HF_URL) return sendTelegram("⚠️ HF_PLAN_URL set nahi hai (relay ke Environment me daalo).");
  try {
    const headers = { "X-Relay-Secret": SECRET, "content-type": "application/json" };
    if (HF_ACCESS) headers.authorization = `Bearer ${HF_ACCESS}`;
    const r = await fetch(`${HF_URL}/api/plan_now`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(70000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok && typeof j.text === "string" && j.text) return sendTelegram(j.text);
    return sendTelegram(`⚠️ Plan nahi mila (HF ${r.status}${j.msg ? ": " + j.msg : ""}).`);
  } catch (e) {
    return sendTelegram(`⚠️ Plan nahi mila: ${e instanceof Error ? e.name : "error"}`);
  }
}

// HF ke /api/cmd ko text do. -> {ok, text, dup, status, msg}. 404 (purana HF) par fallback sirf "plan" ke liye (sendCmd me).
async function callHFInner(text, updateId) {
  const headers = { "X-Relay-Secret": SECRET, "content-type": "application/json" };
  if (HF_ACCESS) headers.authorization = `Bearer ${HF_ACCESS}`;
  try {
    const r = await fetch(`${HF_URL}/api/cmd`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: text.slice(0, 3000), update_id: updateId }),
      signal: AbortSignal.timeout(70000),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok === true, text: typeof j.text === "string" ? j.text : "", dup: !!j.dup, status: r.status, msg: j.msg ? String(j.msg) : "" };
  } catch (e) {
    return { ok: false, text: "", dup: false, status: 0, msg: e instanceof Error ? e.name : "error" };
  }
}

async function callHF(text, updateId) {
  const t0 = Date.now();
  const r = await callHFInner(text, updateId);
  rlogCall("render>hf", "cmd", "/api/cmd", Date.now() - t0, !!r.ok, r.status || null, r.ok ? null : (r.msg || "hf cmd fail"));
  return r;
}

// MYENGINE-STEP-10A (2026-10-03): message HF ke /api/cmd ko do, jawab Telegram par bhejo.
// HF {ok, text, dup?}: dup ya khaali text = kuch mat bhejo. 404 (purana HF) par sirf chhota "plan" message fallback se chalega.
async function sendCmd(text, updateId) {
  if (!HF_URL) return sendTelegram("⚠️ HF_PLAN_URL set nahi hai (relay ke Environment me daalo).");
  const r = await callHF(text, updateId);
  if (r.status === 404 && isPlanFallback(text)) return sendPlan();   // HF abhi purana hai
  if (r.ok) {
    if (r.dup || !r.text.trim()) return { ok: true };
    return sendTelegram(r.text);
  }
  if (r.status === 0) return sendTelegram(`⚠️ Command nahi chala: ${r.msg}`);
  return sendTelegram(`⚠️ Command nahi chala (HF ${r.status}${r.msg ? ": " + r.msg : ""}).`);
}

// ✅/❌ inline button dabana: HF ko "/cb k|id|date|s" bhejo, jawab chhote toast me, us item ki row keyboard se hata do.
// Button ek ke baad ek (queue) chalte hain, taaki keyboard edit aapas me na takraayein.
const kbState = new Map();   // message_id -> abhi ki keyboard rows
let cbChain = Promise.resolve();

async function handleCallback(u) {
  const cq = u.callback_query;
  const msg = cq.message;
  if (!msg || !msg.chat || String(msg.chat.id) !== CHAT) {
    await tgCall("answerCallbackQuery", () => ({ callback_query_id: cq.id }));
    return;
  }
  const data = String(cq.data || "").slice(0, 64);
  if (!HF_URL) {
    await tgCall("answerCallbackQuery", () => ({ callback_query_id: cq.id, text: "HF_PLAN_URL set nahi" }));
    return;
  }
  const r = await callHF("/cb " + data, u.update_id);
  let toast = "";
  if (r.ok) toast = r.dup ? "" : r.text.split("\n")[0];
  else toast = `⚠️ HF ${r.status || r.msg || "error"}`;
  await tgCall("answerCallbackQuery", () => ({ callback_query_id: cq.id, text: toast.slice(0, 190) }), 1);
  // 💵 Money Manager (2026-10-04): category / sub chun liya ya cancel dabaya -> poora keyboard hata do (message waise hi rehta hai)
  if (r.ok && !r.dup && /^(💵|❎)/.test(r.text)) {
    kbState.delete(msg.message_id);
    await tgCall("editMessageReplyMarkup", () => ({ chat_id: CHAT, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }), 1);
    return;
  }
  if (!(r.ok && !r.dup && /^(✅|❌|⏸)/.test(r.text))) return;   // error / duplicate: keyboard waise hi rehne do
  const key = data.split("|").slice(0, 3).join("|") + "|";
  const cur = kbState.get(msg.message_id) || (msg.reply_markup && msg.reply_markup.inline_keyboard) || [];
  const rows = cur.filter((row) => !row.some((b) => String(b.callback_data || "").startsWith(key)));
  if (rows.length === cur.length) return;
  if (!rows.length) {
    kbState.delete(msg.message_id);
    await tgCall("editMessageText", () => ({ chat_id: CHAT, message_id: msg.message_id, text: "✅ Raat ka hisaab complete — sab kaam mark ho gaye." }));
  } else {
    kbState.set(msg.message_id, rows);
    while (kbState.size > 50) kbState.delete(kbState.keys().next().value);
    await tgCall("editMessageReplyMarkup", () => ({ chat_id: CHAT, message_id: msg.message_id, reply_markup: { inline_keyboard: rows } }));
  }
}

// ── (v1.2) Routine jawab-page proxy ────────────────────────────────────────
// Email ka link Render ka hota hai (ROUTINE_BASE_URL). Browser ke paas HF ka login nahi hota, isliye private Space 404 deta tha.
// Ab browser -> Render -> (HF_ACCESS_TOKEN ke saath) HF. SIRF /api/routine_resp, GET (page) + POST (submit). Page ka JS
// location.pathname par POST karta hai, isliye wahi path yahan bhi chalta hai. Token (HMAC) ki jaanch HF karta hai, relay nahi.
const ROUTINE_PATH = "/api/routine_resp";
const MAX_ROUTINE_BODY = 256 * 1024;
const routineErrPage = (msg) =>
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<body style="font:16px sans-serif;padding:24px;background:#131722;color:#d1d4dc">⚠️ ' + msg + "</body>";

async function proxyRoutine(req, res) {
  const isPost = req.method === "POST";
  const fail = (code, msg) =>
    isPost ? reply(res, code, { ok: false, msg }) : (res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }), res.end(routineErrPage(msg)));
  if (!HF_URL) return fail(503, "HF_PLAN_URL set nahi hai (relay ke Environment me daalo).");
  const headers = {};
  if (HF_ACCESS) headers.authorization = `Bearer ${HF_ACCESS}`;
  let url = `${HF_URL}${ROUTINE_PATH}`;
  let body;
  if (isPost) {
    try {
      body = await readBody(req, MAX_ROUTINE_BODY);
    } catch {
      return fail(413, "body bahut bada");
    }
    headers["content-type"] = "application/json";
  } else {
    // sirf d aur tok aage jaate hain (baaki query ignore)
    const sp = new URL(req.url, "http://x").searchParams;
    const q = new URLSearchParams();
    for (const k of ["d", "tok"]) if (sp.has(k)) q.set(k, String(sp.get(k)).slice(0, 200));
    url += "?" + q.toString();
  }
  try {
    const r = await fetch(url, { method: isPost ? "POST" : "GET", headers, body, signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, {
      "content-type": r.headers.get("content-type") || (isPost ? "application/json" : "text/html; charset=utf-8"),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-length": buf.length,
    });
    res.end(buf);
  } catch (e) {
    console.error(new Date().toISOString(), "routine proxy error:", e instanceof Error ? e.name : "error");
    return fail(502, "HF Space tak nahi pahunch paaya. Thodi der baad dobara link kholo.");
  }
}

let lastUpdateId = 0;
async function handleUpdate(u) {
  if (!u || typeof u.update_id !== "number" || u.update_id <= lastUpdateId) return;   // Telegram retry se double na ho
  lastUpdateId = u.update_id;
  if (u.callback_query) {
    cbChain = cbChain.then(() => handleCallback(u)).catch((e) => console.error(new Date().toISOString(), "callback error:", (e instanceof Error ? e.message : String(e)).split(TOKEN).join("***")));
    return cbChain;
  }
  const m = u.message;
  if (!m || typeof m.text !== "string" || String(m.chat && m.chat.id) !== CHAT) return;  // sirf aapka chat
  await sendCmd(m.text, u.update_id);
}

async function registerWebhook() {
  if (!PUBLIC_URL) return console.log(new Date().toISOString(), "RENDER_EXTERNAL_URL nahi — webhook register nahi kiya");
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${PUBLIC_URL}/tg`, secret_token: HOOK_SECRET, allowed_updates: ["message", "callback_query"] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    console.log(new Date().toISOString(), "setWebhook:", r.status, j.ok ? "ok" : String(j.description || "fail"));
  } catch (e) {
    console.error(new Date().toISOString(), "setWebhook error:", (e instanceof Error ? e.message : String(e)).split(TOKEN).join("***"));
  }
}

// Telegram ke "/" menu me commands (bot ke input ke paas). Description 3-256 chars.
async function registerCommands() {
  const commands = [
    ["plan", "Aaj ka plan"], ["tick", "Pending kaam ki ✅/❌ checklist"], ["todo", "Open To-Do list"], ["habit", "Aaj ke habits + streak"], ["routine", "Aaj ka routine"],
    ["dip", "Dipanshu ke habits"], ["practice", "Practice sets"], ["rough", "Rough list"], ["info", "Info entries"],
    ["travel", "Trips"], ["balance", "Accounts balance"], ["find", "Dhoondho: find <shabd>"], ["status", "Server ki halat"], ["backup", "Abhi backup bhejo"], ["kharcha", "Kharcha jodo: kharcha 250 food/chai"], ["aay", "Income jodo: aay 5000 salary"], ["mm", "Money Manager: aaj ki entries"], ["undo", "Aakhri change wapas"], ["help", "Saare commands"],
  ].map(([command, description]) => ({ command, description }));
  const out = await tgCall("setMyCommands", () => ({ commands }));
  console.log(new Date().toISOString(), "setMyCommands:", out.ok ? "ok" : out.msg);
}

const server = http.createServer(async (req, res) => {
  try {
    const path = (req.url || "/").split("?")[0];
    if ((req.method === "GET" || req.method === "HEAD") && (path === "/health" || path === "/")) return reply(res, 200, "ok");
    if ((req.method === "GET" || req.method === "POST") && path === ROUTINE_PATH) return proxyRoutine(req, res);
    if (req.method === "POST" && path === "/send") {
      if (!secretOk(req.headers["x-relay-secret"])) { rlogRow("event", "hf>render", "send", "/send", false, "401 unauthorized (galat X-Relay-Secret)"); return reply(res, 401, { ok: false, msg: "unauthorized" }); }
      let data;
      try {
        data = JSON.parse(await readBody(req));
      } catch {
        return reply(res, 400, { ok: false, msg: "bad json" });
      }
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (!text) return reply(res, 400, { ok: false, msg: "text khaali hai" });
      const markup = data && data.reply_markup;
      if (markup !== undefined && !validMarkup(markup)) return reply(res, 400, { ok: false, msg: "reply_markup galat" });
      const out = await sendTelegram(text, markup);
      if (!out.ok) rlogRow("event", "hf>render", "send", "/send", false, "502 telegram send fail: " + String(out.msg || "").slice(0, 150));
      return reply(res, out.ok ? 200 : 502, out);
    }
    if (req.method === "POST" && path === "/senddoc") {
      if (!secretOk(req.headers["x-relay-secret"])) return reply(res, 401, { ok: false, msg: "unauthorized" });
      let data;
      try {
        data = JSON.parse(await readBody(req, MAX_DOC_BODY));
      } catch {
        return reply(res, 400, { ok: false, msg: "bad json / bahut bada" });
      }
      const fname = typeof data?.filename === "string" ? data.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) : "";
      if (!fname || typeof data?.b64 !== "string" || !data.b64) return reply(res, 400, { ok: false, msg: "filename / b64 chahiye" });
      const buf = Buffer.from(data.b64, "base64");
      if (!buf.length) return reply(res, 400, { ok: false, msg: "file khaali hai" });
      const out = await sendDocument(fname, buf, typeof data.caption === "string" ? data.caption : "");
      if (!out.ok) rlogRow("event", "hf>render", "senddoc", "/senddoc", false, "502 backup bhejna fail: " + String(out.msg || "").slice(0, 150));
      return reply(res, out.ok ? 200 : 502, out);
    }
    if (req.method === "POST" && path === "/tg") {
      if (!hashEq(req.headers["x-telegram-bot-api-secret-token"], HOOK_SECRET)) return reply(res, 401, { ok: false, msg: "unauthorized" });
      let u;
      try {
        u = JSON.parse(await readBody(req));
      } catch {
        return reply(res, 400, { ok: false, msg: "bad json" });
      }
      reply(res, 200, { ok: true });   // Telegram ko turant 200, kaam peeche chalta hai
      handleUpdate(u).catch((e) => console.error(new Date().toISOString(), "update error:", (e instanceof Error ? e.message : String(e)).split(TOKEN).join("***")));
      return;
    }
    return reply(res, 404, { ok: false, msg: "not found" });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split(TOKEN).join("***");
    console.error(new Date().toISOString(), "error:", msg);
    return reply(res, 500, { ok: false, msg: "server error" });
  }
});

server.listen(PORT, () => {
  console.log(new Date().toISOString(), "telegram-relay listening on", PORT);
  registerWebhook();
  registerCommands();
  rlogRow("event", "render", "boot", null, true, `Telegram relay start | store=${STORE_ON ? "on" : "off"}`);
  if (!STORE_ON) console.log(new Date().toISOString(), "render_log: HF_STORE_TOKEN set nahi — log band");
  setInterval(() => { rlogFlush("tick"); }, 60000);
  setTimeout(() => { rlogFlush("tick"); }, 5000);
});

let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rlogRow("event", "render", "shutdown", null, true, `Telegram relay band ho raha hai (${sig}) | uptime ${Math.round((Date.now() - STARTED) / 1000)}s`);
    try { await rlogFlush("shutdown"); } catch { /* ignore */ }
    process.exit(0);
  });
}
