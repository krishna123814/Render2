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
//   POST /send          header X-Relay-Secret, body {"text": "..."}  -> {"ok":true}
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
const MAX_TEXT = 4000;

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

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, MAX_TEXT) }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.ok) return { ok: true };
  return { ok: false, status: r.status, msg: String(j.description || "telegram error").slice(0, 200) };
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

// MYENGINE-STEP-10A (2026-10-03): message HF ke /api/cmd ko do, jawab Telegram par bhejo.
// HF {ok, text, dup?}: dup ya khaali text = kuch mat bhejo. 404 (purana HF) par sirf chhota "plan" message fallback se chalega.
async function sendCmd(text, updateId) {
  if (!HF_URL) return sendTelegram("⚠️ HF_PLAN_URL set nahi hai (relay ke Environment me daalo).");
  try {
    const headers = { "X-Relay-Secret": SECRET, "content-type": "application/json" };
    if (HF_ACCESS) headers.authorization = `Bearer ${HF_ACCESS}`;
    const r = await fetch(`${HF_URL}/api/cmd`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: text.slice(0, 1000), update_id: updateId }),
      signal: AbortSignal.timeout(70000),
    });
    if (r.status === 404 && isPlanFallback(text)) return sendPlan();   // HF abhi purana hai
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      if (j.dup || typeof j.text !== "string" || !j.text.trim()) return { ok: true };
      return sendTelegram(j.text);
    }
    return sendTelegram(`⚠️ Command nahi chala (HF ${r.status}${j.msg ? ": " + j.msg : ""}).`);
  } catch (e) {
    return sendTelegram(`⚠️ Command nahi chala: ${e instanceof Error ? e.name : "error"}`);
  }
}

let lastUpdateId = 0;
async function handleUpdate(u) {
  if (!u || typeof u.update_id !== "number" || u.update_id <= lastUpdateId) return;   // Telegram retry se double na ho
  lastUpdateId = u.update_id;
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
      body: JSON.stringify({ url: `${PUBLIC_URL}/tg`, secret_token: HOOK_SECRET, allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    console.log(new Date().toISOString(), "setWebhook:", r.status, j.ok ? "ok" : String(j.description || "fail"));
  } catch (e) {
    console.error(new Date().toISOString(), "setWebhook error:", (e instanceof Error ? e.message : String(e)).split(TOKEN).join("***"));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const path = (req.url || "/").split("?")[0];
    if ((req.method === "GET" || req.method === "HEAD") && (path === "/health" || path === "/")) return reply(res, 200, "ok");
    if (req.method === "POST" && path === "/send") {
      if (!secretOk(req.headers["x-relay-secret"])) return reply(res, 401, { ok: false, msg: "unauthorized" });
      let data;
      try {
        data = JSON.parse(await readBody(req));
      } catch {
        return reply(res, 400, { ok: false, msg: "bad json" });
      }
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (!text) return reply(res, 400, { ok: false, msg: "text khaali hai" });
      const out = await sendTelegram(text);
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
});
