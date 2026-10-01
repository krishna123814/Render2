// Telegram relay — chhota Render service. HF Space (app.py) yahan POST karta hai,
// ye aage Telegram Bot API ko forward karta hai. Koi npm dependency nahi (Node 20+).
//
// ENV (Render → Environment):
//   TELEGRAM_BOT_TOKEN  BotFather wala token
//   TELEGRAM_CHAT_ID    userinfobot wala chat id
//   RELAY_SECRET        koi lamba random password (min 16 chars); app.py me bhi wahi
//   PORT                Render khud set karta hai
//
// Endpoints:
//   GET  /health        -> 200 "ok"
//   POST /send          header X-Relay-Secret, body {"text": "..."}  -> {"ok":true}

const http = require("node:http");
const crypto = require("node:crypto");

const env = (k) => (process.env[k] || "").trim();
const PORT = Number(env("PORT")) || 10000;
const TOKEN = env("TELEGRAM_BOT_TOKEN");
const CHAT = env("TELEGRAM_CHAT_ID");
const SECRET = env("RELAY_SECRET");
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
    return reply(res, 404, { ok: false, msg: "not found" });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split(TOKEN).join("***");
    console.error(new Date().toISOString(), "error:", msg);
    return reply(res, 500, { ok: false, msg: "server error" });
  }
});

server.listen(PORT, () => console.log(new Date().toISOString(), "telegram-relay listening on", PORT));
