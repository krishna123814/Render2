// render.ts — ORDER-BOOK-ONLY WebSocket proxy (Render2, alag Render account/IP par deploy)
//
// PURPOSE: Isme SIRF ek kaam hai — BTC option order-book (Market Depth) ka
// live WebSocket relay. Kuch aur nahi (na mark/trade/spot snapshot feeds,
// na REST-forward, na trade/order placement) — jaanbujhkar minimal rakha
// hai, kyunki is deployment ka ek-matra role sirf depth WS hai, baaki sab
// (option-chain snapshot, REST forward, trade module) purane engine
// (main.ts) se hi chalta rahega.
//
// Client: wss://<is-service-ka-URL>/ws/depth?symbol=BTC-260926-84000-C
//
// Andar kya hota hai (Binance ka official local-order-book algorithm):
//   1. Client connect hote hi is symbol ke liye Binance eoptions diff-depth
//      WS stream (nbstream.binance.com) khulta hai (on-demand, per-symbol).
//   2. Saath hi ek REST snapshot (/eapi/v1/depth) liya jaata hai — sirf
//      order-book bootstrap ke liye zaroori, koi doosra REST use nahi hai.
//   3. Snapshot + diff events merge karke accurate book (bids/asks) memory
//      mein maintain hoti hai.
//   4. Connected browsers ko har DEPTH_PUSH_MS mein ek baar top-N rows
//      push hoti hain (bandwidth-saver — upstream book real-time hai,
//      push throttled hai).
//   5. Jab last client hat jaaye, DEPTH_IDLE_STOP_MS baad upstream feed
//      khud band ho jaati hai (memory/Binance-load free).
//
// Env vars (sab optional):
//   PORT   (Render khud deta hai)

// ── Config ────────────────────────────────────────────────────────────────
const PORT = Number(Deno.env.get("PORT") ?? 8000);
const EAPI = "https://eapi.binance.com";

const nowMs = () => Date.now();

// ── Binance ban/rate-limit tracking (dashboard ke liye — main.ts jaisa) ────
// Is service ka Binance ko ek hi REST call hai: depth-snapshot bootstrap
// (loadSnapshot() neeche). Wahi call agar 429 (rate-limit) ya 418 (IP ban)
// khaaye, to yahan capture hota hai — taaki dashboard (/ ya /health) par
// saaf dikhe "Binance ban/limit-cross ho raha hai", jaisa main.ts karta hai.
interface LimitEvent {
  captured_at_ms: number;
  endpoint: string;
  status: number;
  retry_after_sec: number | null;
  binance_code: number | null;
  binance_msg: string | null;
}
let bnIpBanned = false;
let bnIpBanSince = 0;
let lastLimitEvent: LimitEvent | null = null;

// 429/418 milte hi: (a) ban-flag set/clear, (b) exact error (code/msg/
// retry-after) capture karta hai lastLimitEvent mein — dashboard isi ko
// padhta hai.
function noteBnLimitEvent(endpoint: string, resp: Response, bodyText: string): void {
  const ra = parseInt(resp.headers.get("retry-after") ?? "", 10);
  const retryAfterSec = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 1800) : null;

  let binanceCode: number | null = null;
  let binanceMsg: string | null = null;
  try {
    const j = JSON.parse(bodyText);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      if (Number.isFinite(Number(j.code))) binanceCode = Number(j.code);
      if (typeof j.msg === "string") binanceMsg = j.msg.slice(0, 300);
    }
  } catch { /* body JSON nahi tha — koi baat nahi, status/headers to mil gaye */ }

  lastLimitEvent = {
    captured_at_ms: nowMs(), endpoint, status: resp.status,
    retry_after_sec: retryAfterSec, binance_code: binanceCode, binance_msg: binanceMsg,
  };

  if (resp.status === 418) {
    if (!bnIpBanned) { bnIpBanned = true; bnIpBanSince = nowMs(); }
  }
  console.log(
    `[limit-event] ${endpoint} HTTP ${resp.status} — code:${binanceCode} msg:"${binanceMsg}" ` +
    `retry-after:${retryAfterSec ?? "n/a"}s`,
  );
}
function noteBnOk(): void {
  bnIpBanned = false;   // koi bhi successful Binance call ban-flag clear kar sakti hai
}
function lastLimitEventReport(): (LimitEvent & { age_ms: number }) | null {
  if (!lastLimitEvent) return null;
  return { ...lastLimitEvent, age_ms: nowMs() - lastLimitEvent.captured_at_ms };
}

// ── Depth order-book relay (per-symbol, snapshot+diff, 3s throttle push) ──
interface DepthRow { price: number; volume: number; ord: number }
const DEPTH_PUSH_MS = 3000;          // browser ko push karne ka interval (bandwidth-saver)
const DEPTH_IDLE_STOP_MS = 15_000;   // itni der koi client na ho to upstream feed band
const DEPTH_LEVELS = 10;             // top-N levels har side (bids/asks)

function depthApplySide(map: Map<string, number>, rows: [string, string][] | undefined) {
  for (const row of rows || []) {
    const price = String(parseFloat(row[0]));
    const qty = parseFloat(row[1]);
    if (!qty) map.delete(price); else map.set(price, qty);
  }
}

class DepthBook {
  clients = new Set<WebSocket>();
  ws: WebSocket | null = null;
  bidsMap = new Map<string, number>();
  asksMap = new Map<string, number>();
  lastU: number | null = null;
  snapshotId = 0;
  // deno-lint-ignore no-explicit-any
  buffer: any[] = [];
  snapshotReady = false;
  connecting = false;
  // deno-lint-ignore no-explicit-any
  pushTimer: any = null;
  // deno-lint-ignore no-explicit-any
  idleTimer: any = null;
  // deno-lint-ignore no-explicit-any
  retryTimer: any = null;
  failCount = 0;
  lastUpdateTs = 0;
  status: "idle" | "connecting" | "live" | "error" = "idle";
  lastError: string | null = null;

  constructor(public symbol: string) {}

  addClient(ws: WebSocket) {
    this.clients.add(ws);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.ws && !this.connecting) this.start();
    if (!this.pushTimer) this.pushTimer = setInterval(() => this.pushToClients(), DEPTH_PUSH_MS);
  }
  removeClient(ws: WebSocket) {
    this.clients.delete(ws);
    if (this.clients.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.stop(), DEPTH_IDLE_STOP_MS);
    }
  }
  start() {
    this.connecting = true;
    this.status = "connecting";
    this.loadSnapshot().then(() => this.connectUpstream());
  }
  stop() {
    if (this.pushTimer) { clearInterval(this.pushTimer); this.pushTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.connecting = false;
    this.status = "idle";
    this.snapshotReady = false;
    this.bidsMap.clear(); this.asksMap.clear();
    this.lastU = null; this.buffer = [];
    depthBooks.delete(this.symbol);
  }
  async loadSnapshot() {
    try {
      const r = await fetch(
        `${EAPI}/eapi/v1/depth?symbol=${encodeURIComponent(this.symbol)}&limit=20`,
        { signal: AbortSignal.timeout(8000) },
      );
      const bodyText = await r.text();
      if (r.status === 429 || r.status === 418) noteBnLimitEvent("/eapi/v1/depth", r, bodyText);
      else if (r.ok) noteBnOk();
      // deno-lint-ignore no-explicit-any
      let d: any = null;
      try { d = JSON.parse(bodyText); } catch { /* ignore parse fail below */ }
      if (!r.ok || !d || (!d.bids && !d.asks)) {
        this.lastError = r.status === 418
          ? `Binance IP-ban (418) — order-book paused, auto-retry hoga`
          : r.status === 429
          ? `Binance rate-limit (429) — order-book paused, auto-retry hoga`
          : `Snapshot fail — HTTP ${r.status}`;
        this.status = "error";
        this.retryTimer = setTimeout(() => this.loadSnapshot().then(() => this.connectUpstream()), 3000);
        return;
      }
      this.bidsMap = new Map(); this.asksMap = new Map();
      depthApplySide(this.bidsMap, d.bids);
      depthApplySide(this.asksMap, d.asks);
      this.snapshotId = d.lastUpdateId || 0;
      this.lastU = null;
      const buffered = this.buffer; this.buffer = [];
      this.snapshotReady = true;
      this.lastUpdateTs = nowMs();
      for (const ev of buffered) this.applyEvent(ev);
    } catch (e) {
      this.lastError = `Snapshot error: ${e}`;
      this.status = "error";
      this.retryTimer = setTimeout(() => this.loadSnapshot().then(() => this.connectUpstream()), 3000);
    }
  }
  connectUpstream() {
    this.connecting = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`wss://nbstream.binance.com/eoptions/ws/${this.symbol}@depth@100ms`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.status = "live";
      this.failCount = 0;
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      // deno-lint-ignore no-explicit-any
      let ev: any;
      try { ev = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      const d = ev && ev.data ? ev.data : ev;
      if (!d || d.u == null) return;
      if (!this.snapshotReady) { this.buffer.push(d); return; }
      this.applyEvent(d);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status = "error";
      this.scheduleRetry();
    };
  }
  // deno-lint-ignore no-explicit-any
  applyEvent(ev: any) {
    if (this.lastU == null) {
      if (ev.u < this.snapshotId + 1) return;                 // purana, ignore
      if (ev.U > this.snapshotId + 1) {
        // Gap — khud REST se resync kar leta hai.
        this.snapshotReady = false;
        this.loadSnapshot();
        return;
      }
    } else if (ev.u <= this.lastU) {
      return;                                                  // purana/duplicate
    } else if (ev.U > this.lastU + 1) {
      this.snapshotReady = false;
      this.loadSnapshot();
      return;
    }
    depthApplySide(this.bidsMap, ev.b);
    depthApplySide(this.asksMap, ev.a);
    this.lastU = ev.u;
    this.lastUpdateTs = nowMs();
  }
  scheduleRetry() {
    this.failCount++;
    const delay = Math.min(1000 * 2 ** (this.failCount - 1), 15000);
    this.retryTimer = setTimeout(() => this.connectUpstream(), delay);
  }
  topRows(map: Map<string, number>, desc: boolean): DepthRow[] {
    const arr: DepthRow[] = [];
    map.forEach((qty, price) => arr.push({ price: parseFloat(price), volume: qty, ord: 0 }));
    arr.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
    return arr.slice(0, DEPTH_LEVELS);
  }
  pushToClients() {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({
      symbol: this.symbol,
      bids: this.topRows(this.bidsMap, true),
      asks: this.topRows(this.asksMap, false),
      status: this.status,
      // Frontend dropdown ke liye — status "error" ho to error text bhi
      // saath bhejte hain (jaise "Binance IP-ban (418)..."), taaki app-side
      // Order Book dropdown me exact wajah dikhe, sirf "live" na dikhe.
      error: this.status === "error" ? this.lastError : null,
      ip_banned: bnIpBanned,
      ts: nowMs(),
    });
    for (const c of this.clients) {
      try { c.send(payload); } catch { /* client gone — onclose cleans up */ }
    }
  }
}

const depthBooks = new Map<string, DepthBook>();
function getOrCreateDepthBook(symbol: string): DepthBook {
  let b = depthBooks.get(symbol);
  if (!b) { b = new DepthBook(symbol); depthBooks.set(symbol, b); }
  return b;
}

// ── HTTP entrypoint ──────────────────────────────────────────────────────
function handleHttp(req: Request): Response {
  try {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      const t = nowMs();
      return new Response(JSON.stringify({
        ok: true,
        mode: "orderbook-ws-only",
        // Binance ban/rate-limit cross ho raha hai to yahan turant dikhega.
        ip_banned: bnIpBanned,
        ip_ban_age_ms: bnIpBanned ? (t - bnIpBanSince) : null,
        last_limit_event: lastLimitEventReport(),
        depth_books: [...depthBooks.entries()].map(([sym, b]) => ({
          symbol: sym,
          status: b.status,
          clients: b.clients.size,
          age_ms: b.lastUpdateTs ? t - b.lastUpdateTs : null,
          last_error: b.lastError,
        })),
      }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    if (url.pathname === "/ws/depth") {
      const symbol = url.searchParams.get("symbol");
      if (!symbol) return new Response("symbol query param required", { status: 400 });
      if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return new Response("Expected websocket upgrade", { status: 400 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      const book = getOrCreateDepthBook(symbol);
      socket.onopen = () => book.addClient(socket);
      socket.onclose = () => book.removeClient(socket);
      socket.onerror = () => book.removeClient(socket);
      return response;
    }

    return new Response("Not found — /ws/depth?symbol=... use karo", { status: 404 });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Proxy failed: ${err}` }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

Deno.serve({ port: PORT }, handleHttp);
