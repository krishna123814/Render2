// render.ts — WEBSOCKET-ONLY Binance proxy (alag Render account/IP par deploy)
//
// PURPOSE: Isme Binance ko koi REST call BILKUL NAHI jaati — sirf 3 Binance
// WebSocket streams (option mark-price, option trade, spot aggTrade) sunta
// hai aur unse mila latest data memory mein rakhta hai. App /snapshot maang
// kar ye data leti hai (jaisa main.ts mein tha), lekin yahan REST-polling ka
// koi loop nahi hai — isliye is deployment ka Binance IP-ban se koi lena-dena
// nahi hoga (REST-forward, 24h-ticker poll, trade/order calls — in sabki
// wajah se ban laga tha, aur wo sab abhi bhi PURANE main.ts mein hi rahenge).
//
// ISME KYA NAHI HAI (jaanbujhkar):
//   - 24h ticker (OI / volume / change%) — Binance Options WS par ye data
//     aata hi nahi, isliye REST se poochna padta hai. Isliye is snapshot mein
//     oi/chg/chgp/volume fields hamesha null/absent rahenge. App ko ye fields
//     abhi bhi PURANE main.ts ke /snapshot (ya uske ticker data) se lene
//     honge — dono backends ka data app-side par merge karna hoga.
//   - REST-forward (/api/, /eapi/) — order book (depth), exchangeInfo, trade
//     history, positions, orders — sab kuch abhi bhi purane main.ts se.
//   - Trade/order placement, rules (SL/target/trailing) — purane main.ts se.
//
// Env vars (sab optional):
//   PORT           (Render khud deta hai)
//   IDLE_STOP_SEC  default 60 — itni der /snapshot na aaye to Binance WS band
//                  (taaki free instance idle rehte hue so sake)

// ── Config ────────────────────────────────────────────────────────────────
const PORT = Number(Deno.env.get("PORT") ?? 8000);
const IDLE_STOP_MS = Number(Deno.env.get("IDLE_STOP_SEC") ?? 60) * 1000;

const SYMBOL_PREFIX = "BTC-";          // sirf BTC options
const DEFAULT_STRIKES = 20;            // ATM ke dono taraf
const WARMUP_MS = 6000;                // cold start par pehla data aane tak max wait
const QUOTE_PRUNE_MS = 30 * 60 * 1000; // itni der se update nahi hua (expired contract) to hata do

const BN_WS = {
  mark: "wss://fstream.binance.com/market/stream?streams=btcusdt@optionMarkPrice",
  trade: "wss://fstream.binance.com/public/stream?streams=btcusdt@optionTrade",
  spot: "wss://stream.binance.com:9443/ws/btcusdt@aggTrade",
};

// ── Helpers ───────────────────────────────────────────────────────────────
const nowMs = () => Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function num(x: unknown): number {
  const n = typeof x === "number" ? x : parseFloat(String(x ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

// ── Quote store (WS se bharta hai) ──────────────────────────────────────────
interface Quote {
  mark?: string; bid?: string; ask?: string; last?: string;
  delta?: string; gamma?: string; theta?: string; vega?: string;
  iv?: string; buy_iv?: string; sell_iv?: string;
  vol_cum?: number;
  mark_ts?: number; last_ts?: number; ts: number;
}
type StrField =
  | "mark" | "bid" | "ask" | "last" | "delta" | "gamma"
  | "theta" | "vega" | "iv" | "buy_iv" | "sell_iv";

const quotes = new Map<string, Quote>();
const symInfo = new Map<string, { exp: string; strike: number }>();
const spot: { price: number | null; ts: number } = { price: null, ts: 0 };

function getQuote(sym: unknown): Quote | null {
  if (typeof sym !== "string" || !sym.startsWith(SYMBOL_PREFIX)) return null;
  let q = quotes.get(sym);
  if (!q) {
    const p = sym.split("-"); // BTC-YYMMDD-STRIKE-C|P
    const strike = Number(p[2]);
    if (p.length < 4 || !Number.isFinite(strike)) return null;
    q = { ts: nowMs() };
    quotes.set(sym, q);
    symInfo.set(sym, { exp: p[1], strike });
  }
  return q;
}

// Mark-stream keys → app.py ke row keys jaisa hi
const MARK_FIELD_MAP: Array<[StrField, string]> = [
  ["last", "c"], ["bid", "bo"], ["ask", "ao"], ["mark", "mp"],
  ["delta", "d"], ["gamma", "g"], ["theta", "t"], ["vega", "v"],
  ["iv", "vo"], ["buy_iv", "b"], ["sell_iv", "a"],
];

// deno-lint-ignore no-explicit-any
function unwrap(data: any): any[] {
  const payload = data && typeof data === "object" && "data" in data ? data.data : data;
  if (Array.isArray(payload)) return payload;
  return payload && typeof payload === "object" ? [payload] : [];
}

// deno-lint-ignore no-explicit-any
function applyMark(msg: any) {
  const q = getQuote(msg?.s);
  if (!q) return;
  const t = nowMs();
  for (const [target, key] of MARK_FIELD_MAP) {
    if (present(msg[key])) {
      q[target] = msg[key];
      if (target === "mark") q.mark_ts = t;
    }
  }
  q.ts = t;
}

// deno-lint-ignore no-explicit-any
function applyTrade(msg: any) {
  const q = getQuote(msg?.s);
  if (!q) return;
  const t = nowMs();
  if (present(msg.p)) {
    q.last = msg.p;
    q.last_ts = t;
  }
  if (present(msg.q)) q.vol_cum = (q.vol_cum ?? 0) + num(msg.q);
  q.ts = t;
}

// deno-lint-ignore no-explicit-any
function applySpot(msg: any) {
  const m = msg && typeof msg === "object" && msg.data ? msg.data : msg;
  const p = parseFloat(m?.p);
  if (Number.isFinite(p)) {
    spot.price = p;
    spot.ts = nowMs();
  }
}

// ── Upstream Binance WebSocket feed (auto-reconnect + backoff + watchdog) ──
// (main.ts wali Feed class jaisi hi — koi REST call nahi karti, sirf WS.)
class Feed {
  ws: WebSocket | null = null;
  connected = false;
  stopped = true;
  lastMsg = 0;
  msgCount = 0;
  failCount = 0;
  // deno-lint-ignore no-explicit-any
  retryTimer: any = null;
  // deno-lint-ignore no-explicit-any
  constructor(public name: string, public url: string, public onData: (d: any) => void, public staleMs: number) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.failCount = 0;
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    try { ws?.close(); } catch { /* ignore */ }
  }
  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.failCount = 0;
      this.lastMsg = nowMs();
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastMsg = nowMs();
      this.msgCount++;
      try {
        this.onData(JSON.parse(typeof e.data === "string" ? e.data : ""));
      } catch { /* bad frame ignore */ }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.scheduleRetry();
    };
  }
  private scheduleRetry() {
    if (this.stopped) return;
    this.failCount++;
    const delay = Math.min(1000 * 2 ** (this.failCount - 1), 30000) + Math.random() * 500;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
  watchdog() {
    if (this.stopped || !this.ws || this.staleMs <= 0) return;
    if (nowMs() - this.lastMsg > this.staleMs) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }
  status(t: number) {
    return { connected: this.connected, msg_count: this.msgCount, age_ms: this.lastMsg ? t - this.lastMsg : null };
  }
}

const feeds = {
  mark: new Feed("mark", BN_WS.mark, (d) => { for (const it of unwrap(d)) applyMark(it); }, 30_000),
  trade: new Feed("trade", BN_WS.trade, (d) => { for (const it of unwrap(d)) applyTrade(it); }, 0),
  spot: new Feed("spot", BN_WS.spot, applySpot, 30_000),
};
let feedsStopped = true;
let lastDemand = 0;

function ensureFeeds(): boolean {
  lastDemand = nowMs();
  const wasCold = feedsStopped;
  if (feedsStopped) {
    feedsStopped = false;
    for (const f of Object.values(feeds)) f.start();
  }
  return wasCold;
}

function stopFeedsAndClear() {
  for (const f of Object.values(feeds)) f.stop();
  feedsStopped = true;
  quotes.clear();
  symInfo.clear();
  spot.price = null;
  spot.ts = 0;
}

setInterval(() => {
  const t = nowMs();
  if (!feedsStopped && t - lastDemand > IDLE_STOP_MS) {
    stopFeedsAndClear();
    return;
  }
  if (!feedsStopped) {
    for (const f of Object.values(feeds)) f.watchdog();
    for (const [sym, q] of quotes) {
      if (t - q.ts > QUOTE_PRUNE_MS) {
        quotes.delete(sym);
        symInfo.delete(sym);
      }
    }
  }
}, 5000);

// Cold start: pehla mark tick + spot aane tak (max maxMs) ruko
async function warmup(maxMs: number) {
  const t0 = nowMs();
  while (nowMs() - t0 < maxMs) {
    if (feeds.mark.msgCount > 0 && spot.price !== null) return;
    await sleep(100);
  }
}

// ── Snapshot builder ──────────────────────────────────────────────────────
// SNAP_KEYS purane main.ts se jaanbujhkar chhota hai — oi/chg/chgp/volume
// (REST-only ticker fields) yahan nahi hain, kyunki ye WS-only proxy hai.
const SNAP_KEYS = [
  "mark", "bid", "ask", "last", "delta", "gamma", "theta", "vega",
  "iv", "buy_iv", "sell_iv", "vol_cum", "mark_age_ms", "last_age_ms",
] as const;

function rowFor(sym: string, q: Quote, t: number): unknown[] {
  const row: unknown[] = [sym];
  for (const k of SNAP_KEYS) {
    if (k === "mark_age_ms") row.push(q.mark_ts ? t - q.mark_ts : null);
    else if (k === "last_age_ms") row.push(q.last_ts ? t - q.last_ts : null);
    else row.push(q[k] ?? null);
  }
  return row;
}

function buildSnapshot(strikeWindow: number, maxExpiries: number) {
  const t = nowMs();
  const byExp = new Map<string, Map<number, string[]>>();
  for (const [sym, info] of symInfo) {
    if (!quotes.has(sym)) continue;
    let sm = byExp.get(info.exp);
    if (!sm) byExp.set(info.exp, (sm = new Map()));
    const arr = sm.get(info.strike);
    if (arr) arr.push(sym);
    else sm.set(info.strike, [sym]);
  }

  const rows: unknown[][] = [];
  const price = spot.price;
  if (price !== null) {
    let exps = [...byExp.keys()].sort();
    if (maxExpiries > 0) exps = exps.slice(0, maxExpiries);
    for (const exp of exps) {
      const sm = byExp.get(exp)!;
      const strikes = [...sm.keys()].sort((a, b) => a - b);
      let atmIdx = 0;
      let best = Infinity;
      strikes.forEach((s, i) => {
        const d = Math.abs(s - price);
        if (d < best) { best = d; atmIdx = i; }
      });
      const lo = Math.max(0, atmIdx - strikeWindow);
      const hi = Math.min(strikes.length, atmIdx + strikeWindow + 1);
      for (let i = lo; i < hi; i++) {
        for (const sym of sm.get(strikes[i])!) {
          const q = quotes.get(sym);
          if (q) rows.push(rowFor(sym, q, t));
        }
      }
    }
  }

  return {
    v: 1,
    now_ms: t,
    spot: price,
    spot_age_ms: spot.ts ? t - spot.ts : null,
    feeds: { mark: feeds.mark.status(t), trade: feeds.trade.status(t), spot: feeds.spot.status(t) },
    total_symbols: quotes.size,
    keys: SNAP_KEYS,
    rows,
    note: "WS-only snapshot — OI/volume/chg% yahan nahi hai, wo purane REST-proxy se lo",
  };
}

async function handleSnapshot(req: Request, url: URL): Promise<Response> {
  const sw = parseInt(url.searchParams.get("strikes") ?? "", 10);
  const strikeWindow = Number.isFinite(sw) && sw >= 0 ? Math.min(sw, 1000) : DEFAULT_STRIKES;
  const me = parseInt(url.searchParams.get("expiries") ?? "", 10);
  const maxExpiries = Number.isFinite(me) && me > 0 ? me : 0;

  const cold = ensureFeeds();
  if (cold) await warmup(WARMUP_MS);

  return respondJson(req, buildSnapshot(strikeWindow, maxExpiries));
}

// ── Response helpers (gzip-aware, CORS open — jaisa main.ts mein tha) ──────
async function respondText(
  req: Request, text: string, status = 200, contentType = "application/json",
): Promise<Response> {
  const acceptsGzip = /\bgzip\b/i.test(req.headers.get("accept-encoding") ?? "");
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  if (acceptsGzip && text.length > 512) {
    const bytes = new TextEncoder().encode(text);
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const compressed = await new Response(cs.readable).arrayBuffer();
    headers["Content-Encoding"] = "gzip";
    return new Response(compressed, { status, headers });
  }
  return new Response(text, { status, headers });
}

function respondJson(req: Request, obj: unknown, status = 200): Promise<Response> {
  return respondText(req, JSON.stringify(obj), status, "application/json");
}

// ── HTTP entrypoint ──────────────────────────────────────────────────────
async function handleHttp(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return respondJson(req, {
        ok: true,
        mode: "websocket-only",
        feeds_running: !feedsStopped,
        symbols: quotes.size,
        spot: spot.price,
        feeds: { mark: feeds.mark.status(nowMs()), trade: feeds.trade.status(nowMs()), spot: feeds.spot.status(nowMs()) },
      });
    }

    if (url.pathname === "/snapshot") {
      return await handleSnapshot(req, url);
    }

    return new Response("Not found — /snapshot ya / use karo", { status: 404 });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Proxy failed: ${err}` }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

Deno.serve({ port: PORT }, handleHttp);
